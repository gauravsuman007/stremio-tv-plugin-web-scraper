/**
 * cinesrc.st's stream API, spoken without a browser. ShuttleTV's watch page is
 * this player in an iframe. Everything here was worked out from the site's own
 * page code (STRATEGIES.md, "shuttletv" section, has the full recipe and how it
 * was found); nothing from the site is executed except `pow-v3.wasm`, a
 * zero-import WebAssembly proof-of-work that can only compute.
 *
 * One resolve is: bootstrap -> issue (a PoW work item) -> stage2/issue (a
 * fingerprint PoW + signed token, reversed) -> build a two-part challenge ->
 * call the page's `getStream` Next.js server action with it -> ECDH-decrypt the
 * `r3.` answer. A challenge is single use, so every provider tried repeats the
 * whole sequence.
 *
 * Things the site can change under us, in the order they are likely to:
 * the server action ids (rediscovered from the page's chunks on failure), the
 * `csp3-...` protocol label and the s1 field ids below (both baked into
 * `/300726c-prod.js`; a mismatch answers `e1:invalid_challenge`).
 */
import { createHash, randomBytes, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

export const CINESRC_ORIGIN = "https://cinesrc.st";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PROTOCOL = "csp3-20260613-b";
const TIMEOUT_MS = 15_000;

/** Field ids of the s1 challenge array, in order (prod.js interleaves them with decoy `_zXX` pairs). */
const FIELD = [
    "f78e3f38-5436-4d74-98e1-3ff89c437531", "14f36d78-cd51-4c30-a14f-c9837603f11a", "d320ff1b-828b-40d8-8078-51223f760da2",
    "c95a9d35-0eab-4763-ae6d-84e88bf9b95a", "a4df7df1-ad2c-475d-bf9a-32aef923db26", "5ebfd557-0100-4a61-ab6d-ad01367b29ae",
    "9729037b-4b95-48a5-aad2-9dd5a6c0fbf0", "187cd216-ab92-41f1-9f5a-81e311b07f4e", "36252f09-c35f-4397-aa77-6a9732995c78",
    "49ac9c1d-32cd-4e3f-8036-cc822845d864", "734a3ec4-0aa2-4e4c-9c98-f41f6677669b", "53cb60c4-b283-412d-899b-5bc36242df50",
    "9f23a7cc-e448-45c6-b38a-089bc7afb150", "f19257de-6e6c-4159-9837-65bc66117d6b", "65a17c01-9e53-4e40-b1e7-3fe9171229b3",
    "89fd8156-2e9e-4bc4-9f58-e2b31f781f12", "362c5fe0-82df-4a68-84cc-9f830748444e"
] as const;

/** A desktop Chrome's fingerprint, as prod.js (s1) and donut.js (c2) report it. Replayed as-is; the server only checks it is present. */
const S1_FP = {
    tz: "Europe/Berlin", lang: "en-US", langs: "en-US", pf: "MacIntel", cm: true, dpr: 1, sw: 1280, sh: 720, cd: 24,
    cvs: "21a9107876214fe3eb34060b571202e12902e03b3ec8ca796076175f73166c14",
    wgl: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)|Google Inc. (Google)",
    jit: "0.7999999523162842,0.8999999761581421,0.8999999761581421,0.8999999761581421,0.8999999761581421"
};
const C2_FP = {
    c: "6459ff4d5300250cd77b3f29d7dd0f9978345a8baefab32bb62aa61cb18c3bf3",
    g: "d6e2257b4df542735f146b8f5177f7e5ffc544f7ffc256f2c2645bc23dad9692",
    tz: "Europe/Berlin", l: "en-US", ls: "en-US", pf: "MacIntel", sw: 1280, sh: 720, cd: 24, ce: true, dpr: 1
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CinesrcTarget {
    tmdbId: number | string;
    mediaType: "movie" | "tv";
    season?: number;
    episode?: number;
}

export interface CinesrcProvider {
    id: string;
    name: string;
    rank: number;
}

export interface CinesrcStream {
    url: { source?: string; url: string; hash?: string }[] | null;
    error?: string | null;
    name?: string;
    provider?: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const reverse = (s: string) => s.split("").reverse().join("");

/* ---- the fingerprint hash donut.js computes in its VM (xg.s / xg.m) ---- */

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

/** A custom 160-bit mixing hash, recovered op by op from donut.js's bytecode interpreter. */
function donutHash(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let a = (0xc2b2ae35 ^ bytes.length) >>> 0, b = 0x03040506, c = 0x04040404, d = 0x9e3779b9, e = 0x85ebca6b;
    for (let i = 0; i < bytes.length; i++) {
        const ch = bytes[i]!;
        b = (rotl((b ^ ((ch + i + a) >>> 0)) >>> 0, 5) + c) >>> 0;
        const c1 = rotl((c + ((b >>> 16) ^ ch) + 0x27d4eb2d) >>> 0, 7);
        const y = (rotl((c1 ^ ((ch << ((i & 3) * 8)) >>> 0)) >>> 0, 11) + e) >>> 0;
        const e1 = rotl((e + y + ((b ^ ch) >>> 0)) >>> 0, 13);
        c = (c1 ^ d) >>> 0;
        d = y;
        e = (e1 ^ a) >>> 0;
        a = rotl((e1 ^ ((ch + Math.imul(i + 1, 0x045d9f3b)) >>> 0)) >>> 0, 17);
    }
    for (let r = 0; r < 12; r++) {
        b = (rotl((b + a + Math.imul(r + 1, 0x9e3779b1)) >>> 0, 3) ^ c) >>> 0;
        c = (rotl((c ^ d ^ Math.imul(r + 3, 0x85ebca77)) >>> 0, 9) + e) >>> 0;
        d = (rotl((d + b + Math.imul(r + 5, 0xc2b2ae3d)) >>> 0, 15) ^ a) >>> 0;
        e = (rotl((e ^ c ^ Math.imul(r + 7, 0x27d4eb2f)) >>> 0, 21) + b) >>> 0;
        a = (rotl((a + d + e + r) >>> 0, 27) ^ b) >>> 0;
    }
    return [b, c, d, e, a].map((v) => v.toString(16).padStart(8, "0")).join("");
}

/* ---- proof-of-work ---- */

let powModule: Promise<WebAssembly.Module> | undefined;

/** `pow-v3.wasm`'s `b(ptr, len)` solves the `/api/c/issue` work item and returns a NUL-terminated `m3.<hex>`. */
async function solveIssuePow(fetch: Fetch, work: string): Promise<string> {
    powModule ??= fetch(`${CINESRC_ORIGIN}/pow-v3.wasm`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then((r) => {
            if (!r.ok) throw new Error(`pow-v3.wasm ${r.status}`);
            return r.arrayBuffer();
        })
        .then(async (bytes) => {
            const module = await WebAssembly.compile(bytes);
            // Pure computation only: refuse a build that wants anything from us.
            if (WebAssembly.Module.imports(module).length) throw new Error("pow-v3.wasm now has imports");
            return module;
        });
    const module = await powModule.catch((err) => {
        powModule = undefined;
        throw err;
    });
    const exports = (await WebAssembly.instantiate(module, {})).exports as {
        memory: WebAssembly.Memory;
        a(len: number): number;
        b(ptr: number, len: number): number;
    };
    const input = Buffer.from(work, "base64url");
    const ptr = exports.a(input.length);
    new Uint8Array(exports.memory.buffer).set(input, ptr);
    const out = exports.b(ptr, input.length);
    const mem = new Uint8Array(exports.memory.buffer);
    let end = out;
    while (mem[end]) end++;
    return Buffer.from(mem.subarray(out, end)).toString("latin1");
}

/** donut.js's own PoW: the nonce `x` (5 hex digits) with sha256(salt + x) == target. */
function solveFingerprintPow(salt: string, target: string): string {
    for (let n = 0; n < 1 << 24; n++) {
        const x = n.toString(16).padStart(5, "0");
        if (createHash("sha256").update(salt + x).digest("hex") === target) return x;
    }
    throw new Error("fingerprint pow unsolved");
}

/* ---- challenge ---- */

/** AES-256-GCM under a fresh key, the key RSA-OAEP(SHA-256)-wrapped. */
async function seal(spki: Uint8Array, plaintext: (key: Uint8Array) => Uint8Array, context?: Uint8Array) {
    const raw = new Uint8Array(randomBytes(32));
    const aesKey = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const rsaKey = await subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const iv = new Uint8Array(randomBytes(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, ...(context ? { additionalData: context } : {}) }, aesKey, plaintext(raw)));
    const wrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP", ...(context ? { label: context } : {}) }, rsaKey, raw));
    return { wrapped, iv, ct };
}

/** donut.js's part: fingerprint, its PoW, and two hashes binding them to the stage2 token. */
async function buildC2(pack: unknown[], now: number): Promise<string> {
    const ss2 = reverse(String(pack[4]));
    const inner = Buffer.from(ss2.split(".")[1] ?? "", "base64").toString();
    const token = JSON.parse(Buffer.from(inner.split(".")[1] ?? "", "base64url").toString()) as { salt: string; target: string };
    const x = solveFingerprintPow(token.salt, token.target);
    const body = {
        v: 1, t: now, ua: UA, p: { s: token.salt, x }, fp: C2_FP,
        xg: {
            r: ss2, t: now,
            s: donutHash(`${inner}\x1e${token.salt}\x1e${x}\x1e${token.target}\x1e${now}`),
            m: donutHash(`${ss2}\x1f${token.salt}\x1fstage2`).slice(0, 24)
        }
    };
    const spki = Buffer.from(reverse(String(pack[2])), "base64");
    const sealed = await seal(spki, () => new TextEncoder().encode(JSON.stringify(body)));
    return `c2~${b64u(sealed.wrapped)}~${b64u(sealed.iv)}~${b64u(sealed.ct)}`;
}

const decoy = (): [string, string] => ["_z" + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0"), b64(randomBytes(4))];

/** prod.js's part: the issue proof, our ECDH public key, and a fingerprint, XORed with its own AES key. */
async function buildS1(opts: { issue: IssueResponse; proof: string; now: number; path: string; clientPub: Uint8Array; pem: string }): Promise<string> {
    const { issue, proof, now, path, clientPub, pem } = opts;
    const fields = [
        FIELD[0], PROTOCOL, FIELD[1], "s1", FIELD[2], issue.w, ...decoy(), FIELD[3], proof, FIELD[4], issue.t, FIELD[5], issue.n,
        ...decoy(), FIELD[6], issue.s, FIELD[7], now, FIELD[8], randomBytes(8).toString("hex"), ...decoy(), FIELD[9], UA,
        FIELD[10], path, FIELD[11], S1_FP, ...decoy(), FIELD[12], b64(randomBytes(16)), FIELD[13], randomBytes(32).toString("hex"),
        FIELD[14], b64(clientPub), ...decoy(), FIELD[15], 1, FIELD[16], b64(randomBytes(18))
    ];
    const context = new TextEncoder().encode(`cinesrc-challenge|${PROTOCOL}|s1`);
    const spki = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const json = new TextEncoder().encode(JSON.stringify(fields));
    const sealed = await seal(spki, (key) => json.map((byte, i) => byte ^ key[i % 32]!), context);
    return `s1~${b64(sealed.wrapped)}~${b64(sealed.iv)}~${b64(sealed.ct)}`;
}

/* ---- server actions ---- */

interface ActionIds {
    getStream: string;
    getProviderList: string;
}

/** Last seen ids, used until they stop working. */
const FALLBACK_ACTIONS: ActionIds = {
    getStream: "7eaf09c6d168184a0b875694dce39c349662222742",
    getProviderList: "00db14302a7e49e28e8eecf1a657ce239ab8b44c47"
};
let actions: ActionIds = FALLBACK_ACTIONS;
let actionsRefreshedAt = 0;

/** Finds `createServerReference("<id>", ..., "getStream")` in the embed page's chunks. */
async function refreshActions(fetch: Fetch, path: string): Promise<boolean> {
    if (Date.now() - actionsRefreshedAt < 60_000) return false;
    actionsRefreshedAt = Date.now();
    const html = await (await fetch(CINESRC_ORIGIN + path, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })).text();
    const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) ?? [])];
    const found: Partial<ActionIds> = {};
    await Promise.all(chunks.map(async (chunk) => {
        const js = await (await fetch(CINESRC_ORIGIN + chunk, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })).text().catch(() => "");
        for (const m of js.matchAll(/createServerReference\)\("([0-9a-f]{40,})",[^)]*?"(getStream|getProviderList)"\)/g)) found[m[2] as keyof ActionIds] = m[1];
    }));
    if (!found.getStream) return false;
    actions = { ...actions, ...found } as ActionIds;
    return true;
}

