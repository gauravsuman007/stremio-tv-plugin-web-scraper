import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * lul.aether.cx -- a backend used by the Aether P-Stream fork. Plain HTTP, no
 * key, no headers on the media host either. Found by watching what a live
 * P-Stream fork requests (black-box, see STRATEGIES.md).
 *
 *   GET https://lul.aether.cx/{movie/TMDB | tv/TMDB/S/E} -> {stream: url} | {error}
 *
 * `stream` is a single-rendition HLS master on `cflul.ax5.workers.dev/vid/...`
 * (a Cloudflare Worker), which needs no headers.
 *
 * Since 2026-09-27 the API host's Cloudflare answers a request with no
 * Referer with an "Attention Required" block page (403); any Referer from the
 * fork's own site passes.
 */
const API = "https://lul.aether.cx/";
const API_TIMEOUT_MS = 20_000;
const FRONT_END = "https://aether.ist/";

const aetherlulSite: HttpSite = {
    id: "aetherlul",
    name: "Aether",
    referrer: API,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;

        const response = await ctx.fetch(`${API}${path}`, { headers: { Referer: FRONT_END }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        if (!response.ok) return;

        const body = (await response.json()) as { stream?: string; error?: string };
        if (body.stream) yield { mediaUrl: body.stream, label: "Aether" };
    }
};

export default createScraper(aetherlulSite);
