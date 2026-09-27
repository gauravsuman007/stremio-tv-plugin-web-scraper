import { webcrypto } from "node:crypto";
import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * atlantic.st -- its player asks stream.hls.lol/helios for a list of servers
 * whose URLs are AES-GCM encrypted (`ns_` + hex(iv[12] || ciphertext || tag))
 * with a key that ships in the player's bundle. Plain HTTP, no browser.
 * Recipe and measurements: STRATEGIES.md.
 *
 * The media proxy (peraspera...workers.dev) answers 302 without Referer and
 * Origin, so both are declared (`headers`; needs web-links >= 0.9.0). Its
 * `headers` query param is an encrypted blob the proxy applies upstream, so
 * the URL must be passed on untouched.
 */
const SITE = "https://atlantic.st/";
const API = "https://stream.hls.lol/helios";
const KEY_HEX = "e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5";
const PREFIX = "ns_";
const API_TIMEOUT_MS = 20_000;
const IV_BYTES = 12;

let aesKey: Promise<CryptoKey> | undefined;

async function decrypt(value: string): Promise<string> {
    if (!value.startsWith(PREFIX)) return value; // plaintext
    aesKey ??= webcrypto.subtle.importKey("raw", Buffer.from(KEY_HEX, "hex"), "AES-GCM", false, ["decrypt"]);
    const bytes = Buffer.from(value.slice(PREFIX.length), "hex");
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) }, await aesKey, bytes.subarray(IV_BYTES));
    return Buffer.from(plain).toString("utf8");
}

const atlanticSite: HttpSite = {
    id: "atlantic",
    name: "Atlantic",
    referrer: SITE,
    headers: { Origin: SITE.slice(0, -1) },
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const query = match.mediaType === "movie"
            ? `tmdbId=${match.tmdbId}&type=movie`
            : `tmdbId=${match.tmdbId}&type=tv&seasonId=${season ?? 1}&episodeId=${episode ?? 1}`;

        const response = await ctx.fetch(`${API}?${query}`, { headers: { Referer: SITE, Origin: SITE.slice(0, -1) }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        if (!response.ok) return;

        const body = (await response.json()) as { sources?: Record<string, { url?: string | null; type?: string; label?: string } | null> };
        for (const [name, entry] of Object.entries(body.sources ?? {})) {
            if (!entry?.url || (entry.type && entry.type !== "hls")) continue;
            try {
                yield { mediaUrl: await decrypt(entry.url), label: name };
            } catch {
                continue; // undecryptable (key rotated): skip this server.
            }
        }
    }
};

export default createScraper(atlanticSite);
