import { chromium } from "playwright";
import type { Page } from "playwright";
import { DEFAULT_TIMEOUT_MS, listServers, selectServerAndCapture, watchUrl } from "./cinejoy.js";
import { expandMasterPlaylist } from "./hls.js";
import { search } from "./tmdb.js";
import type { PlaybackTestOptions, PlaybackTestResult, ResumeVerification } from "./types.js";

const RESUME_SEEK_TOLERANCE_SECONDS = 5;
const PLAYBACK_START_POLL_MS = 250;

interface VideoState {
    currentTime: number;
    readyState: number;
    paused: boolean;
    error: string | null;
}

async function readVideoState(page: Page): Promise<VideoState | null> {
    return page.evaluate(() => {
        const v = document.querySelector("video");
        if (!v) return null;
        return {
            currentTime: v.currentTime,
            readyState: v.readyState,
            paused: v.paused,
            error: v.error ? `${v.error.code}: ${v.error.message}` : null,
        };
    });
}

/** Polls the page's own <video> element until it's actually advancing, not just until a URL was captured. */
async function waitForRealPlaybackStart(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = await readVideoState(page);
        if (state?.error) return false;
        if (state && state.currentTime > 0.1 && state.readyState >= 3) return true;
        await page.waitForTimeout(PLAYBACK_START_POLL_MS);
    }
    return false;
}

async function seekAndVerify(page: Page, seconds: number): Promise<ResumeVerification> {
    await page.evaluate((s) => {
        const v = document.querySelector("video");
        if (v) v.currentTime = s;
    }, seconds);

    // Give the player a moment to honor the seek and resume advancing from there.
    await page.waitForTimeout(2_000);
    const state = await readVideoState(page);
    const actualSeconds = state?.currentTime ?? null;
    const verified =
        actualSeconds != null && Math.abs(actualSeconds - seconds) <= RESUME_SEEK_TOLERANCE_SECONDS;

    return { requestedSeconds: seconds, actualSeconds, verified };
}

/**
 * End-to-end probe: search for a title, drive cinejoy's real player through
 * each server until one is actually playing video (not just until a media
 * URL was captured -- codec/mirror issues can still stall a page's <video>
 * even after the manifest itself checks out), and time the whole thing from
 * the search() call. Optionally seeks to `resumeSeconds` once playback
 * starts and confirms the seek stuck.
 */
export async function testPlayback(opts: PlaybackTestOptions): Promise<PlaybackTestResult> {
    const perServerTimeoutMs = opts.perServerTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();

    const results = await search(opts.title);
    const match = results.find((r) => !opts.mediaType || r.mediaType === opts.mediaType);
    if (!match) {
        return {
            title: opts.title,
            tmdbId: null,
            mediaType: null,
            server: null,
            waitMs: null,
            resume: null,
            error: "no search match",
        };
    }

    const browser = await chromium.launch({ headless: !opts.headed });
    try {
        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();

        await page.goto(
            watchUrl({
                tmdbId: match.tmdbId,
                mediaType: match.mediaType,
                season: opts.season,
                episode: opts.episode,
            }),
            { waitUntil: "domcontentloaded" },
        );

        const servers = (await listServers()).filter((s) => s.status === "ok");
        for (const server of servers) {
            const mediaUrl = await selectServerAndCapture(page, server.name, perServerTimeoutMs);
            if (!mediaUrl) continue;

            try {
                await expandMasterPlaylist(mediaUrl);
            } catch {
                continue;
            }

            const started = await waitForRealPlaybackStart(page, perServerTimeoutMs);
            if (!started) continue;

            const waitMs = Date.now() - t0;
            const resume = opts.resumeSeconds != null ? await seekAndVerify(page, opts.resumeSeconds) : null;

            return {
                title: opts.title,
                tmdbId: match.tmdbId,
                mediaType: match.mediaType,
                server: server.name,
                waitMs,
                resume,
            };
        }

        return {
            title: opts.title,
            tmdbId: match.tmdbId,
            mediaType: match.mediaType,
            server: null,
            waitMs: null,
            resume: null,
            error: "no server produced real playback",
        };
    } finally {
        await browser.close();
    }
}
