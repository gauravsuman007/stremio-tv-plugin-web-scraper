import { chromium, type Request as PwRequest } from "playwright";
import { expandMasterPlaylist } from "./hls.js";
import type { ResolveOptions, ResolveResult, ServerResult } from "./types.js";

const BASE_URL = "https://cinejoy.pk";
const DEFAULT_TIMEOUT_MS = 25_000;

const MASTER_PLAYLIST_RE = /\.m3u8(\?.*)?$/i;
// Direct video files, but not fMP4/CMAF init or numbered segment fragments --
// those show up as their own .mp4/.m4s requests alongside (or instead of) a
// master playlist and aren't playable on their own.
const DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
const SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
/** how long to keep waiting after a direct-file candidate shows up, in case a master playlist follows it */
const FILE_CANDIDATE_GRACE_MS = 4_000;

interface ServerInfo {
    name: string;
    status: string;
}

async function listServers(): Promise<ServerInfo[]> {
    const res = await fetch("https://api.wing.st/servers");
    if (!res.ok) throw new Error(`Failed to list servers: ${res.status}`);
    const data = (await res.json()) as { servers: ServerInfo[] };
    return data.servers;
}

function watchUrl(opts: ResolveOptions): string {
    if (opts.mediaType === "movie") {
        return `${BASE_URL}/watch/movie/${opts.tmdbId}`;
    }
    if (opts.season == null || opts.episode == null) {
        throw new Error("season and episode are required for mediaType 'tv'");
    }
    return `${BASE_URL}/watch/tv/${opts.tmdbId}/${opts.season}/${opts.episode}`;
}

/**
 * Drives a real browser against cinejoy.pk's player: cinejoy resolves the
 * actual stream URL through an obfuscated, WASM-encrypted backend call
 * (api.wing.st/g, decoded client-side) that isn't practical to replicate
 * without a browser. Instead of reverse-engineering that, this watches the
 * browser's own network traffic for the media URL the player ends up
 * loading, per server.
 *
 * cinejoy's mirror pool is unreliable enough that "the player picked a URL"
 * and "that URL actually plays" are different things (dead/Cloudflare-
 * blocked mirrors are common). So each candidate is verified by actually
 * fetching it server-side before being accepted -- this probes servers one
 * at a time, in the order cinejoy itself lists them, and stops at the first
 * one that's genuinely playable unless `probeAll` is set.
 */
export async function resolveStreams(opts: ResolveOptions): Promise<ResolveResult> {
    const perServerTimeoutMs = opts.perServerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const servers = (await listServers()).filter((s) => s.status === "ok");

    const browser = await chromium.launch({ headless: !opts.headed });
    const servers_: ServerResult[] = [];
    const failedServers: string[] = [];

    try {
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();

        await page.goto(watchUrl(opts), { waitUntil: "domcontentloaded" });

        for (const server of servers) {
            const mediaUrl = await selectServerAndCapture(page, server.name, perServerTimeoutMs);
            if (!mediaUrl) {
                failedServers.push(server.name);
                continue;
            }

            // expandMasterPlaylist fetches the URL for real; if the mirror is
            // dead (Cloudflare block, timeout, garbage response) this throws
            // and the server is ruled out rather than reported as a hit.
            let qualities;
            try {
                qualities = await expandMasterPlaylist(mediaUrl);
            } catch {
                failedServers.push(server.name);
                continue;
            }

            servers_.push({ server: server.name, masterUrl: mediaUrl, qualities });
            if (!opts.probeAll) break;
        }
    } finally {
        await browser.close();
    }

    return {
        tmdbId: opts.tmdbId,
        mediaType: opts.mediaType,
        servers: servers_,
        failedServers,
    };
}

async function selectServerAndCapture(
    page: import("playwright").Page,
    serverName: string,
    timeoutMs: number,
): Promise<string | null> {
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

    // Listen at the request stage, not response: the mirror domains cinejoy
    // proxies to frequently lack CORS headers, so the browser's own player
    // requests fail before a response ever completes (no 'response' event
    // fires at all). The request itself still tells us the URL the player
    // was after -- and a plain Node fetch, unlike the browser, isn't subject
    // to CORS, so it can succeed where the in-page player couldn't.
    //
    // A master playlist always wins immediately if one shows up. A direct
    // file only wins after a short grace period with no playlist appearing --
    // segment/init fragments of an HLS stream are also plain .mp4 requests,
    // and racing ahead on the first one caught an init segment instead of the
    // real master playlist during testing.
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
        const serversButton = page.getByRole("button", { name: "Servers", exact: true });
        await serversButton.click();

        const serverOption = page.getByText(serverName, { exact: true }).first();
        await serverOption.click({ timeout: 5_000 });

        return await Promise.race([
            donePromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
    } catch {
        return null;
    } finally {
        page.off("request", onRequest);
        if (graceTimer) clearTimeout(graceTimer);
    }
}
