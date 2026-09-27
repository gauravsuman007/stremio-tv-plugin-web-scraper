/**
 * Byse (the file host formerly called Filemoon; embeds live on rotating
 * domains such as mfw09.org and bysezejataos.com), spoken without a browser.
 * arc018 / BFLIX and Filmo embed it. Worked out from the embed page's own
 * bundles (STRATEGIES.md, "Byse" section, has the recipe and how it was found);
 * nothing from the site is executed.
 *
 * One resolve is five requests on the embed's own host:
 *   1. POST /api/videos/access/challenge            -> {challenge_id, nonce}
 *   2. POST /api/videos/access/attest               -> fingerprint token (we sign
 *      the nonce with a fresh ECDSA P-256 key and send a plausible desktop Chrome
 *      profile; the server only scores it, 0.55 is enough)
 *   3. POST /api/videos/<code>/embed/captcha        -> a proof-of-work item
 *   4. POST /api/videos/<code>/embed/captcha/verify -> captcha token (after solving 3)
 *   5. POST /api/videos/<code>/embed/playback       -> AES-256-GCM sealed sources
 * The playback key is two of the 30 `key_parts` the answer itself carries,
 * picked by its `version`. Stream URLs are bound to the caller's ASN (`asn=`),
 * so resolve on the machine that will play.
 */
import { createDecipheriv, randomBytes, webcrypto } from "node:crypto";
import type { ScraperContext } from "./shared.mts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
/** Give up on a proof of work that takes longer than this (difficulty 16 is ~65k hashes, 1-3 s). */
const POW_BUDGET_MS = 20_000;

export interface ByseSource {
    url: string;
    /** The host's own label, e.g. "1080p" (it is not always the real height). */
    label?: string;
    /** Referer to play it with: the embed host. */
    referrer: string;
}

/** Byse's embed code from any of its URL shapes: /e/<code>, /d/<code>, /v/<code>. */
export function byseEmbed(link: string): { origin: string; code: string } | null {
    try {
        const url = new URL(link);
        const code = /^\/[edv]\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
        return code ? { origin: url.origin, code } : null;
    } catch {
        return null;
    }
}

/* ---- the proof of work ------------------------------------------------ */
// A 512-word memory-hard mix of ChaCha quarter rounds (the page's `pow-*.js`);
// a solution is the first counter whose hash of `<nonce>:<counter>` has
// `difficulty` leading zero bits.

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

function quarter(s: Uint32Array): void {
    s[0] = (s[0]! + s[1]!) >>> 0; s[3] = rotl(s[3]! ^ s[0]!, 16);
    s[2] = (s[2]! + s[3]!) >>> 0; s[1] = rotl(s[1]! ^ s[2]!, 12);
    s[0] = (s[0]! + s[1]!) >>> 0; s[3] = rotl(s[3]! ^ s[0]!, 8);
    s[2] = (s[2]! + s[3]!) >>> 0; s[1] = rotl(s[1]! ^ s[2]!, 7);
}

const WORDS = 512;
const MASK = WORDS - 1;

function powHash(bytes: Uint8Array): Uint32Array {
    const s = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
    for (const byte of bytes) { s[0] = rotl((s[0]! + byte) >>> 0, 7); quarter(s); }
    for (let i = 0; i < 8; i++) quarter(s);
    const mem = new Uint32Array(WORDS);
    for (let i = 0; i < WORDS; i++) { quarter(s); mem[i] = (s[0]! ^ s[2]!) >>> 0; }
    for (let round = 0; round < 2; round++) {
        for (let i = 0; i < WORDS; i++) {
            let c = rotl((mem[i]! + mem[mem[i]! & MASK]!) >>> 0, 13);
            c = (c ^ (Math.imul(mem[(i + 1) & MASK]!, 2654435761) >>> 0)) >>> 0;
            mem[i] = c; s[0] = (s[0]! ^ c) >>> 0; quarter(s);
        }
    }
    const out = new Uint32Array(8);
    const lane = WORDS / 8;
    for (let i = 0; i < 8; i++) {
        quarter(s);
        let acc = s[0]!;
        for (let j = 0; j < lane; j++) {
            const d = mem[i * lane + j]!;
            acc = rotl((acc + d) >>> 0, 5);
            acc = (acc ^ (Math.imul(d, 2246822519) >>> 0)) >>> 0;
        }
        out[i] = (acc ^ s[2]!) >>> 0;
    }
    return out;
}

function leadingZeroBits(words: Uint32Array): number {
    let bits = 0;
    for (const word of words) {
        if (word === 0) { bits += 32; continue; }
        return bits + Math.clz32(word);
    }
    return bits;
}

