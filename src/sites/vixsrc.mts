import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * vixsrc.to -- the StreamingCommunity catalogue (Streaming Unity is a
 * front-end for it). No browser and no key: the API names an embed page, and
 * the embed page carries the tokenised master playlist URL in
 * `window.masterPlaylist`. Recipe and measurements: STRATEGIES.md.
 *
 * The master is HLS with separate `#EXT-X-MEDIA` audio (English and Italian)
 * and subtitle playlists, and AES-128 leaf playlists. The video renditions
 * carry NO audio of their own, so the master must go out whole: the host's
 * relay (web-links >= 0.8.3) routes those rendition playlists through itself;
 * an older host would serve the video silent.
 *
 * Only 480p and 720p exist. `lang=en` makes English the default audio track
 * (the catalogue is Italian-first).
 */
const SITE = "https://vixsrc.to/";
const API_TIMEOUT_MS = 20_000;

const vixsrcSite: HttpSite = {
    id: "vixsrc",
    name: "VixSrc",
    referrer: SITE,
    maxQuality: "720p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        const signal = AbortSignal.timeout(API_TIMEOUT_MS);

        const api = await ctx.fetch(`${SITE}api/${path}`, { headers: { Referer: SITE }, signal });
        if (!api.ok) return; // not in the catalogue.
        const { src } = (await api.json()) as { src?: string };
        if (!src) return;

        const page = await ctx.fetch(new URL(src, SITE).toString(), { headers: { Referer: `${SITE}${path}` }, signal });
        if (!page.ok) return;
        const html = await page.text();

        // window.masterPlaylist = { params: { 'token': '...', 'expires': '...' }, url: 'https://vixsrc.to/playlist/ID' }
        const start = html.indexOf("window.masterPlaylist");
        if (start < 0) return;
        const block = html.slice(start, start + 800);
        const url = /url:\s*'([^']+)'/.exec(block)?.[1];
        const token = /'token':\s*'([^']+)'/.exec(block)?.[1];
        const expires = /'expires':\s*'([^']+)'/.exec(block)?.[1];
        if (!url || !token || !expires) return;

        const master = new URL(url);
        master.searchParams.set("token", token);
        master.searchParams.set("expires", expires);
        master.searchParams.set("h", "1");
        master.searchParams.set("lang", "en");
        yield { mediaUrl: master.toString() };
    }
};

export default createScraper(vixsrcSite);
