import { autoplayCapture, createScraper, type SiteAdapter } from "../shared.mts";

/**
 * bciney.to -- its own watch page just iframes `player.bciney.to`, so this
 * opens that player directly (the same player, without the ad-heavy
 * wrapper). It autoplays with `?autoplay=true`; the playlist comes back via
 * its own `v.bciney.to` proxy (the master is the extension-less `/v?url=`) and needs no special headers.
 */
const bcineySite: SiteAdapter = {
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
        yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/v\.bciney\.to\/v\?url=/i });
    }
};


export default createScraper(bcineySite);
