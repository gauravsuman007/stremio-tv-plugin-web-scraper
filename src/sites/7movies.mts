import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * 7movies.ac -- its watch page iframes `embed.vidrift.net`, whose player is
 * driven by two plain JSON calls, made here directly (it used to run the
 * player in Chromium; see ./archive/7movies-browser.mts):
 *
 *   GET /api/boot/<path>   -> meta.playbackToken, plus `warmStreams` it has
 *                             already resolved (relay.vidrift.net proxies)
 *   GET /api/source/<path>?token=...&provider=<p>  -> { streams: [...] }
 *
 * When the boot carries an `evionUrl` (a partner library, H.264, dubs as
 * `#EXT-X-MEDIA` audio in one playlist) the player leads with it. Then it
 * cascades moviebox ("Orion", HEVC 1080p with a separate audio group,
 * `/api/mb/<id>/master.m3u8`), vaplayer ("Earth"), vidlove ("Star"), vidrock
 * ("Atlas"); moviebox is skipped by browsers without HEVC.
 *
 * WHICH PROVIDER ANSWERS DEPENDS ON THE CALLER'S IP: from the server's
 * datacentre address the boot's warm streams are sometimes all there is, so
 * they are offered too (AGENTS.md).
 */
const BASE = "https://embed.vidrift.net";
const TIMEOUT_MS = 15_000;
const PROVIDERS = ["moviebox", "vaplayer", "vidlove", "vidrock"];

interface Stream {
    proxyUrl?: string;
    url?: string;
    type?: string;
    provider?: string;
}

const sevenMoviesSite: HttpSite = {
    id: "7movies",
    name: "7Movies",
    referrer: `${BASE}/`,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
        const headers = { Referer: `${BASE}/embed2/${path}` };
        const seen = new Set<string>();
        const offer = function* (streams: Stream[] | undefined): Generator<Capture> {
            for (const stream of streams ?? []) {
                const raw = stream.proxyUrl || stream.url;
                if (!raw || (stream.type && stream.type !== "hls")) continue;
                const mediaUrl = new URL(raw, BASE).href;
                if (seen.has(mediaUrl)) continue;
                seen.add(mediaUrl);
                yield { mediaUrl, label: stream.provider || undefined };
            }
        };

        const boot = await ctx
            .fetch(`${BASE}/api/boot/${path}?`, { headers: { ...headers, "x-embed-parent": "" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
            .then((r) => (r.ok ? (r.json() as Promise<{ meta?: { playbackToken?: string; evionUrl?: string; warmStreams?: Stream[] } }>) : null))
            .catch(() => null);
        const token = boot?.meta?.playbackToken;

        const answers = token
            ? PROVIDERS.map((provider) =>
                  ctx
                      .fetch(`${BASE}/api/source/${path}?token=${encodeURIComponent(token)}&provider=${provider}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
                      .then((r) => (r.ok ? (r.json() as Promise<{ streams?: Stream[] }>) : null))
                      .catch(() => null)
              )
            : [];

        if (boot?.meta?.evionUrl) yield* offer([{ url: boot.meta.evionUrl, type: "hls", provider: "Evion" }]);
        yield* offer((await answers[0])?.streams);
        yield* offer(boot?.meta?.warmStreams);
        for (const answer of answers.slice(1)) yield* offer((await answer)?.streams);
    }
};

export default createScraper(sevenMoviesSite);
