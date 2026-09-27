import { webcrypto } from "node:crypto";
import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * vidrock.net -- its player asks a JSON API for a list of servers whose URLs
 * are AES-GCM encrypted with a key that ships in the player's own bundle, so
 * no browser is needed: fetch, decrypt, done. Recipe and measurements:
 * STRATEGIES.md.
 *
 * Two servers are used:
 *   Orion -- 1080/720/360 master
 *   Luna  -- 640x266 / 1280x534 / 1920x800 master
 * `Atlas` is left out on purpose: its playlists fetch fine but every segment
 * is a TikTok ad-CDN URL that answers 403 "domain forbidden" (in a browser
 * too), so it would pass the playlist checks and then not play. Nova/Astra
 * were always null.
 *
 * Both media hosts answer 403 to a Referer alone and need `Origin` as well,
 * which is what `headers` is for (the host's relay sends it since web-links
 * 0.9.0; an older host will get 403s from these links).
 */
const SITE = "https://vidrock.net/";
const KEY_HEX = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
const SERVERS = ["Orion", "Luna"];
const API_TIMEOUT_MS = 20_000;
const IV_BYTES = 12;

let aesKey: Promise<CryptoKey> | undefined;

function importKey(): Promise<CryptoKey> {
    aesKey ??= webcrypto.subtle.importKey("raw", Buffer.from(KEY_HEX, "hex"), "AES-GCM", false, ["decrypt"]);
    return aesKey;
}

/** base64url(iv[12] || ciphertext || tag) -> plaintext. */
async function decrypt(blob: string): Promise<string> {
    const bytes = Buffer.from(blob.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) }, await importKey(), bytes.subarray(IV_BYTES));
    return Buffer.from(plain).toString("utf8");
}

const vidrockSite: HttpSite = {
    id: "vidrock",
    name: "Vidrock",
    referrer: SITE,
    headers: { Origin: SITE.slice(0, -1) },
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;

        const response = await ctx.fetch(`${SITE}api/${path}`, { headers: { Referer: SITE }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        if (!response.ok) return;

        const servers = (await response.json()) as Record<string, { url?: string | null; type?: string } | undefined>;
        for (const name of SERVERS) {
            const entry = servers[name];
            if (!entry?.url || entry.type !== "hls") continue;
            let mediaUrl: string;
            try {
                mediaUrl = entry.url.startsWith("http") ? entry.url : await decrypt(entry.url);
            } catch {
                continue; // undecryptable (key rotated): skip this server.
            }
            yield { mediaUrl, label: name };
        }
    }
};

export default createScraper(vidrockSite);
