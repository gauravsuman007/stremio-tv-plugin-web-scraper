import { autoplayCapture, createScraper, type SiteAdapter } from "../shared.mts";

/**
 * shuttletv.su -- its watch page just iframes `cinesrc.st`'s embed, so this
 * opens that player directly (same player, no ad-heavy wrapper). It autoplays
 * once its proof-of-work WASM has run, which is why it needs a real browser.
 * Playlists come from `cinesrc.st/api/playlist/{token}` with no `.m3u8`
 * extension, so the URL prefix is what identifies them.
 */
const shuttletvSite: SiteAdapter = {
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

export default createScraper(shuttletvSite);
