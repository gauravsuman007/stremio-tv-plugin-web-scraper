/**
 * What every site scraper shares: TMDB lookup, watching a page for the media
 * URL its player requests, verifying/expanding the playlist server-side, and
 * `createScraper`, which turns a `SiteAdapter` into a `WebLinkScraper`.
 *
 * WHY THESE NEED A REAL BROWSER, AND WHAT THAT COSTS THE HOST
 * ----------------------------------------------------------
 * See README.md's "Why browser automation" -- the stream URL comes out of
 * page-side code (WASM, or a player that only starts in a browser), so this
 * drives a real headless Chromium (via `playwright-core`, no bundled browser
 * download) and reads the URL the page's own player requests. That needs an
 * actual Chromium binary on the host running stremio-tv, at `CHROMIUM_PATH`
 * (default `/usr/bin/chromium-browser`, Alpine's `apk add chromium` path).
 * `playwright-core` ships as a real `node_modules/playwright-core` directory
 * next to the compiled code (see `scripts/build.mjs`), not bundled: its own
 * registry code resolves files relative to ITSELF at import time, which
 * breaks once relocated inside a bundle -- and it makes dynamic `require()`
 * calls, which is why the build output is `.cjs`.
 *
 * VPN: every plain HTTP call here (TMDB, playlists) goes through `ctx.fetch`,
 * already VPN-aware. Chromium's own traffic is routed via `ctx.proxyUrl`,
 * passed to Playwright's `proxy` launch option.
 */

import { chromium, type Page, type Request as PwRequest } from "playwright-core";
import { existsSync } from "node:fs";

/* The contract comes straight from the upstream repo, vendored as a git
 * submodule (vendor/web-links) and imported type-only: esbuild erases it, so
 * nothing from that repo ships in dist/, but `npm run check` fails the moment
 * upstream's contract and this file disagree. */
import type { ScraperContext, WebLink, WebLinkQuery, WebLinkScraper } from "../vendor/web-links/src/scraper.mts";

export type { ScraperContext };

const TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
const TMDB_BASE = "https://api.themoviedb.org/3";

const MASTER_PLAYLIST_RE = /\.m3u8(\?.*)?$/i;
const DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
const SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
const FILE_CANDIDATE_GRACE_MS = 4_000;
/** Trailers and previews some sites autoplay before the real player starts. */
const IGNORED_MEDIA_RE = /media-imdb\.com|youtube\.com|ytimg\.com|googlevideo\.com/i;

export interface CaptureOptions {
    /** What counts as a playlist URL, for a site whose playlists lack a `.m3u8` extension. */
    isPlaylist?: RegExp;
}

interface TmdbMultiResult {
    id: number;
    media_type: string;
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
}

export interface TmdbMatch {
    tmdbId: number;
    mediaType: "movie" | "tv";
    /** The real title, e.g. "Zootopia" -- NOT `query.title`, which is only
     *  ever the raw content id (see `resolveTmdbMatch`'s doc comment). This
     *  is what a result's display name is actually built from. */
    title: string;
    year: number | null;
}

