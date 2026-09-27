import { createScraper, type Capture, type HttpSite } from "../shared.mts";

/**
 * vidnest.fun -- one backend (new.vidnest.fun) with a route per upstream. This
 * uses the `nextgencloudfabric` upstream: keyless, the response is
 * `{encrypted:true, data}` where `data` is base64 in a custom alphabet (the
 * player's own `decryptCipherResponse`), decoding to JSON. Recipe and
 * measurements: STRATEGIES.md.
 *
 * Its media hosts only serve segments to `Referer: https://nextgencloudfabric.com/`
 * (the vidnest referer gets 403 on segments), which is what the response's own
 * `headers` says too.
 */
const API = "https://new.vidnest.fun/";
const PLAYER = "https://vidnest.fun/";
const MEDIA_REFERRER = "https://nextgencloudfabric.com/";
const ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
const API_TIMEOUT_MS = 20_000;
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));
const PAD = 64;

function decode(data: string): string {
    const bytes: number[] = [];
    for (let at = 0; at < data.length; at += 4) {
        const chunk = data.slice(at, at + 4).padEnd(4, "=");
        const [a = PAD, b = PAD, c = PAD, d = PAD] = [...chunk].map((char) => LOOKUP.get(char) ?? PAD);
        bytes.push(((a << 2) | (b >> 4)) & 0xff);
        if (c !== PAD) bytes.push((((b & 15) << 4) | (c >> 2)) & 0xff);
        if (d !== PAD) bytes.push((((c & 3) << 6) | d) & 0xff);
    }
    return Buffer.from(bytes).toString("utf8");
}

const vidnestSite: HttpSite = {
    id: "vidnest",
    name: "Vidnest",
    referrer: MEDIA_REFERRER,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;

        const response = await ctx.fetch(`${API}nextgencloudfabric/${path}`, {
            headers: { Referer: PLAYER, Origin: PLAYER.slice(0, -1) },
            signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) return;

        let body: { encrypted?: boolean; data?: string; url?: string; all_urls?: string[] };
        try {
            body = (await response.json()) as typeof body;
            if (body.encrypted && body.data) body = JSON.parse(decode(body.data));
        } catch {
            return;
        }
        // `url` is the first of `all_urls` (same encode on other hosts): offer them in order.
        const urls = [...new Set([body.url, ...(body.all_urls ?? [])].filter((url): url is string => !!url))];
        for (const [index, mediaUrl] of urls.entries()) yield { mediaUrl, label: `Cloud ${index + 1}` };
    }
};

export default createScraper(vidnestSite);
