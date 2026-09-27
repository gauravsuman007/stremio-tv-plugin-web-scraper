import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * lookmovie2.to -- plain HTTP, no key. Found by watching what a P-Stream
 * instance requests (black-box, see STRATEGIES.md):
 *
 *   1. GET /api/v1/{movies|shows}/do-search/?q=<title>  -> results with id, slug, title, year
 *   2. GET /{movies|shows}/play/<slug>                   -> inline `hash`, `expires`, and for
 *      shows `window.seasons` (JSON with each episode's `id_episode`); for movies `id_movie`
 *   3. GET /api/v1/security/{movie|episode}-access?id_...&hash=&expires= -> `streams`
 *      ({"480p"|"720p"|"1080p" or "480"|...: url|null}), each a single-rendition HLS playlist
 *
 * Which qualities exist varies per title (often only 480p). The media host
 * needs no Referer. Some titles are AES-128 (`/aes/` in the path), which the
 * relay handles as it does for VixSrc.
 */
const SITE = "https://www.lookmovie2.to/";
const API_TIMEOUT_MS = 20_000;

const normalise = (text: string) => text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
const QUALITY_ORDER = ["1080p", "1080", "720p", "720", "480p", "480", "360p", "360"];

async function getText(ctx: ScraperContext, url: string): Promise<string | null> {
    const response = await ctx.fetch(url, { headers: { Referer: SITE }, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    return response.ok ? response.text() : null;
}

const lookmovieSite: HttpSite = {
    id: "lookmovie",
    name: "LookMovie",
    referrer: SITE,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const kind = match.mediaType === "movie" ? "movies" : "shows";
        const search = await getText(ctx, `${SITE}api/v1/${kind}/do-search/?q=${encodeURIComponent(match.title)}`);
        if (!search) return;

        let results: { slug: string; title: string; year?: number }[];
        try { results = (JSON.parse(search) as { result?: typeof results }).result ?? []; } catch { return; }
        const wanted = normalise(match.title);
        const hit = results.find((entry) => normalise(entry.title) === wanted && (!match.year || entry.year === match.year))
            ?? results.find((entry) => normalise(entry.title) === wanted);
        if (!hit) return;

        const page = await getText(ctx, `${SITE}${kind}/play/${hit.slug}`);
        if (!page) return;
        const hash = /hash:\s*["']([^"']+)["']/.exec(page)?.[1];
        const expires = /expires:\s*(\d+)/.exec(page)?.[1];
        if (!hash || !expires) return;

        let access: string;
        if (match.mediaType === "movie") {
            const id = /id_movie:\s*(\d+)/.exec(page)?.[1];
            if (!id) return;
            access = `movie-access?id_movie=${id}`;
        } else {
            const raw = /window\.seasons='(.*)';\s*\n/.exec(page)?.[1];
            if (!raw) return;
            let episodeId: string | undefined;
            try {
                // The page embeds the JSON in a single-quoted JS string: undo its escapes.
                const seasons = JSON.parse(raw.replace(/\\(['"\\])/g, "$1")) as Record<string, { episodes?: Record<string, { id_episode?: string }> }>;
                episodeId = seasons[String(season ?? 1)]?.episodes?.[String(episode ?? 1)]?.id_episode;
            } catch {
                return;
            }
            if (!episodeId) return;
            access = `episode-access?id_episode=${episodeId}`;
        }

        const body = await getText(ctx, `${SITE}api/v1/security/${access}&hash=${hash}&expires=${expires}`);
        if (!body) return;
        let streams: Record<string, string | null>;
        try { streams = (JSON.parse(body) as { streams?: typeof streams }).streams ?? {}; } catch { return; }
        for (const quality of QUALITY_ORDER) {
            const mediaUrl = streams[quality];
            if (mediaUrl) yield { mediaUrl, label: quality.endsWith("p") ? quality : `${quality}p` };
        }
    }
};

export default createScraper(lookmovieSite);