async function tmdbSearch(fetchImpl: ScraperContext["fetch"], query: string): Promise<TmdbMatch[]> {
    const url = new URL(`${TMDB_BASE}/search/multi`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("language", "en-US");
    url.searchParams.set("query", query);
    url.searchParams.set("include_adult", "false");

    const response = await fetchImpl(url.toString());
    if (!response.ok) throw new Error(`TMDB search failed: ${response.status}`);

    const data = (await response.json()) as { results: TmdbMultiResult[] };
    const results: TmdbMatch[] = [];

    for (const r of data.results) {
        if (r.media_type !== "movie" && r.media_type !== "tv") continue;
        const dateStr = r.media_type === "movie" ? r.release_date : r.first_air_date;
        const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
        const title = (r.media_type === "movie" ? r.title : r.name) || query;
        results.push({ tmdbId: r.id, mediaType: r.media_type, title, year: Number.isFinite(year) ? year : null });
    }
    return results;
}

/**
 * stremio-tv's `extraStreamsFor` hands a plugin the raw content id (an
 * IMDb id for anything from Torrentio-shaped addons) and NOT the title --
 * see `stremio-tv-plugin-web-links/src/plugin.mts`'s own note on this gap.
 * A free-text TMDB search for the literal string "tt1375666" obviously
 * finds nothing, so when `query.id` looks like an IMDb id this resolves it
 * directly via TMDB's "find by external id" endpoint instead of ever
 * falling back to searching for the id itself.
 */
async function tmdbFindByImdbId(fetchImpl: ScraperContext["fetch"], imdbId: string): Promise<TmdbMatch | null> {
    const url = new URL(`${TMDB_BASE}/find/${imdbId}`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("external_source", "imdb_id");

    const response = await fetchImpl(url.toString());
    if (!response.ok) throw new Error(`TMDB find failed: ${response.status}`);

    const data = (await response.json()) as { movie_results: TmdbMultiResult[]; tv_results: TmdbMultiResult[] };
    const movie = data.movie_results[0];
    if (movie) {
        const year = movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : null;
        return { tmdbId: movie.id, mediaType: "movie", title: movie.title || imdbId, year: Number.isFinite(year) ? year : null };
    }

    const tv = data.tv_results[0];
    if (tv) {
        const year = tv.first_air_date ? Number.parseInt(tv.first_air_date.slice(0, 4), 10) : null;
        return { tmdbId: tv.id, mediaType: "tv", title: tv.name || imdbId, year: Number.isFinite(year) ? year : null };
    }

    return null;
}


const MATCH_TTL_MS = 60_000;
const matchCache = new Map<string, { at: number; match: Promise<TmdbMatch | null> }>();

/** The host runs every scraper for the same title at once; share one TMDB lookup between them. */
function resolveTmdbMatch(query: WebLinkQuery, fetchImpl: ScraperContext["fetch"]): Promise<TmdbMatch | null> {
    const key = `${query.type}|${query.id}|${query.title}`;
    const cached = matchCache.get(key);
    if (cached && Date.now() - cached.at < MATCH_TTL_MS) return cached.match;

    const match = lookupTmdbMatch(query, fetchImpl);
    matchCache.set(key, { at: Date.now(), match });
    match.catch(() => matchCache.delete(key));
    return match;
}

async function lookupTmdbMatch(query: WebLinkQuery, fetchImpl: ScraperContext["fetch"]): Promise<TmdbMatch | null> {
    const wantType = query.type === "series" || query.type === "tv" ? "tv" : "movie";
    const imdbId = /^tt\d+/.exec(query.id)?.[0];
    if (imdbId) return tmdbFindByImdbId(fetchImpl, imdbId);

    const matches = await tmdbSearch(fetchImpl, query.title);
    return matches.find((m) => m.mediaType === wantType) ?? matches[0] ?? null;
}


/**
 * Listens for the media URL the page's player requests, THEN runs `trigger`
 * (a click sequence, or the `goto` itself for a site that autoplays -- the
 * listener has to be attached before the load or the request is missed).
 */
export async function captureMediaUrl(
    page: Page,
    timeoutMs: number,
    trigger: (isDone: () => boolean) => Promise<unknown>,
    options: CaptureOptions = {}
): Promise<string | null> {
    const playlistRe = options.isPlaylist ?? MASTER_PLAYLIST_RE;
    let resolveMedia: (url: string | null) => void;
    const donePromise = new Promise<string | null>((resolve) => {
        resolveMedia = resolve;
    });

    let fileCandidate: string | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = (url: string | null) => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        resolveMedia(url);
    };

    const onRequest = (request: PwRequest) => {
        const url = request.url();
        if (IGNORED_MEDIA_RE.test(url)) return;
        if (playlistRe.test(url)) {
            settle(url);
            return;
        }
        if (!fileCandidate && DIRECT_FILE_RE.test(url) && !SEGMENT_OR_INIT_RE.test(url)) {
            fileCandidate = url;
            graceTimer = setTimeout(() => settle(fileCandidate), FILE_CANDIDATE_GRACE_MS);
        }
    };
    page.on("request", onRequest);

    try {
        await trigger(() => settled);

        return await Promise.race([
            donePromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
        ]);
    } catch {
        return null;
    } finally {
        page.off("request", onRequest);
        if (graceTimer) clearTimeout(graceTimer);
    }
}


async function expandMasterPlaylist(
    fetchImpl: ScraperContext["fetch"],
    masterUrl: string,
    referrer: string
): Promise<{ resolution: string | null; bandwidth: number | null; url: string }[]> {
    if (DIRECT_FILE_RE.test(masterUrl)) {
        const response = await fetchImpl(masterUrl, { headers: { Referer: referrer, Range: "bytes=0-1023" } });
        if (!response.ok) throw new Error(`direct file not fetchable: ${response.status}`);
        return [{ resolution: null, bandwidth: null, url: masterUrl }];
    }

    const response = await fetchImpl(masterUrl, { headers: { Referer: referrer } });
    if (!response.ok) throw new Error(`master playlist not fetchable: ${response.status}`);

    const text = await response.text();
    if (!text.startsWith("#EXTM3U")) throw new Error("not a valid HLS playlist");
    if (!text.includes("#EXT-X-STREAM-INF")) return [{ resolution: null, bandwidth: null, url: masterUrl }];

    const lines = text.split(/\r?\n/);
    const variants: { resolution: string | null; bandwidth: number | null; url: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.startsWith("#EXT-X-STREAM-INF")) continue;
        const uriLine = lines[i + 1]?.trim();
        if (!uriLine || uriLine.startsWith("#")) continue;

        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);

        variants.push({
            resolution: resolutionMatch?.[1] ?? null,
            bandwidth: bandwidthMatch?.[1] ? Number.parseInt(bandwidthMatch[1], 10) : null,
            url: new URL(uriLine, masterUrl).toString()
        });
    }

    if (!variants.length) return [{ resolution: null, bandwidth: null, url: masterUrl }];

    variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    return variants;
}

