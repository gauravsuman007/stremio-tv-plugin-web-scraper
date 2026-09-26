/**
 * The `WebLinkScraper` stremio-tv-plugin-web-links loads: wraps this
 * repo's cinejoy.pk search + per-quality resolver (`tmdb.ts`, `cinejoy.ts`,
 * `hls.ts`) behind the scraper contract from
 * `stremio-tv-plugin-web-links/templates/scraper-template.mts`.
 *
 * ONE SCRAPER, SEVERAL SITES
 * ---------------------------
 * The host loads exactly one scraper per repo `dist/`, so the other sites
 * that work the same way as cinejoy -- open a watch URL keyed by TMDB id in
 * a real browser, read the media URL the page's player requests -- are
 * `SiteAdapter`s inside this scraper rather than separate packages. Each
 * adapter only says how to reach its player and yields candidate media URLs;
 * capture, playlist verification and link building are shared. `search()`
 * returns one cheap placeholder per adapter and `resolve()` (play time) runs
 * the one the viewer picked, `resolveId` being the adapter's id.
 *
 * WHY THIS NEEDS A REAL BROWSER, AND WHAT THAT COSTS THE HOST
 * ----------------------------------------------------------
 * See README.md's "Why browser automation" -- cinejoy's stream URL comes
 * back from a WASM-encrypted backend call, so this drives a real headless
 * Chromium (via `playwright-core`, no bundled browser download) and reads
 * the URL the page's own player requests. That means this scraper needs an
 * actual Chromium binary on the host running stremio-tv, at
 * `CHROMIUM_PATH` (default `/usr/bin/chromium-browser`, Alpine's `apk add
 * chromium` path) -- see this plugin's own README for the Dockerfile
 * change that provides it. A dropped-in `.mjs` scraper can't bring its own
 * native browser binary, only JS -- `playwright-core` itself (13MB, no
 * dependencies of its own) ships as a real `node_modules/playwright-core`
 * directory alongside the compiled code (see `scripts/build.mjs`), not
 * bundled into this file: its own registry code resolves a few files
 * (`browsers.json`, its own `package.json`) relative to ITSELF at import
 * time, which breaks the moment that code is relocated inside a bundle.
 *
 * WHY THE BUILD OUTPUT IS `.cjs`, NOT `.mjs`
 * --------------------------------------------
 * `playwright-core` makes a handful of genuinely dynamic `require()` calls
 * that only work with a real, working `require` -- which a `.mjs` module
 * never has (Node gives module scripts no `require` at all). `web-links`'s
 * scraper loader reads a small `scraper.json` manifest (`{ id, entry,
 * version }`, the same idea as stremio-tv's own `plugin.json`) and loads
 * whatever `entry` names -- `.cjs` here -- rather than assuming `.mjs`.
 * See `stremio-tv-plugin-web-links/src/registry.mts`.
 *
 * VPN: every plain HTTP call here (TMDB search, the server list, expanding
 * an HLS master playlist) goes through `ctx.fetch`, already VPN-aware.
 * Chromium's own traffic is routed separately, via `ctx.proxyUrl`, passed
 * straight to Playwright's own `proxy` launch option -- `ctx.fetch` has no
 * way to intercept what a whole browser process does.
 */

import { chromium, type Page, type Request as PwRequest } from "playwright-core";
import { existsSync } from "node:fs";

/* The contract comes straight from the upstream repo, vendored as a git
 * submodule (vendor/web-links) and imported type-only: esbuild erases it, so
 * nothing from that repo ships in dist/, but `npm run check` fails the moment
 * upstream's contract and this file disagree. */
import type { ScraperContext, WebLink, WebLinkQuery, WebLinkScraper } from "../vendor/web-links/src/scraper.mts";

/* ---- cinejoy-specific pieces, adapted from tmdb.ts/cinejoy.ts/hls.ts -- */

const BASE_URL = "https://cinejoy.pk";
const TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
const TMDB_BASE = "https://api.themoviedb.org/3";
const DEFAULT_PER_SERVER_TIMEOUT_MS = 20_000;

const MASTER_PLAYLIST_RE = /\.m3u8(\?.*)?$/i;
const DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
const SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
const FILE_CANDIDATE_GRACE_MS = 4_000;

interface TmdbMultiResult {
    id: number;
    media_type: string;
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
}

