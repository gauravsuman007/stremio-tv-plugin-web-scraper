/**
 * ARCHIVED (1.18.0): the browser-driven `shuttletv` scraper, replaced by the
 * plain-HTTP `src/sites/shuttletv.mts`. Not exported from `src/index.mts`; kept as
 * a fallback to restore if the site changes its protocol faster than the
 * HTTP version can follow (STRATEGIES.md, "WASM reverse-engineering").
 */
import { autoplayCapture, createBrowserScraper, type BrowserSite } from "../../browser.mts";

/**
 * shuttletv.su -- its watch page just iframes `cinesrc.st`'s embed, so this
 * opens that player directly (same player, no ad-heavy wrapper). It autoplays
 * once its proof-of-work WASM has run, which is why it needs a real browser.
 * Playlists come from `cinesrc.st/api/playlist/{token}` with no `.m3u8`
 * extension, so the URL prefix is what identifies them.
 */
const shuttletvSite: BrowserSite = {
    id: "shuttletv",
    name: "ShuttleTV",
    referrer: "https://cinesrc.st/",
    maxQuality: "4K",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://cinesrc.st/embed";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}`
                : `${base}/tv/${match.tmdbId}?season=${season ?? 1}&episode=${episode ?? 1}`;
        yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/cinesrc\.st\/api\/playlist\//i });
    }
};

export default createBrowserScraper(shuttletvSite);
