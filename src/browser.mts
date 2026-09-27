/**
 * Browser-driven capture, kept for RESEARCH and the archived scrapers under
 * ./sites/archive -- no shipped scraper uses it since 1.19.0, and it is not
 * part of the bundle (src/index.mts never reaches this file), so dist/ no
 * longer ships playwright-core. It drives a real headless Chromium (via
 * `playwright-core`, no bundled browser download) and reads the URL the
 * page's own player requests. Needs a Chromium binary at `CHROMIUM_PATH`
 * (default `/usr/bin/chromium-browser`). Chromium's traffic goes via
 * `ctx.proxyUrl`, Playwright's `proxy` launch option.
 */

import { chromium, type Page, type Request as PwRequest } from "playwright-core";
import { existsSync } from "node:fs";
import type { WebLinkScraper } from "../vendor/web-links/src/scraper.mts";
import { pickBestLink, resolveTmdbMatch, type ScraperContext, type SiteBase, type Capture, type SiteTarget } from "./shared.mts";

/** `.m3u8` at the end, before a query, or -- for a playlist wrapped in a relay's `?url=...&exp=...` -- before the next parameter. */
const MASTER_PLAYLIST_RE = /\.m3u8(?:[?&#].*)?$/i;
const DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
const SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
const FILE_CANDIDATE_GRACE_MS = 4_000;
/** Trailers and previews some sites autoplay before the real player starts. */
const IGNORED_MEDIA_RE = /media-imdb\.com|youtube\.com|ytimg\.com|googlevideo\.com/i;

export interface CaptureOptions {
    /** What counts as a playlist URL, for a site whose playlists lack a `.m3u8` extension. */
    isPlaylist?: RegExp;
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

/** A site whose stream only comes out of page-side code: drives a real browser. */
export interface BrowserSite extends SiteBase {
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


/** For research only: a scraper that resolves through Chromium on every call. */
export function createBrowserScraper(site: BrowserSite): WebLinkScraper {
    return {
        id: site.id,
        name: `${site.name} · up to ${site.maxQuality}`,
        maxQuality: site.maxQuality,
        fetchMethod: "slow",
        async search(query, ctx) {
            const match = await resolveTmdbMatch(query, ctx.fetch);
            if (!match) return [];
            const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
            return [{ url: "", resolveId: site.id, resolveKind: "hls", title: `${displayTitle} · ${site.name}` }];
        },
        async resolve(_resolveId, query, ctx) {
            const match = await resolveTmdbMatch(query, ctx.fetch);
            const executablePath = findChromiumExecutable();
            if (!match || !executablePath) return null;
            const target: SiteTarget = { match, season: query.season, episode: query.episode };
            const browser = await chromium.launch({
                headless: true,
                executablePath,
                args: ["--no-sandbox", "--disable-dev-shm-usage"],
                proxy: ctx.proxyUrl ? { server: ctx.proxyUrl } : undefined
            });
            try {
                const context = await browser.newContext({
                    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
                });
                const page = await context.newPage();
                context.on("page", (popup) => void popup.close().catch(() => {}));
                return await pickBestLink(site, site.captures(page, target, ctx), match, ctx);
            } finally {
                await browser.close();
            }
        }
    };
}
