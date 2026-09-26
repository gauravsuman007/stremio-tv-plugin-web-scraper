import { autoplayCapture, createScraper, type SiteAdapter } from "../shared.mts";

/**
 * 7movies.ac -- its watch page iframes `embed.vidrift.net`, so this opens that
 * player directly. It autoplays; playlists come off `embed.vidrift.net/api/mb`
 * (movies) or `relay.vidrift.net` (TV).
 */
const sevenMoviesSite: SiteAdapter = {
    id: "7movies",
    name: "7Movies",
    referrer: "https://embed.vidrift.net/",
    maxQuality: "1080p",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://embed.vidrift.net/embed2";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        yield* autoplayCapture(page, url, ctx);
    }
};

export default createScraper(sevenMoviesSite);
