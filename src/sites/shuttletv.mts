import { getStream, listProviders, CINESRC_ORIGIN } from "../cinesrc.mts";
import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * shuttletv.su -- its watch page just iframes `cinesrc.st`'s embed. This talks
 * to cinesrc's stream API directly (src/cinesrc.mts): no browser, 1-3 s a
 * provider. It used to drive Chromium through the player (kept for reference
 * in ./archive/shuttletv-browser.mts).
 *
 * Providers are tried best-ranked first, each with its own challenge; Nebula
 * (1080p, `nebula.bright67.online`) answers for most titles. Playlists are
 * `cinesrc.st/api/playlist/<token>.m3u8` masters; segments are named `.jpg`
 * but are video, and need no Referer.
 */
const MAX_PROVIDERS = 4;

const shuttletvSite: HttpSite = {
    id: "shuttletv",
    name: "ShuttleTV",
    referrer: `${CINESRC_ORIGIN}/`,
    maxQuality: "4K",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const target = match.mediaType === "movie"
            ? { tmdbId: match.tmdbId, mediaType: "movie" as const }
            : { tmdbId: match.tmdbId, mediaType: "tv" as const, season: season ?? 1, episode: episode ?? 1 };

        const listed = await listProviders(ctx.fetch, target).catch(() => []);
        const providers = listed.length ? listed.slice(0, MAX_PROVIDERS) : [{ id: "nebula", name: "Nebula", rank: 0 }];

        for (const provider of providers) {
            const stream = await getStream(ctx.fetch, target, provider.id).catch(() => null);
            for (const source of stream?.url ?? []) {
                if (!source.url || (source.source && source.source !== "HLS")) continue;
                yield { mediaUrl: new URL(source.url, CINESRC_ORIGIN).href, label: stream?.name ?? provider.name };
            }
        }
    }
};

export default createScraper(shuttletvSite);
