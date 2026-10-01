import { createScraper, type Capture, type HttpSite } from "../shared.mts";
import { openTitle } from "../vidfast.mts";

/**
 * vidfast.vc -- sealed requests, answered by the site's own player code run in
 * a restricted `node:vm` context (src/vidfast.mts; recipe and why it can't be
 * reimplemented natively: STRATEGIES.md, "vidfast.vc"). The player yields a
 * server list and, per server, an HLS master on a CDN that needs the vidfast
 * `Referer` and `Origin`. Servers whose stream can't be produced are skipped.
 */
const ORIGIN = "https://vidfast.vc";
/** Servers worth asking, in the order the site lists them; a title rarely has more than a few that play. */
const MAX_SERVERS = 6;

const vidfastSite: HttpSite = {
    id: "vidfast",
    name: "VidFast",
    referrer: `${ORIGIN}/`,
    headers: { Origin: ORIGIN },
    maxQuality: "4K",
    compareAll: true,
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `/movie/${match.tmdbId}` : `/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        const session = await openTitle(ctx, path);
        if (!session) return;

        for (const server of session.servers.slice(0, MAX_SERVERS)) {
            const stream = await session.stream(server).catch(() => null);
            if (stream) yield { mediaUrl: stream.url, label: server.name };
        }
    }
};

export default createScraper(vidfastSite);
