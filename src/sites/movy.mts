import { autoplayCapture, createScraper, type SiteAdapter } from "../shared.mts";

/**
 * movy.sx -- `/movie/{tmdb}` and `/tv/{tmdb}/{s}/{e}`. The player waits for a
 * Play click, and the first clicks are hijacked by popunder ads that navigate
 * the page away (`clickPlay` blocks that). The stream comes from
 * `api.wecollege.net/miami/sources`, played off `moon.quietridge.top`, as a
 * single playlist named for its resolution (`index-s1080p-...`), so quality
 * is read from the URL. The page also autoplays an IMDb trailer, which
 * capture ignores.
 */
const movySite: SiteAdapter = {
    id: "movy",
    name: "Movy",
    referrer: "https://movy.sx/",
    maxQuality: "1080p",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://movy.sx";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        yield* autoplayCapture(page, url, ctx, { clickPlay: true });
    }
};

export default createScraper(movySite);
