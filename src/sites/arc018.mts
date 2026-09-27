import { resolveByse, byseEmbed } from "../byse.mts";
import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * arc018.stream -- and BFLIX (bbflix.one), which is the same backend (same
 * `ajax.php` tokens, same videos). Plain HTTP (recipe: STRATEGIES.md):
 *
 *   1. The title's page: /watch-movie/<slug>-<year>-watch-online/ or, for a
 *      show, /episode/<slug>-<year>-watch-online/sXX-eYY/ (slug: the title,
 *      lower-case, every run of other characters one `-`; the site's search
 *      is the fallback). It carries a `data-token`.
 *   2. POST /ajax/ajax.php with `players=<token>` (`players_show=` for an
 *      episode) -> [{name, link}]: "arc018" is a Byse embed (src/byse.mts),
 *      "Vidmoly" a kaembed.net page with the HLS master in its `sources`.
 *
 * 720p-1080p (Byse labels everything 1080p). Both hosts bind the stream URL to the
 * caller's ASN.
 */
const SITE = "https://arc018.stream/";
const TIMEOUT_MS = 15_000;

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function getText(ctx: ScraperContext, url: string, referer = SITE): Promise<string | null> {
    const response = await ctx.fetch(url, { headers: { Referer: referer }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? response.text() : null;
}

/** The title's base path, e.g. `inception-2010-watch-online`, straight or via search. */
async function findSlug(ctx: ScraperContext, title: string, year: number | null, kind: "movie" | "series"): Promise<string | null> {
    const guess = `${slugify(title)}-${year ?? ""}-watch-online`;
    const direct = await ctx.fetch(`${SITE}watch-${kind}/${guess}/`, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    if (direct?.ok) return guess;
    const search = await getText(ctx, `${SITE}search?q=${encodeURIComponent(title)}`);
    if (!search) return null;
    const wanted = slugify(title);
    for (const [, slug] of search.matchAll(new RegExp(`/watch-${kind}/([a-z0-9-]+-watch-online)/`, "g"))) {
        const [, name, found] = /^(.*)-(\d{4})-watch-online$/.exec(slug!) ?? [];
        if (name === wanted && (!year || Number(found) === year)) return slug!;
    }
    return null;
}

async function vidmoly(ctx: ScraperContext, link: string): Promise<Capture | null> {
    const page = await getText(ctx, link);
    const mediaUrl = page && /sources:\s*\[\{\s*file:\s*'([^']+\.m3u8[^']*)'/.exec(page)?.[1];
    return mediaUrl ? { mediaUrl, label: "Vidmoly", referrer: `${new URL(link).origin}/` } : null;
}

const arc018Site: HttpSite = {
    id: "arc018",
    name: "arc018",
    referrer: SITE,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const movie = match.mediaType === "movie";
        const slug = await findSlug(ctx, match.title, match.year, movie ? "movie" : "series");
        if (!slug) return;
        const pad = (n: number | undefined) => String(n ?? 1).padStart(2, "0");
        const page = await getText(ctx, movie ? `${SITE}watch-movie/${slug}/` : `${SITE}episode/${slug}/s${pad(season)}-e${pad(episode)}/`);
        const token = page && /data-token="([^"]+)"/.exec(page)?.[1];
        if (!token) return;

        const form = new FormData();
        form.append(movie ? "players" : "players_show", token);
        const response = await ctx.fetch(`${SITE}ajax/ajax.php`, { method: "POST", body: form, headers: { Referer: SITE }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) return;
        let servers: { name?: string; link?: string }[];
        try {
            const body = (await response.json()) as typeof servers | { name?: string; link?: string };
            servers = Array.isArray(body) ? body : [body];
        } catch { return; }

        for (const server of servers) {
            if (!server.link) continue;
            if (byseEmbed(server.link)) {
                for (const source of await resolveByse(server.link, SITE, ctx)) {
                    yield { mediaUrl: source.url, label: "Byse", referrer: source.referrer };
                }
            } else if (/kaembed|vidmoly/.test(server.link)) {
                const capture = await vidmoly(ctx, server.link);
                if (capture) yield capture;
            }
        }
    }
};

export default createScraper(arc018Site);
