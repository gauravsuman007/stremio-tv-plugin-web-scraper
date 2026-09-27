/**
 * ARCHIVED (1.19.0): the browser-driven `7movies` scraper, replaced by the
 * plain-HTTP `src/sites/7movies.mts`. Not exported from `src/index.mts`; kept as
 * a fallback to restore if the site changes faster than the HTTP version can
 * follow (STRATEGIES.md).
 */
import { autoplayCapture, createBrowserScraper, type BrowserSite } from "../../browser.mts";

/**
 * 7movies.ac -- its watch page iframes `embed.vidrift.net`, so this opens that
 * player directly. It autoplays; playlists come off `embed.vidrift.net/api/mb`
 * (movies) or `relay.vidrift.net` (TV).
 *
 * WHICH PROVIDER THE PLAYER USES DEPENDS ON THE CALLER'S IP.
 * From a residential address it asks `api/source/...` and the browser makes a
 * request for `.../api/mb/<id>/master.m3u8`, which the capture sees. From the
 * server (a German datacentre address) it plays a pre-warmed
 * `relay.vidrift.net/proxy?url=...` stream that its boot response already
 * lists, and the page never requests a playlist at all -- so a capture that
 * only listens to the network found nothing and every resolve returned null,
 * while the same scraper worked from a laptop. The boot response is plain
 * JSON, so it is read first and its masters are offered before the browser is
 * even started; the browser still runs after, for the case where it does see
 * a better playlist (the moviebox one carries 1080p).
 */
const BASE = "https://embed.vidrift.net";

interface BootStream {
    proxyUrl?: string;
    url?: string;
    type?: string;
    provider?: string;
}

const sevenMoviesSite: BrowserSite = {
    id: "7movies",
    name: "7Movies",
    referrer: "https://embed.vidrift.net/",
    maxQuality: "1080p",
    async *captures(page, { match, season, episode }, ctx) {
        const path =
            match.mediaType === "movie"
                ? `movie/${match.tmdbId}`
                : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;

        try {
            const response = await ctx.fetch(`${BASE}/api/boot/${path}`, { headers: { Referer: `${BASE}/` } });
            if (response.ok) {
                const boot = (await response.json()) as { meta?: { warmStreams?: BootStream[] } };
                for (const stream of boot.meta?.warmStreams ?? []) {
                    const mediaUrl = stream.proxyUrl || stream.url;
                    if (mediaUrl && stream.type !== "dash") yield { mediaUrl, label: stream.provider || undefined };
                }
            }
        } catch {
            /* the browser below is the fallback */
        }

        yield* autoplayCapture(page, `${BASE}/embed2/${path}`, ctx);
    }
};

export default createBrowserScraper(sevenMoviesSite);
