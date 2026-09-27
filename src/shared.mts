/**
 * What every site scraper shares: TMDB lookup, verifying/expanding the
 * playlist server-side, and `createScraper`, which turns an `HttpSite` into a
 * `WebLinkScraper`.
 *
 * Every shipped site is plain HTTP since 1.19.0 (`ctx.fetch`, already
 * VPN-aware), and since 1.20.0 nothing in the bundle needs Chromium or
 * playwright-core. The browser-driven capture the archived scrapers used
 * lives in ./browser.mts for research.
 */


/* The contract comes straight from the upstream repo, vendored as a git
 * submodule (vendor/web-links) and imported type-only: esbuild erases it, so
 * nothing from that repo ships in dist/, but `npm run check` fails the moment
 * upstream's contract and this file disagree. */
import type { ScraperContext, WebLink, WebLinkQuery, WebLinkScraper } from "../vendor/web-links/src/scraper.mts";

export type { ScraperContext };

const TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
const TMDB_BASE = "https://api.themoviedb.org/3";

const DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;

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
export function resolveTmdbMatch(query: WebLinkQuery, fetchImpl: ScraperContext["fetch"]): Promise<TmdbMatch | null> {
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

/** The headers the site's media hosts want: its Referer plus any extras (see `SiteBase.headers`). */
function mediaHeaders(site: { referrer: string; headers?: Record<string, string> }): Record<string, string> {
    return { Referer: site.referrer, ...site.headers };
}

async function expandMasterPlaylist(
    fetchImpl: ScraperContext["fetch"],
    masterUrl: string,
    headers: Record<string, string>
): Promise<{ resolution: string | null; bandwidth: number | null; url: string }[]> {
    if (DIRECT_FILE_RE.test(masterUrl)) {
        const response = await fetchImpl(masterUrl, { headers: { ...headers, Range: "bytes=0-1023" } });
        if (!response.ok) throw new Error(`direct file not fetchable: ${response.status}`);
        return [{ resolution: null, bandwidth: null, url: masterUrl }];
    }

    const response = await fetchImpl(masterUrl, { headers });
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

/** Shorter than any real film or episode: a playlist this short is a decoy or a stub. */
const MIN_PLAUSIBLE_DURATION_S = 300;

/**
 * Total runtime of a leaf playlist in seconds, or null when it isn't a finished
 * (VOD) playlist and so can't be judged. Some sites hand back a valid-looking
 * playlist for a title they don't have -- a ~90s clip whose segments are
 * really PNGs -- which passes a plain "is it HLS" check.
 */
async function leafDuration(fetchImpl: ScraperContext["fetch"], url: string, headers: Record<string, string>): Promise<number | null> {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`playlist not fetchable: ${response.status}`);
    const text = await response.text();
    if (!text.includes("#EXT-X-ENDLIST") && !text.includes("#EXT-X-PLAYLIST-TYPE:VOD")) return null;
    let total = 0;
    for (const match of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number.parseFloat(match[1]!);
    return total;
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

export interface SiteBase {
    /** Doubles as `WebLink.resolveId` (with `~<label>` for one server's row). */
    id: string;
    /** Shown on the result row. */
    name: string;
    /** Referer the site's media hosts expect. */
    referrer: string;
    /** Extra request headers the media hosts need beyond the Referer -- chiefly
     *  `Origin`, which some CDNs require too. Sent on this adapter's own
     *  playlist checks and set on the returned link so the host's relay sends
     *  them on every playlist and segment fetch (needs web-links >= 0.9.0). */
    headers?: Record<string, string>;
    /** The best resolution seen across the titles this adapter was tested on
     *  (see README.md). Shown in the scraper's name on the plugins page. */
    maxQuality: string;
    /** Cheap check run before anything else; false drops the site's rows. */
    available?(ctx: ScraperContext): Promise<boolean>;
}

/** A site with an open JSON API for its streams: plain `ctx.fetch`. */
export interface HttpSite extends SiteBase {
    /** Yields candidate media URLs, best first. Each is verified as it arrives. */
    httpCaptures(target: SiteTarget, ctx: ScraperContext): AsyncGenerator<Capture>;
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
/** A resolve at play time keeps looking this long for anything playable. */
const RESOLVE_DEADLINE_MS = 60_000;

interface Candidate {
    link: WebLink;
    score: number;
    height: number;
    label?: string;
}

/**
 * Checks one capture the way a player would meet it: the master (or the file)
 * fetches, its best variant is a finished playlist longer than a stub. Returns
 * the link to hand out, or null for a dead/blocked/decoy mirror.
 */
async function verifyCapture(site: SiteBase, { mediaUrl, label }: Capture, displayTitle: string, ctx: ScraperContext): Promise<Candidate | null> {
    const variants = await expandMasterPlaylist(ctx.fetch, mediaUrl, mediaHeaders(site)).catch(() => null);
    const top = variants?.[0]; // sorted by bandwidth, highest first.
    if (!variants || !top) return null;

    if (!DIRECT_FILE_RE.test(top.url)) {
        const duration = await leafDuration(ctx.fetch, top.url, mediaHeaders(site)).catch(() => 0);
        if (duration !== null && duration < MIN_PLAUSIBLE_DURATION_S) return null; // a stub, not the title.
    }

    const height = Math.max(...variants.map(variantHeight)) || heightFromUrl(mediaUrl);
    const score = height * 1e9 + Math.max(...variants.map((v) => v.bandwidth ?? 0));

    /*
        A REAL MASTER, WITH SOMETHING TO PICK BETWEEN, GOES THROUGH WHOLE --
        not flattened to its best variant, so the viewer keeps a say over the
        rendition. `web-links`' relay (`rewritePlaylist`) routes a master's
        variant lines back through itself like a leaf's segments. A
        single-variant result has nothing to pick between and goes out flat.
    */
    const resolutions = variants.map((v) => v.resolution).filter((r): r is string => Boolean(r));
    const multi = variants.length > 1;
    const mirror = label ? `${site.name} mirror: ${label}` : site.name;

    return {
        score,
        height,
        label,
        link: {
            url: multi ? mediaUrl : top.url,
            resolveKind: "hls",
            quality: resolutions.length
                ? `${resolutions.join("/")} · ${label ?? site.name}`
                : height
                  ? `${height}p · ${label ?? site.name}`
                  : mirror,
            title: displayTitle,
            referrer: site.referrer,
            ...(site.headers ? { headers: site.headers } : {}),
            ...(height ? { height } : {})
        }
    };
}

/**
 * Verifies every capture the site yields, CONCURRENTLY -- each check starts
 * the moment its capture arrives, so one slow mirror no longer holds up the
 * rest. Returns the playable ones, best first. Stops on a 2160p stream; once
 * anything plays, stops comparing `SOFT_DEADLINE_MS` after the start; and
 * gives up at `deadlineMs` regardless. `complete` is true when the answer is
 * conclusive (every server checked, or something found) -- false means the
 * deadline cut it short with nothing found yet.
 */
function collectCandidates(
    site: SiteBase,
    captures: AsyncGenerator<Capture>,
    displayTitle: string,
    ctx: ScraperContext,
    deadlineMs: number
): Promise<{ candidates: Candidate[]; complete: boolean }> {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const candidates: Candidate[] = [];
        let pending = 0;
        let exhausted = false;
        let finished = false;
        let softTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (complete: boolean) => {
            if (finished) return;
            finished = true;
            clearTimeout(hardTimer);
            clearTimeout(softTimer);
            void captures.return(undefined).catch(() => {}); // not awaited: it may queue behind a pending step.
            candidates.sort((a, b) => b.score - a.score);
            resolve({ candidates, complete: complete || candidates.length > 0 });
        };
        const hardTimer = setTimeout(() => finish(false), deadlineMs);

        const onCandidate = (candidate: Candidate) => {
            candidates.push(candidate);
            if (candidate.height >= BEST_POSSIBLE_HEIGHT) return finish(true);
            softTimer ??= setTimeout(() => finish(true), Math.max(0, SOFT_DEADLINE_MS - (Date.now() - startedAt)));
        };

        void (async () => {
            try {
                while (!finished) {
                    const step = await captures.next();
                    if (step.done || finished) break;
                    pending++;
                    void verifyCapture(site, step.value, displayTitle, ctx)
                        .catch(() => null)
                        .then((candidate) => {
                            pending--;
                            if (candidate && !finished) onCandidate(candidate);
                            if (exhausted && pending === 0) finish(true);
                        });
                }
            } catch {
                // a site's generator threw: judge by what it yielded so far.
            }
            exhausted = true;
            if (pending === 0) finish(true);
        })();
    });
}

/** Used by ./browser.mts's research scrapers: the best verified link, or null. */
export async function pickBestLink(site: SiteBase, captures: AsyncGenerator<Capture>, match: TmdbMatch, ctx: ScraperContext): Promise<WebLink | null> {
    const { candidates } = await collectCandidates(site, captures, displayName(match), ctx, RESOLVE_DEADLINE_MS);
    return candidates[0]?.link ?? null;
}

function displayName(match: TmdbMatch): string {
    return match.year ? `${match.title} (${match.year})` : match.title;
}

/*
    RESOLVED LINKS ARE KEPT BETWEEN SEARCH AND PLAY. Search now resolves (it
    has to, to know the quality), so the link it found is remembered here and
    handed back when that row is played -- after a quick check that its
    playlist still fetches, since how long each site's tokens live varies. A
    link that fails the check is resolved afresh. `LINK_MAX_AGE_MS` is only
    an upper bound on trusting a check that passed.
*/
const LINK_MAX_AGE_MS = 6 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const linkCache = new Map<string, { at: number; link: WebLink }>();

function linkKey(resolveId: string, query: WebLinkQuery): string {
    return `${resolveId}|${query.type}|${query.id}|${query.season ?? ""}|${query.episode ?? ""}`;
}

function rememberLinks(site: SiteBase, candidates: Candidate[], query: WebLinkQuery) {
    const now = Date.now();
    for (const [key, entry] of linkCache) if (now - entry.at > LINK_MAX_AGE_MS) linkCache.delete(key);
    if (candidates[0]) linkCache.set(linkKey(site.id, query), { at: now, link: candidates[0].link });
    for (const candidate of candidates) {
        if (candidate.label) linkCache.set(linkKey(`${site.id}~${candidate.label}`, query), { at: now, link: candidate.link });
    }
}

async function stillPlays(link: WebLink, ctx: ScraperContext): Promise<boolean> {
    try {
        const response = await ctx.fetch(link.url, {
            headers: { Referer: link.referrer ?? "", ...link.headers, ...(DIRECT_FILE_RE.test(link.url) ? { Range: "bytes=0-1023" } : {}) },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        });
        if (DIRECT_FILE_RE.test(link.url)) return response.ok;
        return response.ok && (await response.text()).trimStart().startsWith("#EXTM3U");
    } catch {
        return false;
    }
}

async function candidatesFor(site: HttpSite, query: WebLinkQuery, ctx: ScraperContext, deadlineMs: number) {
    const match = await resolveTmdbMatch(query, ctx.fetch);
    if (!match) return null;
    const target: SiteTarget = { match, season: query.season, episode: query.episode };
    const result = await collectCandidates(site, site.httpCaptures(target, ctx), displayName(match), ctx, deadlineMs);
    rememberLinks(site, result.candidates, query);
    return { match, ...result };
}

/**
 * PLAY TIME: the link search found for this row, if it still fetches;
 * otherwise a fresh resolve, preferring the row's own server (`<id>~<label>`)
 * and falling back to the site's best.
 */
async function resolveSite(site: HttpSite, resolveId: string, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink | null> {
    const cached = linkCache.get(linkKey(resolveId, query));
    if (cached && Date.now() - cached.at < LINK_MAX_AGE_MS && (await stillPlays(cached.link, ctx))) return cached.link;

    const found = await candidatesFor(site, query, ctx, RESOLVE_DEADLINE_MS);
    if (!found) return null;
    const label = resolveId.includes("~") ? resolveId.slice(resolveId.indexOf("~") + 1) : undefined;
    return (found.candidates.find((c) => label && c.label === label) ?? found.candidates[0])?.link ?? null;
}

/** At most this many rows per site: its best few servers, not every mirror. */
const MAX_ROWS_PER_SITE = 3;
/** Left of the host's search budget for its own work. */
const SEARCH_MARGIN_MS = 1_500;

/**
 * LIST TIME: resolves for real within the host's search budget, so each row
 * states the resolution its playlist actually carries rather than a guess --
 * one row per working server (up to `MAX_ROWS_PER_SITE`), best first. A site
 * that answered and has nothing playable shows no row at all. One that
 * didn't finish in time keeps today's placeholder row, resolved at play time.
 * Every row keeps a `resolveId`: the URL is looked up (and re-checked) when
 * played, never baked into the list.
 */
async function searchSite(site: HttpSite, query: WebLinkQuery, ctx: ScraperContext): Promise<WebLink[]> {
    if (site.available && !(await site.available(ctx).catch(() => false))) return [];

    const found = await candidatesFor(site, query, ctx, Math.max(3_000, ctx.budgetMs - SEARCH_MARGIN_MS));
    if (!found) return [];
    const title = `${displayName(found.match)} · ${site.name}`;

    if (!found.candidates.length) {
        return found.complete ? [] : [{ url: "", resolveId: site.id, resolveKind: "hls", title }];
    }

    const rows: WebLink[] = [];
    const seen = new Set<string>();
    for (const [index, candidate] of found.candidates.entries()) {
        // Only the best row may go unlabelled (it resolves to the site's best); any other needs its server's label.
        if (!candidate.label && index > 0) continue;
        const resolveId = candidate.label ? `${site.id}~${candidate.label}` : site.id;
        if (seen.has(resolveId) || seen.has(candidate.link.url)) continue;
        seen.add(resolveId).add(candidate.link.url);
        rows.push({ url: "", resolveId, resolveKind: "hls", title, quality: candidate.link.quality, ...(candidate.height ? { height: candidate.height } : {}) });
        if (rows.length >= MAX_ROWS_PER_SITE) break;
    }
    return rows;
}

/** No `version`: `src/index.mts` stamps package.json's onto every scraper it exports. */
export function createScraper(site: HttpSite): WebLinkScraper {
    return {
        id: site.id,
        name: `${site.name} · up to ${site.maxQuality}`,
        maxQuality: site.maxQuality,
        fetchMethod: "fast",
        search: (query, ctx) => searchSite(site, query, ctx),
        resolve: (resolveId, query, ctx) => resolveSite(site, resolveId, query, ctx)
    };
}
