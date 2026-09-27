/**
 * ARCHIVED (1.19.0): the browser-driven `flixer` scraper, replaced by the
 * plain-HTTP `src/sites/flixer.mts`. Not exported from `src/index.mts`; kept as
 * a fallback to restore if the site changes its protocol faster than the
 * HTTP version can follow (STRATEGIES.md, "WASM reverse-engineering").
 */
import { autoplayCapture, createScraper, type SiteAdapter } from "../../shared.mts";

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
        /*
            Playlists are served as `serve.dragonballzfans.xyz/proxy?data=...`,
            which has no `.m3u8` for the default matcher to find, so nothing
            was ever captured. The first such request is the master.
        */
        yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/serve\.dragonballzfans\.xyz\/proxy\?data=/i });
    }
};


export default createScraper(flixerSite);
