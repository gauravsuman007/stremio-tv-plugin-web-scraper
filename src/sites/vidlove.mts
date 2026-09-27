import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * vidlove.cc -- its player calls api.vidlove.cc for a `vidapi` source whose
 * `url` is an HLS master. Plain HTTP; the response body contains raw control
 * characters, which JSON.parse rejects, so they are stripped first. Recipe and
 * measurements: STRATEGIES.md. The media host needs only a Referer.
 */
const PLAYER = "https://player.vidlove.cc/";
const API = "https://api.vidlove.cc/";
const API_TIMEOUT_MS = 20_000;

const vidloveSite: HttpSite = {
    id: "vidlove",
    name: "Vidlove",
    referrer: PLAYER,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie"
            ? `movie?id=${match.tmdbId}`
            : `tv?id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;

        const response = await ctx.fetch(`${API}${path}&mode=json&sources=vidapi`, {
            headers: { Referer: PLAYER, Origin: PLAYER.slice(0, -1) },
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) return;

        // eslint-disable-next-line no-control-regex
        const text = (await response.text()).replace(/[\u0000-\u001f]/g, " ");
        let body: { source?: { url?: string | null } | null };
        try { body = JSON.parse(text); } catch { return; }
        if (body.source?.url) yield { mediaUrl: body.source.url, label: "VidAPI" };
    }
};

export default createScraper(vidloveSite);