/** Alpine's `apk add chromium` package name, or an override for a
 *  differently-built host. See this repo's README for the Dockerfile side
 *  of this contract. */
function findChromiumExecutable(): string | undefined {
    const override = process.env.CHROMIUM_PATH;
    if (override && existsSync(override)) return override;

    for (const candidate of ["/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}


/* ---- site adapters ---------------------------------------------------- */

export interface SiteTarget {
    match: TmdbMatch;
    season?: number;
    episode?: number;
}

export interface Capture {
    mediaUrl: string;
    /** Mirror/server name, when the site has several. */
    label?: string;
}

export interface SiteAdapter {
    /** Doubles as `WebLink.resolveId`. */
    id: string;
    /** Shown on the result row. */
    name: string;
    /** Referer the site's media hosts expect. */
    referrer: string;
    /** The best resolution seen across the titles this adapter was tested on
     *  (see README.md). Shown in the scraper's name on the plugins page. */
    maxQuality: string;
    /** Cheap, browser-free check run at list time; false drops the placeholder. */
    available?(ctx: ScraperContext): Promise<boolean>;
    /** Drives `page` and yields candidate media URLs, best first. The caller
     *  verifies each one and stops at the first that plays. */
    captures(page: Page, target: SiteTarget, ctx: ScraperContext): AsyncGenerator<Capture>;
}

const PAGE_LOAD_CAPTURE_TIMEOUT_MS = 20_000;

export interface AutoplayOptions extends CaptureOptions {
    /** The player waits for a Play click. Popunder ads hijack the first clicks
     *  by navigating the page away, so navigations are blocked once it loads. */
    clickPlay?: boolean;
}

/** Open `url` in a player that starts by itself (or after a Play click) and take the first media request. */
export async function* autoplayCapture(
    page: Page,
    url: string,
    ctx: ScraperContext,
    options: AutoplayOptions = {}
): AsyncGenerator<Capture> {
    const timeoutMs = Math.min(PAGE_LOAD_CAPTURE_TIMEOUT_MS, Math.max(8_000, ctx.budgetMs));
    const mediaUrl = await captureMediaUrl(
        page,
        timeoutMs,
        async (isDone) => {
            if (!options.clickPlay) {
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
                return;
            }

            let armed = false;
            await page.route("**/*", (route) => {
                const request = route.request();
                return armed && request.isNavigationRequest() && request.frame() === page.mainFrame()
                    ? route.abort()
                    : route.continue();
            });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
            armed = true;

            for (let attempt = 0; attempt < 4 && !isDone(); attempt++) {
                await page.locator('button:has-text("Play"), a:has-text("Play")').first().click({ timeout: 2_500, force: true }).catch(() => {});
                await page.waitForTimeout(4_000);
            }
        },
        options
    );
    if (mediaUrl) yield { mediaUrl };
}

function variantHeight(variant: { resolution: string | null }): number {
    return Number.parseInt(variant.resolution?.split("x")[1] ?? "0", 10) || 0;
}

/** A leaf playlist states no resolution, but some sites put it in the URL (e.g. `index-s1080p-v1.m3u8`). */
function heightFromUrl(url: string): number {
    return Number.parseInt(/[-_/.]s?(\d{3,4})p(?=[-_/.?]|$)/i.exec(url)?.[1] ?? "0", 10) || 0;
}

/** A 2160p stream can't be beaten, so nothing after it is worth waiting for. */
const BEST_POSSIBLE_HEIGHT = 2160;
/** Once something plays, stop comparing further servers after this long. With nothing playable yet, keep looking. */
const SOFT_DEADLINE_MS = 10_000;


/**
 * PLAY TIME: drives one browser through the chosen site's player, verifies
 * each capture it yields (every up server, for a multi-server site), and
 * returns the one with the best resolution, so a dead mirror is skipped
 * rather than left for the viewer to retry by hand. It stops early on a
 * 2160p stream, and once anything plays it stops comparing after
 * `SOFT_DEADLINE_MS`; until something plays it keeps going through the
 * remaining servers.
 */
async function resolveSite(site: SiteAdapter, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null> {
    const executablePath = findChromiumExecutable();
    if (!executablePath) return null;

    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return null;

    const browser = await chromium.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        proxy: ctx.proxyUrl ? { server: ctx.proxyUrl } : undefined
    });

    try {
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        });
        const page = await context.newPage();
        context.on("page", (popup) => void popup.close().catch(() => {}));

        const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;

        let best: { link: WebLink; score: number; height: number } | null = null;
        const startedAt = Date.now();
        const captures = site.captures(page, { match, season: query.season, episode: query.episode }, ctx);

        try {
            while (true) {
                const pending = captures.next();
                pending.catch(() => {}); // may be abandoned at the deadline; the browser closing settles it.

                let step: IteratorResult<Capture> | null;
                if (best) {
                    const remainingMs = SOFT_DEADLINE_MS - (Date.now() - startedAt);
                    if (remainingMs <= 0) break;
                    step = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), remainingMs))]);
                } else {
                    step = await pending;
                }
                if (!step || step.done) break;

                const { mediaUrl, label } = step.value;

                let variants;
                try {
                    variants = await expandMasterPlaylist(ctx.fetch, mediaUrl, site.referrer);
                } catch {
                    continue; // dead/blocked mirror -- try the next one.
                }

                const top = variants[0]; // sorted by bandwidth, highest first.
                if (!top) continue;

                const height = Math.max(...variants.map(variantHeight)) || heightFromUrl(mediaUrl);
                const score = height * 1e9 + Math.max(...variants.map((v) => v.bandwidth ?? 0));
                if (best && score <= best.score) continue;

                /*
                    A REAL MASTER, WITH SOMETHING TO PICK BETWEEN, GOES THROUGH
                    WHOLE -- not flattened to its best variant. Measured: these
                    sites' own master playlists commonly carry two or three
                    resolutions (1080p and 720p, here), which is exactly the
                    shape a viewer might want a say over rather than always
                    getting the top one silently. `web-links`' own relay
                    (`rewritePlaylist`) already knows how to route a master's
                    variant lines back through itself, same as it does for a
                    leaf playlist's segments -- see its own doc comment. A
                    single-variant result (a plain file, or a master with only
                    one rendition) has nothing to pick between, so it keeps
                    going out flattened exactly as before.
                */
                const resolutions = variants.map((v) => v.resolution).filter((r): r is string => Boolean(r));
                const multi = variants.length > 1;
                const mirror = label ? `${site.name} mirror: ${label}` : site.name;

                best = {
                    score,
                    height,
                    link: {
                        url: multi ? mediaUrl : top.url,
                        resolveKind: "hls",
                        quality: resolutions.length
                            ? `${resolutions.join("/")} · ${label ?? site.name}`
                            : height
                              ? `${height}p · ${label ?? site.name}`
                              : mirror,
                        title: displayTitle,
                        referrer: site.referrer
                    }
                };

                if (best.height >= BEST_POSSIBLE_HEIGHT) break;
            }
        } finally {
            void captures.return(undefined).catch(() => {}); // not awaited: it queues behind an abandoned pending step.
        }

        if (best) return best.link;
        return null; // no server on this site produced a playable link.
    } finally {
        await browser.close();
    }
}

/**
 * LIST TIME: cheap and fast, no browser -- just enough to know the site has
 * SOMETHING for this title (a real TMDB match, and whatever cheap check the
 * site offers). One placeholder row, tagged with the site's name. Which
 * server actually ends up serving the video is `resolve()`'s job entirely.
 */
async function searchSite(site: SiteAdapter, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]> {
    if (!findChromiumExecutable()) {
        console.warn(`[${site.id}] no Chromium binary found (set CHROMIUM_PATH, or apk add chromium) -- skipping`);
        return [];
    }

    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return [];

    if (site.available && !(await site.available(ctx).catch(() => false))) return [];

    const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
    return [{ url: "", resolveId: site.id, resolveKind: "hls", title: `${displayTitle} · ${site.name}` }];
}

/** No `version`: `src/index.mts` stamps package.json's onto every scraper it exports. */
export function createScraper(site: SiteAdapter): WebLinkScraper {
    return {
        id: site.id,
        name: `${site.name} · up to ${site.maxQuality}`,
        search: (query, ctx) => searchSite(site, query, ctx),
        resolve: (_resolveId, query, ctx) => resolveSite(site, query, ctx)
    };
}
