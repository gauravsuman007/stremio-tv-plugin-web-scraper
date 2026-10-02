import { randomBytes, webcrypto } from "node:crypto";
import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * cinejoy.pk -- the original site. Its player asks `api.wing.st/g` for a
 * server's stream with a request sealed by `api.wing.st/crush.wasm`; this does
 * the same from Node instead of driving the page (it used to; see
 * ./archive/cinejoy-browser.mts). 1-2 s a server.
 *
 * crush.wasm is a zero-import Rust module (P-256 ECDH + HKDF + AES-GCM,
 * "lumen-gate-v2"). It is run as a black box: `seal_request(json, rand44,
 * out)` writes a 32-byte response key, 66 bytes we don't need, then the exact
 * POST body. The answer is `iv(12) || AES-GCM(key, aad = "lumen-gate-v2\0" ||
 * body[0..67])` around `{"data":{"stream":[{"type":"hls","playlist":...}]}}`.
 * How this was found is in STRATEGIES.md.
 *
 * Nebula serves nebula.bright67.online (the same files as ShuttleTV's Nebula),
 * Lisbon the lit.cheaptruckrepairs.cc CDN (up to 4K; Rivestream's source too),
 * Solara cheaptruckrepairs.cc (which 403s without the Referer), Athens often
 * nothing. A Referer of cinejoy.pk/ is all any of them needs.
 */
const BASE_URL = "https://cinejoy.pk";
const API = "https://api.wing.st";
const TIMEOUT_MS = 15_000;
const RESPONSE_AAD = new TextEncoder().encode("lumen-gate-v2\0");

interface CinejoyServer {
    name: string;
    status: string;
    /** Site-wide capability flag, not per title; only used to order servers. */
    "4k": boolean;
}

interface CrushExports {
    memory: WebAssembly.Memory;
    alloc(len: number): number;
    dealloc(ptr: number, len: number): void;
    seal_request(json: number, jsonLen: number, rand: number, randLen: number, out: number, outLen: number): number;
}

let crushModule: Promise<WebAssembly.Module> | undefined;

async function crush(fetchImpl: ScraperContext["fetch"]): Promise<CrushExports> {
    crushModule ??= fetchImpl(`${API}/crush.wasm`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then((r) => {
            if (!r.ok) throw new Error(`crush.wasm ${r.status}`);
            return r.arrayBuffer();
        })
        .then(async (bytes) => {
            const module = await WebAssembly.compile(bytes);
            // Pure computation only: refuse a build that wants anything from us.
            if (WebAssembly.Module.imports(module).length) throw new Error("crush.wasm now has imports");
            return module;
        });
    const module = await crushModule.catch((err) => {
        crushModule = undefined;
        throw err;
    });
    return (await WebAssembly.instantiate(module, {})).exports as unknown as CrushExports;
}

async function listServers(fetchImpl: ScraperContext["fetch"]): Promise<CinejoyServer[]> {
    const response = await fetchImpl(`${API}/servers`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to list servers: ${response.status}`);
    const data = (await response.json()) as { servers: CinejoyServer[] };
    return data.servers;
}

/** One sealed `/g` round trip; the decrypted JSON, or null if the server has nothing. */
async function askServer(fetchImpl: ScraperContext["fetch"], path: string, payload: Record<string, string>): Promise<string[]> {
    const wasm = await crush(fetchImpl);
    const json = new TextEncoder().encode(JSON.stringify({ path, payload }));
    const rand = randomBytes(44);
    const outLen = 616 + json.length;
    const pJson = wasm.alloc(json.length), pRand = wasm.alloc(rand.length), pOut = wasm.alloc(outLen);
    let sealed: Uint8Array;
    try {
        new Uint8Array(wasm.memory.buffer).set(json, pJson);
        new Uint8Array(wasm.memory.buffer).set(rand, pRand);
        const written = wasm.seal_request(pJson, json.length, pRand, rand.length, pOut, outLen);
        if (written <= 98) throw new Error(`seal_request returned ${written}`);
        sealed = new Uint8Array(wasm.memory.buffer).slice(pOut, pOut + written);
    } finally {
        wasm.dealloc(pJson, json.length);
        wasm.dealloc(pRand, rand.length);
        wasm.dealloc(pOut, outLen);
    }
    const key = sealed.subarray(0, 32), body = new Uint8Array(sealed.subarray(98));

    const response = await fetchImpl(`${API}/g`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: BASE_URL, Referer: `${BASE_URL}/` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return [];
    const answer = new Uint8Array(await response.arrayBuffer());

    const aad = new Uint8Array(RESPONSE_AAD.length + 67);
    aad.set(RESPONSE_AAD);
    aad.set(body.subarray(0, 67), RESPONSE_AAD.length);
    const aesKey = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: answer.subarray(0, 12), additionalData: aad }, aesKey, answer.subarray(12));
    const data = JSON.parse(new TextDecoder().decode(plain)) as { data?: { stream?: { type?: string; playlist?: string }[] } };
    return (data.data?.stream ?? []).filter((s) => s.playlist && (!s.type || s.type === "hls")).map((s) => s.playlist!);
}

/**
 * A playlist that lists segments proves nothing about the segments being
 * there: Lisbon's CDN answers 502 "origin unavailable" for any segment it
 * has not cached, so a title's 4K (sometimes 720p/360p) variant can list 746
 * segments and serve two. hls.js starts on a low rung, ABR climbs to the dead
 * one and playback dies. So every rung's first, middle and last segment is
 * asked for (one byte) and a link with any dead rung is dropped.
 */
async function playsThrough(fetchImpl: ScraperContext["fetch"], mediaUrl: string): Promise<boolean> {
    const headers = { Referer: `${BASE_URL}/` };
    const text = async (url: string) => {
        const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
    };
    const uris = (playlist: string) => playlist.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    try {
        const master = await text(mediaUrl);
        const rungs = master.includes("#EXT-X-STREAM-INF") ? uris(master).map((u) => new URL(u, mediaUrl).href) : [mediaUrl];
        const checks = await Promise.all(rungs.map(async (rung) => {
            const segments = uris(rung === mediaUrl ? master : await text(rung));
            if (!segments.length) return false;
            const picks = [...new Set([0, segments.length >> 1, segments.length - 1])];
            const oks = await Promise.all(picks.map(async (i) => {
                const r = await fetchImpl(new URL(segments[i]!, rung).href, { headers: { ...headers, Range: "bytes=0-0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
                await r.arrayBuffer().catch(() => undefined);
                return r.ok;
            }));
            return oks.every(Boolean);
        }));
        return checks.every(Boolean);
    } catch {
        return false;
    }
}

/**
 * Tries every up server, 4k-flagged ones first. The flag is site-wide, not
 * per title (a 4k-flagged mirror has served the same 1080p as a plain one),
 * but asking it first costs nothing: the caller compares what plays and stops
 * early on 2160p.
 */
const cinejoySite: HttpSite = {
    id: "cinejoy",
    name: "CineJoy",
    referrer: `${BASE_URL}/`,
    maxQuality: "4K",
    async available(ctx) {
        return (await listServers(ctx.fetch)).some((s) => s.status === "ok");
    },
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const servers = (await listServers(ctx.fetch))
            .filter((s) => s.status === "ok")
            .sort((a, b) => Number(b["4k"]) - Number(a["4k"]));

        const payload: Record<string, string> = { tmdb: String(match.tmdbId), title: match.title };
        if (match.year) payload.year = String(match.year);
        if (match.mediaType === "tv") Object.assign(payload, { season: String(season ?? 1), episode: String(episode ?? 1) });
        const kind = match.mediaType === "movie" ? "movie" : "series";

        for (const server of servers) {
            const playlists = await askServer(ctx.fetch, `/${server.name}/${kind}`, payload).catch(() => []);
            for (const mediaUrl of playlists) {
                if (await playsThrough(ctx.fetch, mediaUrl)) yield { mediaUrl, label: server.name };
            }
        }
    }
};

export default createScraper(cinejoySite);
