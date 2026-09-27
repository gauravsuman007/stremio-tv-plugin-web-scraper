import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * movy.sx -- its player asks `api.wecollege.net/<city>/sources` (16 "cities",
 * each a different upstream) with `enc=2` and a short-lived seed from
 * `/seed?mediaId=<tmdb>`. This makes the same calls from Node (it used to click
 * through the page; see ./archive/movy-browser.mts). Providers are asked in parallel.
 *
 * The answer is base64url, XORed with a keystream the page's own JS derives
 * from the seed and the tmdb id (a 61-word state mixed with FNV-1a and the
 * murmur3 finaliser -- `keystream` below is a straight port), and starts with
 * the magic `mvm1`. One seed serves every provider for its 30 s TTL; fetching a
 * fresh one per call trips a burst limit (`STREAMCRYPTO_SEED_INVALID`).
 *
 * miami/boise play off `moon.quietridge.top` as single-rendition playlists
 * named for their resolution (`index-s1080p-...`); atlanta off a Workers
 * proxy, paris off vidzy (a master). All need only the Referer.
 */
const BASE_URL = "https://www.movy.sx";
const API = "https://api.wecollege.net";
const TIMEOUT_MS = 15_000;
/** Verified to answer with playable HLS, best first; the rest failed or 401'd when probed (2026-09-27). */
const PROVIDERS = ["miami", "boise", "atlanta", "paris"];

const MAGIC = [0x6d, 0x76, 0x6d, 0x31];
const GOLDEN = 0x9e3779b9;

function fmix(h: number): number {
    h >>>= 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

function rotl(x: number, n: number): number {
    x >>>= 0;
    n &= 31;
    return n === 0 ? x : ((x << n) | (x >>> (32 - n))) >>> 0;
}

function keystream(seed: string, mediaId: number, length: number): Uint8Array {
    let fnv = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) fnv = Math.imul(fnv ^ seed.charCodeAt(i), 0x1000193) >>> 0;
    let n = fmix(fmix(fnv) ^ fmix((mediaId >>> 0) ^ GOLDEN)) >>> 0;
    // Sparse on purpose: the page tests `slot in state`, and unset slots count.
    const state: number[] = new Array(61);
    for (let i = 0; i < 8; i++) {
        const slot = n % 61;
        n = rotl((n + GOLDEN) >>> 0, 7 + (7 & i));
        state[slot] = (n ^ fmix(n)) >>> 0;
        n = fmix((n + slot) >>> 0);
    }
    let acc = fmix(0xa5a5a5a5 ^ n) >>> 0;
    const out = new Uint8Array(length);
    for (let pos = 0, step = 0; pos < length; step++) {
        const slot = acc % 61;
        const mask = slot in state ? -1 : 0;
        const s = ((state[slot]! >>> 0) ^ (Math.imul(GOLDEN, step + 1) >>> 0)) >>> 0;
        let b = (((acc ^ s) >>> 0) | ((acc & s & mask) >>> 0)) >>> 0;
        b = (rotl((b + acc) >>> 0, 31 & slot) ^ rotl(acc, 31 & Math.imul(slot, 7))) >>> 0;
        acc = fmix((b + GOLDEN) >>> 0);
        state[slot] = acc;
        for (let k = 0; k < 4 && pos < length; k++) out[pos++] = (acc >>> (8 * k)) & 255;
    }
    return out;
}

function decrypt(body: string, seed: string, mediaId: number): string {
    const data = Buffer.from(body.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const stream = keystream(seed, mediaId, data.length);
    for (let i = 0; i < data.length; i++) data[i]! ^= stream[i]!;
    if (MAGIC.some((byte, i) => data[i] !== byte)) throw new Error("movy: bad seed");
    return data.subarray(MAGIC.length).toString("utf8");
}

const headers = { Origin: BASE_URL, Referer: `${BASE_URL}/` };

async function getSeed(fetchImpl: ScraperContext["fetch"], mediaId: number): Promise<string> {
    const response = await fetchImpl(`${API}/seed?mediaId=${mediaId}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`movy seed ${response.status}`);
    return ((await response.json()) as { seed: string }).seed;
}

const movySite: HttpSite = {
    id: "movy",
    name: "Movy",
    referrer: `${BASE_URL}/`,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        // One seed, every provider asked at once (4 calls on one seed is what the page does; 16 seeds is not).
        const seed = await getSeed(ctx.fetch, match.tmdbId);
        const answers = PROVIDERS.map((provider) => {
            const params = new URLSearchParams({
                title: encodeURIComponent(match.title),
                mediaType: match.mediaType,
                ...(match.year ? { year: String(match.year) } : {}),
                episodeId: String(episode ?? 1),
                seasonId: String(season ?? 1),
                tmdbId: String(match.tmdbId),
                enc: "2",
                seed
            });
            return ctx
                .fetch(`${API}/${provider}/sources?${params}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
                .then(async (r) => (r.ok ? (JSON.parse(decrypt(await r.text(), seed, match.tmdbId)) as { sources?: { url?: string }[] }).sources : undefined))
                .catch(() => undefined);
        });

        for (const [i, answer] of answers.entries()) {
            // Several per-quality playlists, highest first: the first that plays is the one to keep.
            const mediaUrl = (await answer)?.find((s) => s.url)?.url;
            if (mediaUrl) yield { mediaUrl, label: PROVIDERS[i] };
        }
    }
};

export default createScraper(movySite);
