import { autoplayCapture, createScraper, type SiteAdapter } from "../shared.mts";

/**
 * flixer.gd -- same `/watch/{movie|tv}/{tmdbId}[/s/e]` shape as cinejoy, but
 * no server picker: the player autoplays. Its stream URL is also derived by
 * a WASM module in the page, so it needs the browser just like cinejoy.
 * The media host serves the playlist with no special headers.
 *
 * The site injects malvertising (popunders, fake "install adblocker"
 * prompts); `resolve()` closes any popup tab, and nothing here ever clicks.
 */
const flixerSite: SiteAdapter = {
    id: "flixer",
    name: "Flixer",
    referrer: "https://flixer.gd/",
    maxQuality: "1080p",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://flixer.gd/watch";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        yield* autoplayCapture(page, url, ctx);
    }
};


export default createScraper(flixerSite);
