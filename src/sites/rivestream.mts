import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * rivestream.app -- its scraper API (scrapper.rivestream.app) answers plain
 * JSON with no key. Found by watching what a P-Stream instance requests
 * (black-box, see STRATEGIES.md). Three providers, which take turns being
 * empty (`{data:null}`), so all three are asked at once: `vanguard` (up to 4K
 * HDR on the cinejoy CDN), `apex` (Vidnest's CDN) and `pulse` (Aether's).
 * Each source is wrapped in `proxy.valhallastream.com/m3u8-proxy?url=<real>&
 * headers=<json>`. That proxy is not used: the real URL and the headers it
 * would send (Referer/Origin, which differ per provider) are unwrapped and
 * declared on the link, so the host relay fetches the CDN directly.
 */
const API = "https://scrapper.rivestream.app/api/provider";
const API_TIMEOUT_MS = 20_000;
/** Best first: vanguard is the one that has reached 4K. */
const PROVIDERS = ["vanguard", "apex", "pulse"];

function unwrap(url: string): { mediaUrl: string; referrer?: string; headers?: Record<string, string> } | null {
    try {
        const params = new URL(url).searchParams;
        const mediaUrl = params.get("url");
        if (!mediaUrl) return { mediaUrl: url };
        const sent = JSON.parse(params.get("headers") || "{}") as Record<string, string>;
        const referrer = sent.Referer ?? sent.referer;
        const origin = sent.Origin ?? sent.origin;
        return { mediaUrl, ...(referrer ? { referrer } : {}), ...(origin ? { headers: { Origin: origin } } : {}) };
    } catch {
        return null;
    }
}

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

        const answers = PROVIDERS.map((provider) =>
            ctx
                .fetch(`${API}?provider=${provider}&${query}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
                .then((r) => (r.ok ? (r.json() as Promise<{ data?: { sources?: { url?: string; format?: string }[] } | null }>) : null))
                .catch(() => null)
        );

        for (const [i, answer] of answers.entries()) {
            for (const source of (await answer)?.data?.sources ?? []) {
                if (!source.url || (source.format && source.format !== "hls")) continue;
                const link = unwrap(source.url);
                if (!link) continue;
                const label = PROVIDERS[i]!.replace(/^./, (c) => c.toUpperCase());
                // A link that brings its own Referer carries only its own headers, not the site's cinejoy Origin.
                yield { ...link, headers: link.headers ?? (link.referrer ? {} : undefined), label };
            }
        }
    }
};

export default createScraper(rivestreamSite);
