/**
 * The `WebLinkScraper` stremio-tv-plugin-web-links loads: wraps this
 * repo's existing cinejoy.pk search + per-quality resolver (`tmdb.ts`,
 * `cinejoy.ts`, `hls.ts`) behind the scraper contract from
 * `stremio-tv-plugin-web-links/templates/scraper-template.mts`.
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

/* ---- the contract this file implements (kept in sync by hand with
 *      stremio-tv-plugin-web-links/src/scraper.mts) ------------------- */

interface WebLinkQuery {
    type: string;
    id: string;
    title: string;
    year?: number;
    season?: number;
    episode?: number;
}

interface WebLink {
    url: string;
    /** See `stremio-tv-plugin-web-links/src/scraper.mts`'s module doc. Set
     *  on every result `search()` returns here -- see the note above
     *  `search()` below for why. */
    resolveId?: string;
    quality?: string;
    title?: string;
    size?: string;
    labels?: string[];
    referrer?: string;
    userAgent?: string;
}

interface ScraperContext {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    budgetMs: number;
    /** The household VPN's HTTP proxy address, when one is configured --
     *  handed straight to Playwright's own `proxy` launch option, since a
     *  whole browser process's traffic can't be routed through `ctx.fetch`. */
    proxyUrl?: string;
}

interface WebLinkScraper {
    id: string;
    name: string;
    version?: string;
    search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]>;
    resolve(resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null>;
}

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

async function selectServerAndCapture(page: Page, serverName: string, timeoutMs: number): Promise<string | null> {
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
        await page.getByRole("button", { name: "Servers", exact: true }).click();
        await page.getByText(serverName, { exact: true }).first().click({ timeout: 5_000 });

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
    masterUrl: string
): Promise<{ resolution: string | null; bandwidth: number | null; url: string }[]> {
    if (!MASTER_PLAYLIST_RE.test(masterUrl)) {
        const response = await fetchImpl(masterUrl, { headers: { Referer: `${BASE_URL}/`, Range: "bytes=0-1023" } });
        if (!response.ok) throw new Error(`direct file not fetchable: ${response.status}`);
        return [{ resolution: null, bandwidth: null, url: masterUrl }];
    }

    const response = await fetchImpl(masterUrl, { headers: { Referer: `${BASE_URL}/` } });
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

/**
 * LIST TIME: cheap and fast, no browser -- just enough to know cinejoy has
 * SOMETHING for this title (a real TMDB match and at least one server up).
 * One placeholder only, tagged with this scraper's own name so its origin
 * is visible on the row -- not one per mirror. Which mirror actually ends
 * up serving the video is `resolve()`'s job entirely (see below): trying
 * every mirror to find one that plays is exactly the kind of failure
 * handling a viewer shouldn't have to do by hand, clicking through four
 * near-identical rows to find the one that isn't dead.
 */
async function search(query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]> {
    if (!findChromiumExecutable()) {
        console.warn("[cinejoy] no Chromium binary found (set CHROMIUM_PATH, or apk add chromium) -- skipping");
        return [];
    }

    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return [];

    const servers = (await listServers(ctx.fetch)).filter((s) => s.status === "ok");
    if (!servers.length) return [];

    const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;

    return [
        {
            url: "",
            resolveId: "auto",
            resolveKind: "hls",
            title: `${displayTitle} · CineJoy`
        }
    ];
}

/**
 * PLAY TIME: drives one browser through cinejoy's watch page and tries
 * every up server in turn -- picking the FIRST one that both yields a
 * captured media URL and expands into a real, fetchable playlist -- rather
 * than committing to a single mirror at list time and leaving the viewer to
 * retry by hand if it happens to be the one that's down. `resolveId` is
 * unused: there is only ever one candidate now (see `search()` above), so
 * there is nothing for it to select between.
 */
async function resolve(_resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null> {
    const executablePath = findChromiumExecutable();
    if (!executablePath) return null;

    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return null;

    const servers = (await listServers(ctx.fetch)).filter((s) => s.status === "ok");
    if (!servers.length) return null;

    const perServerTimeoutMs = Math.min(DEFAULT_PER_SERVER_TIMEOUT_MS, Math.max(5_000, ctx.budgetMs / servers.length));

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

        await page.goto(watchUrl(match.tmdbId, match.mediaType, query.season, query.episode), {
            waitUntil: "domcontentloaded",
            timeout: perServerTimeoutMs
        });

        const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;

        for (const server of servers) {
            const mediaUrl = await selectServerAndCapture(page, server.name, perServerTimeoutMs);
            if (!mediaUrl) continue; // this mirror never produced a media URL -- try the next one.

            let variants;
            try {
                variants = await expandMasterPlaylist(ctx.fetch, mediaUrl);
            } catch {
                continue; // dead/blocked mirror -- try the next one.
            }

            const best = variants[0]; // sorted by bandwidth, highest first.
            if (!best) continue;

            return {
                url: best.url,
                resolveKind: "hls",
                quality: best.resolution ? `${best.resolution} · ${server.name}` : `CineJoy mirror: ${server.name}`,
                title: displayTitle,
                referrer: `${BASE_URL}/`
            };
        }

        return null; // every up server failed to produce a playable link.
    } finally {
        await browser.close();
    }
}

const cinejoyScraper: WebLinkScraper = {
    id: "cinejoy",
    name: "CineJoy",
    version: "1.3.0",
    search,
    resolve
};

export default cinejoyScraper;