async function callAction(fetch: Fetch, path: string, id: string, args: unknown[]): Promise<string> {
    const res = await fetch(CINESRC_ORIGIN + path, {
        method: "POST",
        headers: { "user-agent": UA, referer: `${CINESRC_ORIGIN}/`, origin: CINESRC_ORIGIN, accept: "text/x-component", "content-type": "text/plain;charset=UTF-8", "next-action": id },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`action ${res.status}`);
    return text;
}

/* ---- the flow ---- */

interface IssueResponse {
    w: string;
    t: number;
    n: string;
    s: string;
}

function pagePath(target: CinesrcTarget): string {
    return `/embed/${target.mediaType}/${target.tmdbId}`;
}

export async function listProviders(fetch: Fetch, target: CinesrcTarget): Promise<CinesrcProvider[]> {
    const path = pagePath(target);
    let rsc = await callAction(fetch, path, actions.getProviderList, []).catch(() => "");
    if (!rsc.includes('"rank"') && (await refreshActions(fetch, path).catch(() => false))) rsc = await callAction(fetch, path, actions.getProviderList, []).catch(() => "");
    const line = rsc.split("\n").find((l) => l.startsWith("1:["));
    if (!line) return [];
    return (JSON.parse(line.slice(2)) as CinesrcProvider[]).sort((x, y) => y.rank - x.rank);
}

/** One provider, one fresh challenge. Null when the provider has nothing (`no_streams` etc.). */
export async function getStream(fetch: Fetch, target: CinesrcTarget, provider: string): Promise<CinesrcStream | null> {
    const path = pagePath(target);
    const cookies = new Map<string, string>();
    const api = async <T,>(p: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> => {
        const res = await fetch(CINESRC_ORIGIN + p, {
            ...init,
            headers: { "user-agent": UA, referer: `${CINESRC_ORIGIN}/`, origin: CINESRC_ORIGIN, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...init.headers },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        for (const c of res.headers.getSetCookie?.() ?? []) {
            const kv = c.split(";")[0] ?? "";
            const eq = kv.indexOf("=");
            if (eq > 0) cookies.set(kv.slice(0, eq), kv.slice(eq + 1));
        }
        if (!res.ok) throw new Error(`${p} ${res.status}`);
        return (await res.json()) as T;
    };

    const query = JSON.stringify([target.mediaType, String(target.tmdbId), target.season != null ? String(target.season) : null, target.episode != null ? String(target.episode) : null]);
    const xq = b64u(new TextEncoder().encode(query));

    const boot = await api<{ r: string; p: string }>("/api/c/bootstrap", { method: "POST", headers: { "x-cs-q": xq } });
    cookies.set("cs_ac", boot.r);
    const pbCookie = "cs_pb_" + createHash("sha256").update(query).digest("hex").slice(0, 16);
    cookies.set(pbCookie, boot.p);
    const issue = await api<IssueResponse>("/api/c/issue", { headers: { "x-cs-q": xq, "x-cs-p": boot.p, "x-cs-r": boot.r } });
    cookies.delete(pbCookie);
    const [{ pack }, { pk }, proof] = await Promise.all([
        api<{ pack: unknown[] }>("/api/c/stage2/issue", { headers: { "x-cs-q": xq, "x-cs-r": boot.r } }),
        api<{ pk: string }>("/api/c/pk"),
        solveIssuePow(fetch, issue.w)
    ]);

    const now = Date.now();
    const ecdh = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const clientPub = new Uint8Array(await subtle.exportKey("raw", ecdh.publicKey));
    const s1 = await buildS1({ issue, proof, now, path, clientPub, pem: pk });
    const c2 = await buildC2(pack, now);
    const challenge = `${s1}::c2::${c2}::c3::${boot.r}`;

    const args = [String(target.tmdbId), target.mediaType === "movie" ? "movie" : "show", target.season ?? "$undefined", target.episode ?? "$undefined", challenge, provider];
    let rsc = await callAction(fetch, path, actions.getStream, args).catch(() => "");
    if (!rsc.includes(":") && (await refreshActions(fetch, path).catch(() => false))) return getStream(fetch, target, provider);
    const answer = rsc.match(/r3\.[^"\n\\]+/)?.[0];
    if (!answer) return null;

    const [, serverPub = "", salt = "", iv = "", header = "", ct = ""] = answer.split(".");
    const serverKey = await subtle.importKey("raw", Buffer.from(serverPub, "base64url"), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, ecdh.privateKey, 256);
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const context = `cinesrc-response|${PROTOCOL}|r3|${serverPub}|${header}`;
    const aes = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: Buffer.from(salt, "base64url"), info: new TextEncoder().encode(`${context}|${b64u(clientPub)}|kdf`) },
        hkdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url"), additionalData: new TextEncoder().encode(context) }, aes, Buffer.from(ct, "base64url"));
    return JSON.parse(new TextDecoder().decode(plain)) as CinesrcStream;
}
