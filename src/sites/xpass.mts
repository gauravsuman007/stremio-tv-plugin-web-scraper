import { createHash, createDecipheriv } from "node:crypto";
import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * play.xpass.top -- the "Premium embeds" server of 1Shows (viduki.net/4) and a
 * TMDB-keyed embed of its own. Plain HTTP (recipe: STRATEGIES.md):
 *
 *   1. GET /e/{movie/<tmdb>|tv/<tmdb>/<s>/<e>} -> page with `dataUrl="/data/...&token=..."`
 *   2. GET that dataUrl -> base64url(iv[12] || AES-256-GCM ciphertext+tag), key =
 *      SHA-256("spv3-data-response|<build>|<dataUrl path>|<token>"); plaintext is
 *      the server list [{name:"VIP 1", url:"/vip/.../playlist.json"}, ...] (40-60 of them)
 *   3. GET a server's playlist.json -> {playlist:[{sources:[{file: <HLS master>}]}]}
 *
 * The build label lives in the player script (`/static/<random>.js`); if
 * decryption starts failing it has rotated -- re-read it from there.
 *
 * Measured 2026-09-27 (Inception, GoT S1E1): only the `VIP` (vip.1x2.space,
 * 640x266/1280x534/1920x800, the same encode as vidlove) and `LUL` (cflul
 * workers, Aether's CDN) servers played; FIL/WIS/MEG masters were empty,
 * 404 or timed out. The playlist endpoint answers 429 after ~15 quick calls,
 * so only a handful are asked.
 */
const SITE = "https://play.xpass.top";
const BUILD = "spv3-build-1787821613-50e5fc97c9dce367";
const TIMEOUT_MS = 15_000;
/** Server families worth asking, best first, and how many servers of each. */
const FAMILIES: [string, number][] = [["VIP", 2], ["LUL", 2]];

function decryptServers(body: string, path: string, token: string): { name?: string; url?: string }[] {
    const key = createHash("sha256").update(`spv3-data-response|${BUILD}|${path}|${token}`).digest();
    const data = Buffer.from(body.trim(), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8")) as { name?: string; url?: string }[];
}

async function getText(ctx: ScraperContext, url: string, referer: string): Promise<string | null> {
    const response = await ctx.fetch(url, { headers: { Referer: referer }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? response.text() : null;
}

const xpassSite: HttpSite = {
    id: "xpass",
    name: "XPass",
    referrer: `${SITE}/`,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const embed = match.mediaType === "movie"
            ? `${SITE}/e/movie/${match.tmdbId}`
            : `${SITE}/e/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        const page = await getText(ctx, embed, `${SITE}/`);
        const dataUrl = page && /dataUrl="([^"]+)"/.exec(page)?.[1];
        if (!dataUrl) return;
        const url = new URL(dataUrl, SITE);
        const token = url.searchParams.get("token");
        const body = token && await getText(ctx, url.href, embed);
        if (!body) return;

        let servers: { name?: string; url?: string }[];
        try { servers = decryptServers(body, url.pathname, token); } catch { return; } // build label rotated
        for (const [family, count] of FAMILIES) {
            for (const server of servers.filter((entry) => entry.url && entry.name?.split(" ")[0] === family).slice(0, count)) {
                const json = await getText(ctx, new URL(server.url!, SITE).href, embed);
                if (!json) continue;
                let file: string | undefined;
                try {
                    const parsed = JSON.parse(json) as { playlist?: { sources?: { file?: string; type?: string }[] }[] };
                    file = parsed.playlist?.[0]?.sources?.find((source) => source.type === "hls")?.file;
                } catch { continue; }
                if (file?.startsWith("http")) yield { mediaUrl: file, label: server.name };
            }
        }
    }
};

export default createScraper(xpassSite);
