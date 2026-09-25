import { chromium, type Request as PwRequest } from "playwright";
import { expandMasterPlaylist } from "./hls.js";
import type { ResolveOptions, ResolveResult, ServerResult } from "./types.js";

const BASE_URL = "https://cinejoy.pk";
const DEFAULT_TIMEOUT_MS = 25_000;

const MEDIA_URL_RE = /\.(m3u8|mp4|mkv|webm)(\?.*)?$/i;

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

            try {
                const qualities = await expandMasterPlaylist(mediaUrl);
                servers_.push({ server: server.name, masterUrl: mediaUrl, qualities });
            } catch {
                // Couldn't expand the playlist server-side (mirror already died,
                // or it wasn't an HLS master to begin with) -- still hand back
                // the raw URL the player itself used.
                servers_.push({
                    server: server.name,
                    masterUrl: mediaUrl,
                    qualities: [{ resolution: null, bandwidth: null, url: mediaUrl }],
                });
            }
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
    let resolveMedia: (url: string) => void;
    const mediaUrlPromise = new Promise<string>((resolve) => {
        resolveMedia = resolve;
    });

    // Listen at the request stage, not response: the mirror domains cinejoy
    // proxies to frequently lack CORS headers, so the browser's own player
    // requests fail before a response ever completes (no 'response' event
    // fires at all). The request itself still tells us the URL the player
    // was after -- and a plain Node fetch, unlike the browser, isn't subject
    // to CORS, so it can succeed where the in-page player couldn't.
    const onRequest = (request: PwRequest) => {
        const url = request.url();
        if (MEDIA_URL_RE.test(url)) resolveMedia(url);
    };
    page.on("request", onRequest);

    try {
        const serversButton = page.getByRole("button", { name: "Servers", exact: true });
        await serversButton.click();

        const serverOption = page.getByText(serverName, { exact: true }).first();
        await serverOption.click({ timeout: 5_000 });

        return await Promise.race([
            mediaUrlPromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
    } catch {
        return null;
    } finally {
        page.off("request", onRequest);
    }
}
