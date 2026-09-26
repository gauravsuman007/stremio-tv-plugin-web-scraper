import { createScraper, type HttpSite } from "../shared.mts";

/**
 * arrowtv.net -- its watch page iframes `player.cinezo.live`, which asks an
 * open JSON API (`proxy1.flikhub.net`) for each source. No browser needed:
 * with the player's Referer/Origin the API answers plain HTTP.
 *
 * Only the `berlin` source is used: it returns an HLS master (up to 1080p).
 * `zendaya` is DASH, which the host's link kinds can't carry, and `cinefreak`
 * / `jennifer` returned nothing for any title tried.
 */
const PLAYER = "https://player.cinezo.live/";
const API_TIMEOUT_MS = 20_000;

const cinezoSite: HttpSite = {
    id: "cinezo",
    name: "Cinezo",
    referrer: PLAYER,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx) {
        const path =
            match.mediaType === "movie"
                ? `movie?id=${match.tmdbId}`
                : `tv?id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;

        const response = await ctx.fetch(`https://proxy1.flikhub.net/${path}&mode=json&sources=berlin&hevc=1`, {
            headers: { Referer: PLAYER, Origin: PLAYER.slice(0, -1) },
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) return;

        const body = (await response.json()) as { source?: { url?: string } };
        if (body.source?.url) yield { mediaUrl: body.source.url, label: "Berlin" };
    }
};

export default createScraper(cinezoSite);
