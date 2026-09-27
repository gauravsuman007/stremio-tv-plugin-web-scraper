import { createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createScraper, type Capture, type HttpSite, type ScraperContext } from "../shared.mts";

/**
 * flixer.gd -- its player asks `plsdontscrapemelove.flixer.gd/api/tmdb/.../images`
 * for the server list and then, one server at a time, for a source. This makes
 * the same calls from Node (it used to drive the page; see
 * ./archive/flixer-browser.mts). About 1 s a server.
 *
 * Every request carries a random 64-hex "api key" (the page gets one from
 * `img_data_bg.wasm`'s `get_img_key`, but the server accepts any), and an
 * HMAC-SHA256 of `key:timestamp:nonce:path` under that key. The answer is
 * base64 `iv(12) || AES-256-GCM ciphertext || tag(16)`, keyed with
 * `HMAC-SHA256(sha256^600(apiKey || salt(hour)), floor(time / 300) + apiKey)`,
 * where `salt(hour)[i] = (i + 1) ^ (hour >> (i & 7))` over 16 bytes and `hour`
 * is `floor(time / 3600)` -- what the module's `process_img_data` does
 * (STRATEGIES.md has how that was traced). The fingerprint headers are constants the server doesn't check.
 *
 * Playlists come off `fuckme.dragonballzfans.xyz` (plain `.m3u8`) or, for some
 * servers, `serve.dragonballzfans.xyz/proxy?data=` (no extension; segments
 * start with a PNG signature). Neither needs the Referer, but it's sent anyway.
 */
const BASE_URL = "https://flixer.gd";
const API = "https://plsdontscrapemelove.flixer.gd";
const TIMEOUT_MS = 15_000;
const KEY_ROUNDS = 600;
/** The player's own order: it asks the NATO-named servers alphabetically. */
const NATO = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];

interface FlixerAnswer {
    servers?: Record<string, string>;
    sources?: { server?: string; url?: string }[] | { file?: string; url?: string } | null;
}

interface Session {
    apiKey: string;
    /** hour -> sha256^600(apiKey || salt(hour)), the HMAC key for that hour's response keys. */
    rootKeys: Map<number, Buffer>;
    /** Server clock minus ours, in seconds: requests are signed and answers keyed with the server's time. */
    clockSkew?: Promise<number>;
}

function newSession(): Session {
    return { apiKey: randomBytes(32).toString("hex"), rootKeys: new Map() };
}

function rootKey(session: Session, hour: number): Buffer {
    let key = session.rootKeys.get(hour);
    if (!key) {
        const salt = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) salt[i] = (i + 1) ^ Number((BigInt(hour) >> BigInt(i & 7)) & 0xffn);
        key = createHash("sha256").update(Buffer.concat([Buffer.from(session.apiKey), salt])).digest();
        for (let i = 1; i < KEY_ROUNDS; i++) key = createHash("sha256").update(key).digest();
        session.rootKeys.set(hour, key);
    }
    return key;
}

async function serverTime(fetchImpl: ScraperContext["fetch"], session: Session): Promise<number> {
    session.clockSkew ??= fetchImpl(`${API}/api/time?t=${Date.now()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then(async (r) => ((await r.json()) as { timestamp: number }).timestamp - Date.now() / 1000)
        .catch(() => 0);
    return Math.floor(Date.now() / 1000 + (await session.clockSkew));
}

function decrypt(session: Session, body: string, time: number): FlixerAnswer {
    const data = Buffer.from(body.trim(), "base64");
    // The server keys by its own hour and 5-minute bucket; allow for a boundary crossed in between.
    for (const t of [time, time - 300, time + 300]) {
        const key = createHmac("sha256", rootKey(session, Math.floor(t / 3600))).update(`${Math.floor(t / 300)}${session.apiKey}`).digest();
        const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(data.length - 16));
        try {
            return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString()) as FlixerAnswer;
        } catch {
            /* wrong bucket */
        }
    }
    throw new Error("flixer: could not decrypt answer");
}

async function ask(fetchImpl: ScraperContext["fetch"], session: Session, path: string, server?: string): Promise<FlixerAnswer | null> {
    const time = await serverTime(fetchImpl, session);
    const nonce = randomBytes(16).toString("base64").replace(/[/+=]/g, "").slice(0, 22);
    const signature = createHmac("sha256", session.apiKey).update(`${session.apiKey}:${time}:${nonce}:${path}`).digest("base64");
    const response = await fetchImpl(`${API}${path}`, {
        headers: {
            Accept: "text/plain",
            Origin: BASE_URL,
            Referer: `${BASE_URL}/`,
            "X-Api-Key": session.apiKey,
            "X-Request-Timestamp": String(time),
            "X-Request-Nonce": nonce,
            "X-Request-Signature": signature,
            "X-Client-Fingerprint": "tomljm",
            "X-Fingerprint-Lite": "b4f8a1fc72e905d63e",
            ...(server ? { "X-Only-Sources": "1", "X-Server": server } : { bW90aGFmYWth: "1" })
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    return decrypt(session, await response.text(), time);
}

function sourceUrl(answer: FlixerAnswer | null, server: string): string | undefined {
    const sources = answer?.sources;
    if (!sources) return undefined;
    if (Array.isArray(sources)) return sources.find((s) => s.server?.toLowerCase() === server && s.url)?.url ?? sources.find((s) => s.url)?.url;
    return sources.file || sources.url || undefined;
}

const flixerSite: HttpSite = {
    id: "flixer",
    name: "Flixer",
    referrer: `${BASE_URL}/`,
    maxQuality: "1080p",
    async *httpCaptures({ match, season, episode }, ctx): AsyncGenerator<Capture> {
        const path =
            match.mediaType === "movie"
                ? `/api/tmdb/movie/${match.tmdbId}/images`
                : `/api/tmdb/tv/${match.tmdbId}/season/${season ?? 1}/episode/${episode ?? 1}/images`;
        const session = newSession();

        const listed = Object.keys((await ask(ctx.fetch, session, path).catch(() => null))?.servers ?? {});
        const servers = listed.length ? NATO.filter((s) => listed.includes(s)).concat(listed.filter((s) => !NATO.includes(s))) : NATO.slice(0, 8);

        // Asked all at once, taken in the player's order.
        const answers = servers.map((server) => ask(ctx.fetch, session, path, server).catch(() => null));
        for (const [i, server] of servers.entries()) {
            const mediaUrl = sourceUrl(await answers[i]!, server);
            if (mediaUrl) yield { mediaUrl, label: server };
        }
    }
};

export default createScraper(flixerSite);
