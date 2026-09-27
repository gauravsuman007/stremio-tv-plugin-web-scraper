/**
 * Getting past a Cloudflare/Turnstile challenge page -- see AGENTS.md's
 * "Getting past Cloudflare/Turnstile with FlareSolverr" for the house rules
 * (this is a research-time tool, not something shipped to a scraper's
 * runtime path unless the site truly needs a fresh solve per resolve).
 *
 * Two ways to get a solve, behind one shape (`FlareSolverrResult`) so a
 * caller doesn't care which one ran:
 *   - `solveInProcess`: drives this repo's own Playwright/Chromium (the same
 *     binary `shared.mts` uses for BrowserSite scrapers) and waits out the
 *     challenge itself.
 *   - `solveViaContainer`: talks to a real FlareSolverr container's `/v1`
 *     HTTP API (https://github.com/FlareSolverr/FlareSolverr's README
 *     documents `request.get`/`request.post` and the `solution` shape).
 *   - `solve`: picks the container path when a base URL is configured
 *     (env `FLARESOLVERR_URL`, or passed explicitly), else falls back to
 *     the in-process solver.
 *
 * DETECTION MARKERS GO STALE: the title/text/DOM markers below are a lean
 * reimplementation of what real FlareSolverr's `src/utils.py` checks
 * (`findChallengeMarker`/challenge detection in their `submitRequest`
 * flow) -- title "Just a moment...", "Attention Required!", the
 * `#cf-challenge-running` / `.cf-turnstile` / `#challenge-form` DOM, the
 * `cf_chl_opt` inline script marker, etc. Cloudflare changes these pages
 * without notice and real FlareSolverr tracks it continuously (they have
 * more eyes on it than this repo does) -- if solving here starts silently
 * failing, check https://github.com/FlareSolverr/FlareSolverr's recent
 * commits/issues for what markers changed and port the update.
 */

import { chromium, type Page } from "playwright-core";
import { existsSync } from "node:fs";

export interface FlareSolverrCookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
}

export interface FlareSolverrResult {
    /** All cookies on the cleared page, including `cf_clearance` when Cloudflare set one. */
    cookies: FlareSolverrCookie[];
    /** The User-Agent the challenge was solved with -- reuse it on any follow-up fetch, the cookie is bound to it. */
    userAgent: string;
    /** Final page HTML, when the caller asked for it. */
    html?: string;
    /** HTTP status of the final (post-challenge) response, when known. */
    status?: number;
    /** Convenience: `cf_clearance` alone, if present. */
    cfClearance?: string;
}

export interface SolveOptions {
    /** Wait at most this long for the challenge to clear. FlareSolverr's own default. */
    maxTimeoutMs?: number;
    /** Include the final page HTML in the result. Off by default -- most callers only want cookies + UA. */
    includeHtml?: boolean;
    /** Explicit FlareSolverr container base URL, e.g. "http://localhost:8191". Falls back to env `FLARESOLVERR_URL`. */
    flaresolverrUrl?: string;
    /** Proxy for the in-process browser (mirrors `ctx.proxyUrl` elsewhere in this repo). */
    proxyUrl?: string;
}

const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

const DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** Same lookup `shared.mts` uses for BrowserSite scrapers -- one Chromium binary, one convention. */
function findChromiumExecutable(): string | undefined {
    const override = process.env.CHROMIUM_PATH;
    if (override && existsSync(override)) return override;
    for (const candidate of ["/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}

/**
 * Best-effort port of real FlareSolverr's challenge detection (see the
 * module doc comment). True while a challenge page is still showing, so the
 * caller keeps waiting; false once the underlying site's own page has
 * loaded (solved, or never challenged in the first place).
 */
async function isChallengePage(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const title = document.title || "";
        const titleMarkers = [
            "just a moment",
            "attention required",
            "checking your browser",
            "verifying you are human",
            "one more step"
        ];
        if (titleMarkers.some((m) => title.toLowerCase().includes(m))) return true;

        if (document.querySelector("#cf-challenge-running")) return true;
        if (document.querySelector(".cf-turnstile")) return true;
        if (document.querySelector("#challenge-form")) return true;
        if (document.querySelector("#challenge-stage")) return true;
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;

        const bodyText = document.body?.innerText?.toLowerCase() ?? "";
        if (bodyText.includes("checking your browser before accessing")) return true;
        if (bodyText.includes("ray id") && bodyText.includes("cloudflare")) {
            // "Ray ID" + "Cloudflare" together shows up on both the challenge
            // page and Cloudflare's plain error pages (1020 etc.) -- only
            // treat it as a still-solving challenge when a challenge script
            // marker is also present, otherwise it's a dead end, not a wait.
            if (document.documentElement.innerHTML.includes("cf_chl_opt")) return true;
        }
        return false;
    });
}

/** Drive this repo's own Playwright/Chromium at `url` until any Cloudflare/Turnstile challenge clears. */
export async function solveInProcess(url: string, options: SolveOptions = {}): Promise<FlareSolverrResult> {
    const executablePath = findChromiumExecutable();
    if (!executablePath) throw new Error("no Chromium binary found (set CHROMIUM_PATH, or apk add chromium)");

    const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    const browser = await chromium.launch({
        headless: true,
        executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        proxy: options.proxyUrl ? { server: options.proxyUrl } : undefined
    });

    try {
        const context = await browser.newContext({ userAgent: DESKTOP_UA });
        const page = await context.newPage();

        let lastStatus: number | undefined;
        page.on("response", (response) => {
            if (response.url() === url || response.url() === `${url}/`) lastStatus = response.status();
        });

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: maxTimeoutMs }).catch(() => {});

        const deadline = Date.now() + maxTimeoutMs;
        while (Date.now() < deadline) {
            if (!(await isChallengePage(page).catch(() => false))) break;
            await page.waitForTimeout(POLL_INTERVAL_MS);
        }

        if (await isChallengePage(page).catch(() => false)) {
            throw new Error(`challenge did not clear within ${maxTimeoutMs}ms for ${url}`);
        }

        const cookies = await context.cookies();
        const cfClearance = cookies.find((c) => c.name === "cf_clearance")?.value;
        const html = options.includeHtml ? await page.content().catch(() => undefined) : undefined;

        return {
            cookies: cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite
            })),
            userAgent: DESKTOP_UA,
            html,
            status: lastStatus,
            cfClearance
        };
    } finally {
        await browser.close();
    }
}

interface FlareSolverrApiResponse {
    status: string;
    message?: string;
    solution?: {
        url: string;
        status: number;
        cookies: FlareSolverrCookie[];
        userAgent: string;
        response: string;
    };
}

/** Talk to a real FlareSolverr container's documented `/v1` API. */
export async function solveViaContainer(url: string, options: SolveOptions = {}): Promise<FlareSolverrResult> {
    const base = (options.flaresolverrUrl ?? process.env.FLARESOLVERR_URL ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("no FlareSolverr container configured (set FLARESOLVERR_URL, or pass flaresolverrUrl)");

    const maxTimeout = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    // FlareSolverr itself can take a little longer than maxTimeout to answer
    // (its own internal retries), so give the HTTP call some headroom.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), maxTimeout + 15_000);

    let response: Response;
    try {
        response = await fetch(`${base}/v1`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cmd: "request.get", url, maxTimeout }),
            signal: controller.signal
        });
    } catch (err) {
        throw new Error(`FlareSolverr container at ${base} is unreachable: ${(err as Error).message}`);
    } finally {
        clearTimeout(abortTimer);
    }

    if (!response.ok) throw new Error(`FlareSolverr container returned HTTP ${response.status}`);

    const data = (await response.json()) as FlareSolverrApiResponse;
    if (data.status !== "ok" || !data.solution) {
        throw new Error(`FlareSolverr could not solve ${url}: ${data.message ?? "unknown error"}`);
    }

    const cfClearance = data.solution.cookies.find((c) => c.name === "cf_clearance")?.value;
    return {
        cookies: data.solution.cookies,
        userAgent: data.solution.userAgent,
        html: options.includeHtml ? data.solution.response : undefined,
        status: data.solution.status,
        cfClearance
    };
}

/**
 * Ask for `url` past whatever Cloudflare/Turnstile puts in front of it,
 * without caring which path serves the request: a configured FlareSolverr
 * container (`FLARESOLVERR_URL` or `options.flaresolverrUrl`) is preferred
 * when present, since a real patched browser is more robust than this
 * repo's lean port; otherwise this falls back to `solveInProcess`.
 */
export async function solve(url: string, options: SolveOptions = {}): Promise<FlareSolverrResult> {
    const hasContainer = Boolean(options.flaresolverrUrl ?? process.env.FLARESOLVERR_URL);
    return hasContainer ? solveViaContainer(url, options) : solveInProcess(url, options);
}

/** `document.cookie`-shaped string for the cleared cookies, ready to pair with a matching `User-Agent` on a follow-up fetch. */
export function cookieHeader(result: FlareSolverrResult): string {
    return result.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
