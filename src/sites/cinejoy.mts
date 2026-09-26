/**
 * cinejoy.pk -- the original site. Its stream URL comes back from a
 * WASM-encrypted backend call (`api.wing.st`), so the page is driven in a
 * browser: open the watch page, pick each up server in turn, and read the
 * media URL the player requests. See README.md's "Why browser automation".
 */
import type { Page } from "playwright-core";
import { captureMediaUrl, createScraper, type ScraperContext, type SiteAdapter } from "../shared.mts";

const BASE_URL = "https://cinejoy.pk";
const DEFAULT_PER_SERVER_TIMEOUT_MS = 20_000;

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

function selectServerAndCapture(page: Page, serverName: string, timeoutMs: number): Promise<string | null> {
    return captureMediaUrl(page, timeoutMs, async () => {
        await page.getByRole("button", { name: "Servers", exact: true }).click();
        await page.getByText(serverName, { exact: true }).first().click({ timeout: 5_000 });
    });
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
    maxQuality: "4K",
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


export default createScraper(cinejoySite);