interface TmdbMatch {
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

interface CinejoyServer {
    name: string;
    status: string;
    /** Cheap, list-time quality signal -- the only one available without
     *  driving a browser (see the module doc above `search()`). */
    "4k": boolean;
}

async function listServers(fetchImpl: ScraperContext["fetch"]): Promise<CinejoyServer[]> {
    const response = await fetchImpl("https://api.wing.st/servers");
    if (!response.ok) throw new Error(`Failed to list servers: ${response.status}`);
    const data = (await response.json()) as { servers: CinejoyServer[] };
    return data.servers;
}

function watchUrl(tmdbId: number, mediaType: "movie" | "tv", season?: number, episode?: number): string {
    if (mediaType === "movie") return `${BASE_URL}/watch/movie/${tmdbId}`;
    return `${BASE_URL}/watch/tv/${tmdbId}/${season ?? 1}/${episode ?? 1}`;
}

/**
 * Listens for the media URL the page's player requests, THEN runs `trigger`
 * (a click sequence, or the `goto` itself for a site that autoplays -- the
 * listener has to be attached before the load or the request is missed).
 */
async function captureMediaUrl(page: Page, timeoutMs: number, trigger: () => Promise<unknown>): Promise<string | null> {
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
        if (MASTER_PLAYLIST_RE.test(url)) {
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
        await trigger();

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

function selectServerAndCapture(page: Page, serverName: string, timeoutMs: number): Promise<string | null> {
    return captureMediaUrl(page, timeoutMs, async () => {
        await page.getByRole("button", { name: "Servers", exact: true }).click();
        await page.getByText(serverName, { exact: true }).first().click({ timeout: 5_000 });
    });
}

async function expandMasterPlaylist(
    fetchImpl: ScraperContext["fetch"],
    masterUrl: string,
    referrer: string
): Promise<{ resolution: string | null; bandwidth: number | null; url: string }[]> {
    if (!MASTER_PLAYLIST_RE.test(masterUrl)) {
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

async function resolveTmdbMatch(query: WebLinkQuery, fetchImpl: ScraperContext["fetch"]): Promise<TmdbMatch | null> {
    const wantType = query.type === "series" || query.type === "tv" ? "tv" : "movie";
    const imdbId = /^tt\d+/.exec(query.id)?.[0];
    if (imdbId) return tmdbFindByImdbId(fetchImpl, imdbId);

    const matches = await tmdbSearch(fetchImpl, query.title);
    return matches.find((m) => m.mediaType === wantType) ?? matches[0] ?? null;
}

/* ---- site adapters ---------------------------------------------------- */

interface SiteTarget {
    match: TmdbMatch;
    season?: number;
    episode?: number;
}

interface Capture {
    mediaUrl: string;
    /** Mirror/server name, when the site has several. */
    label?: string;
}

interface SiteAdapter {
    /** Doubles as `WebLink.resolveId`. */
    id: string;
    /** Shown on the result row. */
    name: string;
    /** Referer the site's media hosts expect. */
    referrer: string;
    /** Cheap, browser-free check run at list time; false drops the placeholder. */
    available?(ctx: ScraperContext): Promise<boolean>;
    /** Drives `page` and yields candidate media URLs, best first. The caller
     *  verifies each one and stops at the first that plays. */
    captures(page: Page, target: SiteTarget, ctx: ScraperContext): AsyncGenerator<Capture>;
}

const PAGE_LOAD_CAPTURE_TIMEOUT_MS = 20_000;

/** For a site whose player starts by itself: open `url`, take the first media request. */
async function* autoplayCapture(page: Page, url: string, ctx: ScraperContext): AsyncGenerator<Capture> {
    const timeoutMs = Math.min(PAGE_LOAD_CAPTURE_TIMEOUT_MS, Math.max(8_000, ctx.budgetMs));
    const mediaUrl = await captureMediaUrl(page, timeoutMs, () =>
        page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs })
    );
    if (mediaUrl) yield { mediaUrl };
}

/**
 * The original site. Tries every up server in turn, 4k-flagged ones first.
 *
 * SERVERS FLAGGED `4k` GO FIRST, BUT THIS IS A HINT, NOT A GUARANTEE.
 * `listServers` carries a site-wide capability flag, not a per-title one --
 * measured against a title with no 4K release at all, a 4k-flagged mirror
 * and a plain one served the identical 1080p/720p pair from the identical
 * URL, so the flag can be wrong for a given file. It still costs nothing to
 * ask the flagged mirror first: the caller already tries every server in
 * order until one plays, so trying the more-capable one first can only
 * ever help, never delay a title that has nothing higher to offer.
 */
const cinejoySite: SiteAdapter = {
    id: "cinejoy",
    name: "CineJoy",
    referrer: `${BASE_URL}/`,
    async available(ctx) {
        return (await listServers(ctx.fetch)).some((s) => s.status === "ok");
    },
    async *captures(page, { match, season, episode }, ctx) {
        const servers = (await listServers(ctx.fetch))
            .filter((s) => s.status === "ok")
            .sort((a, b) => Number(b["4k"]) - Number(a["4k"]));
        if (!servers.length) return;

        const perServerTimeoutMs = Math.min(DEFAULT_PER_SERVER_TIMEOUT_MS, Math.max(5_000, ctx.budgetMs / servers.length));

        await page.goto(watchUrl(match.tmdbId, match.mediaType, season, episode), {
            waitUntil: "domcontentloaded",
            timeout: perServerTimeoutMs
        });

        for (const server of servers) {
            const mediaUrl = await selectServerAndCapture(page, server.name, perServerTimeoutMs);
            if (mediaUrl) yield { mediaUrl, label: server.name };
        }
    }
};

/**
 * flixer.gd -- same `/watch/{movie|tv}/{tmdbId}[/s/e]` shape as cinejoy, but
 * no server picker: the player autoplays. Its stream URL is also derived by
 * a WASM module in the page, so it needs the browser just like cinejoy.
 * The media host serves the playlist with no special headers.
 *
 * The site injects malvertising (popunders, fake "install adblocker"
 * prompts); `resolve()` closes any popup tab, and nothing here ever clicks.
 */
const flixerSite: SiteAdapter = {
    id: "flixer",
    name: "Flixer",
    referrer: "https://flixer.gd/",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://flixer.gd/watch";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        yield* autoplayCapture(page, url, ctx);
    }
};

/**
 * bciney.to -- its own watch page just iframes `player.bciney.to`, so this
 * opens that player directly (the same player, without the ad-heavy
 * wrapper). It autoplays with `?autoplay=true`; the playlist comes back via
 * its own `v.bciney.to` proxy and needs no special headers.
 */
const bcineySite: SiteAdapter = {
    id: "bciney",
    name: "bCine",
    referrer: "https://player.bciney.to/",
    async *captures(page, { match, season, episode }, ctx) {
        const base = "https://player.bciney.to/embed";
        const url =
            match.mediaType === "movie"
                ? `${base}/movie/${match.tmdbId}?autoplay=true`
                : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}?autoplay=true`;
        yield* autoplayCapture(page, url, ctx);
    }
};

const SITES: SiteAdapter[] = [cinejoySite, flixerSite, bcineySite];

/** "auto" is what this scraper's earlier, cinejoy-only versions handed out. */
function siteFor(resolveId: string): SiteAdapter {
    return SITES.find((site) => site.id === resolveId) ?? cinejoySite;
}

/**
 * LIST TIME: cheap and fast, no browser -- just enough to know a site has
 * SOMETHING for this title (a real TMDB match, and for cinejoy at least one
 * server up). One placeholder per site, tagged with the site's name so its
 * origin is visible on the row -- not one per mirror. Which mirror actually
 * ends up serving the video is `resolve()`'s job entirely: trying every
 * mirror to find one that plays is exactly the kind of failure handling a
 * viewer shouldn't have to do by hand.
 */
async function search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]> {
    if (!findChromiumExecutable()) {
        console.warn("[cinejoy] no Chromium binary found (set CHROMIUM_PATH, or apk add chromium) -- skipping");
        return [];
    }

    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return [];

    const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;

    const placeholders = await Promise.all(
        SITES.map(async (site): Promise<WebLink | null> => {
            if (site.available && !(await site.available(ctx).catch(() => false))) return null;
            return { url: "", resolveId: site.id, resolveKind: "hls", title: `${displayTitle} · ${site.name}` };
        })
    );
    return placeholders.filter((link): link is WebLink => link !== null);
}

/** Highest resolution first, bandwidth as the tiebreak (and the only signal when a playlist states no resolution). */
function qualityScore(variant: { resolution: string | null; bandwidth: number | null }): number {
    const height = Number.parseInt(variant.resolution?.split("x")[1] ?? "0", 10) || 0;
    return height * 1e9 + (variant.bandwidth ?? 0);
}

/**
 * PLAY TIME: drives one browser through the chosen site's player, verifies
 * every capture it yields (every up server, for a multi-server site), and
 * returns the one with the best resolution -- so resolving a site's row
 * gives that site's best stream across all its servers, and a dead mirror
 * is simply skipped rather than left for the viewer to retry by hand.
 * Costs one player round trip per server (bounded by `ctx.budgetMs`), which
 * is the price of comparing them instead of taking the first that plays.
 */
async function resolve(resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null> {
    const executablePath = findChromiumExecutable();
    if (!executablePath) return null;

    const site = siteFor(resolveId);

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

        let best: { link: WebLink; score: number } | null = null;

        for await (const { mediaUrl, label } of site.captures(page, { match, season: query.season, episode: query.episode }, ctx)) {
            let variants;
            try {
                variants = await expandMasterPlaylist(ctx.fetch, mediaUrl, site.referrer);
            } catch {
                continue; // dead/blocked mirror -- try the next one.
            }

            const top = variants[0]; // sorted by bandwidth, highest first.
            if (!top) continue;

            const score = Math.max(...variants.map(qualityScore));
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
            const multi = MASTER_PLAYLIST_RE.test(mediaUrl) && variants.length > 1;
            const mirror = label ? `${site.name} mirror: ${label}` : site.name;

            best = {
                score,
                link: {
                    url: multi ? mediaUrl : top.url,
                    resolveKind: "hls",
                    quality: resolutions.length ? `${resolutions.join("/")} · ${label ?? site.name}` : mirror,
                    title: displayTitle,
                    referrer: site.referrer
                }
            };
        }

        if (best) return best.link;
        return null; // no server on this site produced a playable link.
    } finally {
        await browser.close();
    }
}

const cinejoyScraper: WebLinkScraper = {
    id: "cinejoy",
    name: "CineJoy",
    version: "1.6.0",
    search,
    resolve
};

export default cinejoyScraper;
