import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * bciney.to -- its watch page iframes `player.bciney.to`, whose server-rendered
 * embed page already lists its streams: the Next.js flight data
 * (`self.__next_f.push([1, "..."])`) carries `initialServers`, each an HLS
 * master behind bCine's own `v.bciney.to/v?url=` proxy. So a single page fetch
 * is enough; it used to autoplay the player in Chromium to catch the same URL
 * (./archive/bciney-browser.mts). No special headers needed.
 */
const PLAYER = "https://player.bciney.to";
const TIMEOUT_MS = 15_000;

interface BcineyServer {
    name?: string;
    url?: string;
    type?: string;
}

/** The first JSON array after `key` in `text`, by bracket matching (strings skipped). */
function jsonArrayAfter(text: string, key: string): unknown[] | null {
    const at = text.indexOf(key);
    if (at < 0) return null;
    const start = text.indexOf("[", at);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
        } else if (c === "[" || c === "{") depth++;
        else if ((c === "]" || c === "}") && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as unknown[];
    }
    return null;
}

const bcineySite: HttpSite = {
    id: "bciney",
    name: "bCine",
    referrer: `${PLAYER}/`,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        const response = await ctx.fetch(`${PLAYER}/embed/${path}?autoplay=true`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) return;
        const html = await response.text();
        const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => JSON.parse(m[1]!) as string).join("");
        const servers = (jsonArrayAfter(flight, '"initialServers":') ?? []) as BcineyServer[];
        for (const server of servers) {
            if (server.url && (!server.type || server.type === "hls")) yield { mediaUrl: server.url, label: server.name };
        }
    }
};

export default createScraper(bcineySite);
