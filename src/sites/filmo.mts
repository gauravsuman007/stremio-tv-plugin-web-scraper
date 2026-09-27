import { resolveByse, byseEmbed } from "../byse.mts";
import { resolveVoe } from "../voe.mts";
import { createScraper, tmdbLocalizedTitle, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * filmo.to -- a German site (movies only) whose films carry VOE and Byse
 * mirrors per audio language (English and/or German). Plain HTTP (recipe:
 * STRATEGIES.md):
 *
 *   1. GET /search/suggest?q=<title> -> {movies:[{title, url}]}; titles are
 *      the German release title where it differs, so both are tried.
 *   2. GET the movie page (keep its session cookies and `csrf-token`): each
 *      mirror is a chip `data-p="<Laravel-encrypted blob>"` in a row per language.
 *   3. POST /n {p} (X-CSRF-TOKEN, same session) -> {x}; GET /n/<x> -> a 302 to
 *      the VOE embed, or a page linking the Byse file (bysezejataos.com/d/<code>).
 *   4. VOE: src/voe.mts; Byse: src/byse.mts (its /e/<code> embed).
 */
const SITE = "https://filmo.to/";
const TIMEOUT_MS = 15_000;
const LANGUAGES: Record<string, string> = { English: "English", Deutsch: "German" };

const normalise = (text: string) => text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9äöüß]+/g, "");

class Session {
    private cookies = new Map<string, string>();
    constructor(private ctx: ScraperContext) {}

    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers);
        if (this.cookies.size) headers.set("Cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
        const response = await this.ctx.fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        for (const line of response.headers.getSetCookie?.() ?? []) {
            const [pair] = line.split(";");
            const at = pair!.indexOf("=");
            if (at > 0) this.cookies.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
        }
        return response;
    }
}

interface Chip { language: string; host: string; p: string }

function parseChips(page: string): Chip[] {
    const chips: Chip[] = [];
    for (const row of page.split('provider-row__lang">').slice(1)) {
        const language = row.slice(0, row.indexOf("<")).trim();
        // Each chip's markup runs from its data-p to its aria-label (the host name); stop at the next row.
        const body = row.split("provider-row__lang")[0]!;
        for (const [, p, host] of body.matchAll(/data-p="([^"]+)"[\s\S]*?aria-label="([^"]+)"/g)) chips.push({ language, host: host!, p: p! });
    }
    return chips;
}

async function findMoviePage(session: Session, titles: string[], year: number | null): Promise<string | null> {
    for (const title of titles) {
        const response = await session.fetch(`${SITE}search/suggest?q=${encodeURIComponent(title)}`, { headers: { Accept: "application/json" } });
        if (!response.ok) continue;
        let movies: { title?: string; url?: string }[];
        try { movies = ((await response.json()) as { movies?: typeof movies }).movies ?? []; } catch { continue; }
        for (const movie of movies.filter((entry) => entry.url && normalise(entry.title ?? "") === normalise(title))) {
            const page = await session.fetch(movie.url!);
            if (!page.ok) continue;
            const html = await page.text();
            // The page shows the release year as a bare `>2010<`; a remake shares the title, not the year.
            if (!year || html.includes(`>${year}<`)) return html;
        }
    }
    return null;
}

const filmoSite: HttpSite = {
    id: "filmo",
    name: "Filmo",
    referrer: SITE,
    maxQuality: "1080p",
    async *httpCaptures({ match }, ctx): AsyncGenerator<Capture> {
        if (match.mediaType !== "movie") return;
        const session = new Session(ctx);
        const german = await tmdbLocalizedTitle(ctx.fetch, match, "de-DE");
        const page = await findMoviePage(session, [...new Set([match.title, german].filter((t): t is string => !!t))], match.year);
        const csrf = page && /name="csrf-token" content="([^"]+)"/.exec(page)?.[1];
        if (!csrf) return;

        for (const chip of parseChips(page)) {
            const host = chip.host.toLowerCase();
            if (host !== "voe" && host !== "byse") continue;
            const minted = await session.fetch(`${SITE}n`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-TOKEN": csrf, "X-Requested-With": "XMLHttpRequest", Referer: SITE },
                body: JSON.stringify({ p: chip.p })
            });
            if (!minted.ok) continue;
            let token: string | undefined;
            try { token = ((await minted.json()) as { x?: string }).x; } catch { continue; }
            if (!token) continue;

            const opened = await session.fetch(`${SITE}n/${encodeURIComponent(token)}`, { redirect: "manual", headers: { Referer: SITE } });
            const target = opened.headers.get("location")
                ?? /class="open" href="([^"]+)"/.exec(await opened.text())?.[1];
            if (!target) continue;
            const audio = [LANGUAGES[chip.language] ?? chip.language];

            if (host === "voe") {
                const voe = await resolveVoe(target, SITE, ctx);
                // The master names its own audio renditions (often both dubs), so let those speak.
                if (voe) yield { mediaUrl: voe.url, label: `VOE ${audio[0]}`, referrer: voe.referrer };
            } else {
                const embed = byseEmbed(target);
                if (!embed) continue;
                for (const source of await resolveByse(`${embed.origin}/e/${embed.code}`, SITE, ctx)) {
                    yield { mediaUrl: source.url, label: `Byse ${audio[0]}`, referrer: source.referrer, audio };
                }
            }
        }
    }
};

export default createScraper(filmoSite);