async function solvePow(nonce: string, difficulty: number): Promise<string | null> {
    const started = Date.now();
    for (let counter = 0; ; counter++) {
        if (leadingZeroBits(powHash(Buffer.from(`${nonce}:${counter}`, "latin1"))) >= difficulty) return String(counter);
        // Yield now and then so a long solve doesn't starve the other scrapers.
        if (counter % 2048 === 2047) {
            if (Date.now() - started > POW_BUDGET_MS) return null;
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
}

/* ---- the protocol ------------------------------------------------------ */

const hash32 = () => randomBytes(32).toString("base64url");

/** What the attest endpoint wants to know about the browser. Scored, not verified. */
function clientProfile() {
    const version = "140.0.7339.133";
    return {
        user_agent: UA, architecture: "x86", bitness: "64", platform: "macOS", platform_version: "10_15_7", model: "",
        ua_full_version: version,
        brand_full_versions: [{ brand: "Chromium", version }, { brand: "Not=A?Brand", version: "24.0.0.0" }, { brand: "Google Chrome", version }],
        pixel_ratio: 2, screen_width: 1512, screen_height: 982, color_depth: 30, languages: ["en-US", "en"], timezone: "Europe/Berlin",
        hardware_concurrency: 8, device_memory: 8, touch_points: 0,
        webgl_vendor: "Google Inc. (Apple)", webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
        canvas_hash: hash32(), audio_hash: hash32(), webgl_params_hash: hash32(), fonts_hash: hash32(), codecs_hash: hash32(),
        media_devices: "ai1ao1vi1", pointer_type: "fine,hover", extra: { vendor: "Google Inc.", appVersion: UA.slice("Mozilla/".length) }
    };
}

interface Sealed { iv: string; payload: string; key_parts: string[]; version: string | number }

interface Playback { sources?: { url?: string; label?: string; mime_type?: string }[] }

function openPlayback(sealed: Sealed): Playback {
    // Version n picks parts n and 31-n (1-based); anything else means every part, concatenated.
    const version = Number(sealed.version);
    const picked = version >= 1 && version <= 20 && 31 - version <= sealed.key_parts.length
        ? [sealed.key_parts[version - 1]!, sealed.key_parts[31 - version - 1]!]
        : sealed.key_parts;
    const key = Buffer.concat(picked.map((part) => Buffer.from(part, "base64url")));
    const data = Buffer.from(sealed.payload, "base64url");
    const decipher = createDecipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8")) as Playback;
}

/**
 * The HLS sources of one Byse video, or `[]` when any step is refused.
 * `embedReferer` is the page that iframes the player (the host checks it
 * against the video's allowed embed domains).
 */
export async function resolveByse(embedLink: string, embedReferer: string, ctx: ScraperContext): Promise<ByseSource[]> {
    const embed = byseEmbed(embedLink);
    if (!embed) return [];
    const { origin, code } = embed;
    const headers: Record<string, string> = {
        "User-Agent": UA, Referer: embedReferer, Origin: origin, "Content-Type": "application/json",
        "X-Embed-Origin": new URL(embedReferer).host, "X-Embed-Parent": `${origin}/e/${code}`, "X-Embed-Referer": embedReferer
    };
    const post = async <T,>(path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T | null> => {
        const response = await ctx.fetch(`${origin}/api/videos/${path}`, {
            method: "POST", headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (!response.ok) return null;
        try { return (await response.json()) as T; } catch { return null; }
    };

    const challenge = await post<{ challenge_id?: string; nonce?: string }>("access/challenge");
    if (!challenge?.challenge_id || !challenge.nonce) return [];
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, Buffer.from(challenge.nonce))).toString("base64url");
    const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const attest = await post<{ token?: string; viewer_id?: string; device_id?: string; confidence?: number }>("access/attest", {
        viewer_id: "", device_id: "", challenge_id: challenge.challenge_id, nonce: challenge.nonce, signature,
        public_key: { crv: jwk.crv, ext: true, key_ops: ["verify"], kty: jwk.kty, x: jwk.x, y: jwk.y },
        client: clientProfile(), storage: {}, attributes: { entropy: "high" }
    });
    if (!attest?.token) return [];
    const fingerprint = { token: attest.token, viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence };
    headers.Cookie = `byse_viewer_id=${attest.viewer_id}; byse_device_id=${attest.device_id}`;

    const pow = await post<{ pow_nonce?: string; pow_difficulty?: number; pow_token?: string }>(`${code}/embed/captcha`, { fingerprint });
    if (!pow?.pow_nonce || !pow.pow_token) return [];
    const solution = await solvePow(pow.pow_nonce, pow.pow_difficulty ?? 16);
    if (solution === null) return [];
    const verified = await post<{ token?: string }>(`${code}/embed/captcha/verify`, { pow_token: pow.pow_token, solution, fingerprint });
    if (!verified?.token) return [];

    const answer = await post<{ playback?: Sealed }>(`${code}/embed/playback`, { fingerprint }, { "X-Captcha-Token": verified.token });
    if (!answer?.playback?.key_parts?.length) return [];
    let playback: Playback;
    try { playback = openPlayback(answer.playback); } catch { return []; }
    return (playback.sources ?? [])
        .filter((source) => source.url && (source.mime_type?.includes("mpegurl") || /\.m3u8(\?|$)/.test(source.url)))
        .map((source) => ({ url: source.url!, label: source.label, referrer: `${origin}/` }));
}
