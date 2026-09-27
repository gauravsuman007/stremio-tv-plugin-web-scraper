/**
 * VOE (voe.sx and its rotating mirror domains), spoken without a browser.
 * Filmo embeds it. voe.sx/e/<code> answers a tiny page that redirects (in JS)
 * to the current mirror; the mirror's page carries the player config as an
 * obfuscated JSON string in `<script type="application/json">`:
 *   rot13 -> drop the junk markers -> base64 -> every char code minus 3 ->
 *   reverse -> base64 -> JSON with `source` (an HLS master; multi-audio titles
 *   list each dub as an `#EXT-X-MEDIA` audio rendition).
 * The media URLs are bound to the caller's ASN, like Byse's.
 */
import type { ScraperContext } from "./shared.mts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
const JUNK = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];

function rot13(text: string): string {
    return text.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

/** The decoded player config, or null when the page's format has changed. */
export function decodeVoeConfig(encoded: string): { source?: string } | null {
    try {
        let text = rot13(encoded);
        for (const junk of JUNK) text = text.split(junk).join("");
        text = Buffer.from(text, "base64").toString("latin1");
        text = Array.from(text, (c) => String.fromCharCode(c.charCodeAt(0) - 3)).reverse().join("");
        return JSON.parse(Buffer.from(text, "base64").toString("utf8")) as { source?: string };
    } catch {
        return null;
    }
}

async function getPage(ctx: ScraperContext, url: string, referer: string): Promise<{ html: string; url: string } | null> {
    const response = await ctx.fetch(url, { headers: { "User-Agent": UA, Referer: referer }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? { html: await response.text(), url: response.url || url } : null;
}

/** The HLS master of one VOE video and the Referer to play it with, or null. */
export async function resolveVoe(embedLink: string, embedReferer: string, ctx: ScraperContext): Promise<{ url: string; referrer: string } | null> {
    let page = await getPage(ctx, embedLink, embedReferer);
    // The first hop is usually just `window.location.href = '<mirror>/e/<code>'`.
    const hop = page && !page.html.includes('type="application/json"')
        ? /window\.location\.href\s*=\s*'([^']+)'/.exec(page.html)?.[1]
        : undefined;
    if (hop) page = await getPage(ctx, hop, embedReferer);
    if (!page) return null;

    const blob = /<script type="application\/json">([^<]+)<\/script>/.exec(page.html)?.[1];
    if (!blob) return null;
    let encoded: unknown;
    try { encoded = JSON.parse(blob); } catch { return null; }
    const first = Array.isArray(encoded) ? encoded[0] : encoded;
    if (typeof first !== "string") return null;
    const source = decodeVoeConfig(first)?.source;
    return source ? { url: source, referrer: `${new URL(page.url).origin}/` } : null;
}
