import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * movienestbd.best -- plain HTTP, movies only. A Hindi-dub catalogue whose
 * files mostly carry Hindi and English audio (the master lists both as
 * `#EXT-X-MEDIA` renditions).
 *
 *   1. GET /search?q=<title>             -> `movie-card` links to /<slug>
 *   2. GET /<slug>                       -> `<title>Name (Year) ...`, and `rawLinks`:
 *                                           `jiofiles.pics/<id>` per quality (480P/720P/1080P)
 *   3. GET embed.jiofiles.pics/<id>      -> an `indbd.pages.dev/embed/<host>/<vid>` iframe
 *   4. GET indbd.pages.dev/api/info?url=<host>&id=<vid>
 *                                        -> `data.cfNativeDirect`: a `?k=&kx=` signed master on <host>
 *
 * Every playlist and segment wants `Referer: https://<host>/` (403 without).
 * `data.hlsVideoTiktok` (and, now and then, the same master) lists segments on
 * a TikTok image CDN instead: MPEG-TS behind a 120-byte PNG header, like
 * Flixer's. That one is not offered.
 * Series pages hold whole-season packs, not episodes, so only movies are served.
 */
const SITE = "https://movienestbd.best/";
const TIMEOUT_MS = 15_000;
const QUALITY_ORDER = ["1080P", "720P", "480P"];

const slugify = (text: string) => text.toLowerCase().replace(/&/g, "and").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function getText(ctx: ScraperContext, url: string, referer = SITE): Promise<string | null> {
    try {
        const response = await ctx.fetch(url, { headers: { Referer: referer }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

/** The page's own `rawLinks` entries, best quality first. */
function pageLinks(page: string): string[] {
    const links = [...page.matchAll(/link:\s*"https:\\\/\\\/jiofiles\.[a-z]+\\\/([0-9a-f]{16,})",\s*quality:\s*"([^"]*)"/g)]
        .map(([, id, quality]) => ({ id: id!, rank: QUALITY_ORDER.indexOf(quality!.toUpperCase()) }));
    links.sort((a, b) => (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank));
    return [...new Set(links.map((link) => link.id))];
}

interface InfoResponse {
    success?: boolean;
    referer?: string;
    data?: { cfNativeDirect?: string };
}

const movienestbdSite: HttpSite = {
    id: "movienestbd",
    name: "MovieNestBD",
    referrer: SITE,
    maxQuality: "1080p",
    async *httpCaptures({ match }, ctx): AsyncGenerator<Capture> {
        if (match.mediaType !== "movie") return;
        const search = await getText(ctx, `${SITE}search?q=${encodeURIComponent(match.title)}`);
        if (!search) return;
        const wanted = slugify(match.title);
        const slugs = [...new Set([...search.matchAll(/href="\/([a-z0-9-]+)"[^>]*class="movie-card/g)].map(([, slug]) => slug!))]
            .filter((slug) => slug === wanted || slug.startsWith(`${wanted}-`))
            .sort((a, b) => Number(b === wanted) - Number(a === wanted))
            .slice(0, 3);

        for (const slug of slugs) {
            const page = await getText(ctx, `${SITE}${slug}`);
            if (!page) continue;
            const heading = /<title>([^<]*)/.exec(page)?.[1] ?? "";
            const named = /^(.*?)\s*\((\d{4})\)/.exec(heading);
            if (!named || slugify(named[1]!) !== wanted) continue;
            if (match.year && Math.abs(Number(named[2]) - match.year) > 1) continue;

            for (const id of pageLinks(page)) {
                const embed = await getText(ctx, `https://embed.jiofiles.pics/${id}`);
                const player = embed && /indbd\.pages\.dev\/embed\/([^/"'\s]+)\/([^/"'\s?]+)/.exec(embed);
                if (!player) continue;
                const [, host, video] = player;
                const body = await getText(ctx, `https://indbd.pages.dev/api/info?url=${encodeURIComponent(host!)}&id=${encodeURIComponent(video!)}`);
                if (!body) continue;
                let info: InfoResponse;
                try { info = JSON.parse(body) as InfoResponse; } catch { continue; }
                if (!info.success || !info.data) continue;
                const referrer = info.referer ?? `https://${host}/`;
                if (info.data.cfNativeDirect) yield { mediaUrl: info.data.cfNativeDirect, referrer };
            }
            return;
        }
    }
};

export default createScraper(movienestbdSite);
