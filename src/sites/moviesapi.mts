import { createScraper, type HttpSite } from "../shared.mts";

/**
 * moviesapi.to (VidSpark) -- the backend PressPlay iframes, and vidnest's
 * `vidxyz` route. Its player asks a plain JSON API for the stream, so no
 * browser is needed. The API wants a static key that ships in the player's
 * own bundle; without it, 401.
 *
 * Returns a muxed 1080p HLS master (video + AAC in one rendition, no
 * encryption). Playlist and segments both play with the Referer alone.
 * Recipe and measurements: STRATEGIES.md.
 */
const SITE = "https://moviesapi.to/";
const PLAYER_KEY = "3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13";
const API_TIMEOUT_MS = 20_000;

const moviesapiSite: HttpSite = {
    id: "moviesapi",
    name: "MoviesAPI",
    referrer: SITE,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx) {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;

        const response = await ctx.fetch(`${SITE}api/vidora/v1/${path}`, {
            headers: { Referer: SITE, Origin: SITE.slice(0, -1), "x-player-key": PLAYER_KEY },
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) return;

        const body = (await response.json()) as { result?: boolean; sources?: { url?: string; source?: string }[] };
        if (!body.result) return;
        for (const source of body.sources ?? []) {
            if (source.url) yield { mediaUrl: source.url, label: source.source };
        }
    }
};

export default createScraper(moviesapiSite);
