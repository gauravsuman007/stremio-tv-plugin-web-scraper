import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * rivestream.app -- its scraper API (scrapper.rivestream.app) answers plain
 * JSON with no key. Found by watching what a P-Stream instance requests
 * (black-box, see STRATEGIES.md). Only the `vanguard` provider returns
 * anything: an HLS master up to 4K HDR on the cinejoy CDN, wrapped in a
 * `proxy.valhallastream.com/m3u8-proxy?url=<real>&headers=<json>` URL. That
 * proxy is not used: the real URL and the headers it would send (Referer and
 * Origin of cinejoy.pk) are unwrapped and declared on the link instead, so the
 * host relay fetches the CDN directly. `pulse` and `apex` returned null.
 */
const API = "https://scrapper.rivestream.app/api/provider";
const API_TIMEOUT_MS = 20_000;

const rivestreamSite: HttpSite = {
    id: "rivestream",
    name: "Rivestream",
    referrer: "https://cinejoy.pk/",
    headers: { Origin: "https://cinejoy.pk" },
    maxQuality: "4K",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const query = match.mediaType === "movie"
            ? `id=${match.tmdbId}`
            : `id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;

        const response = await ctx.fetch(`${API}?provider=vanguard&${query}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        if (!response.ok) return;

        const body = (await response.json()) as { data?: { sources?: { url?: string; format?: string }[] } | null };
        for (const source of body.data?.sources ?? []) {
            if (!source.url || (source.format && source.format !== "hls")) continue;
            let mediaUrl = source.url;
            try {
                const wrapped = new URL(source.url).searchParams.get("url");
                if (wrapped) mediaUrl = wrapped;
            } catch {
                continue;
            }
            yield { mediaUrl, label: "Vanguard" };
        }
    }
};

export default createScraper(rivestreamSite);
