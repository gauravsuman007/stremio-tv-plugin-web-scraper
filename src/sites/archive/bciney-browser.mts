/**
 * ARCHIVED (1.19.0): the browser-driven `bciney` scraper, replaced by the
 * plain-HTTP `src/sites/bciney.mts`. Not exported from `src/index.mts`; kept as
 * a fallback to restore if the site changes faster than the HTTP version can
 * follow (STRATEGIES.md).
 */
import { autoplayCapture, createBrowserScraper, type BrowserSite } from "../../browser.mts";

/**
 * bciney.to -- its own watch page just iframes `player.bciney.to`, so this
 * opens that player directly (the same player, without the ad-heavy
 * wrapper). It autoplays with `?autoplay=true`; the playlist comes back via
 * its own `v.bciney.to` proxy (the master is the extension-less `/v?url=`) and needs no special headers.
 */
const bcineySite: BrowserSite = {
    id: "bciney",
    name: "bCine",
    referrer: "https://player.bciney.to/",
    maxQuality: "1080p",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://player.bciney.to/embed";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}?autoplay=true`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}?autoplay=true`;
        /*
            The player used to hand over the extension-less `v.bciney.to/v?url=`
            master; it now plays a media playlist straight off its CDN
            (`.../<hash>.mp4/index.m3u8`), which the old pattern alone
            rejected -- every resolve returned null. Both are accepted.
        */
        yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/v\.bciney\.to\/v\?url=|\.m3u8(?:[?&#].*)?$/i });
    }
};


export default createBrowserScraper(bcineySite);
