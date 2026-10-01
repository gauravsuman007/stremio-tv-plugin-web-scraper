import vm from "node:vm";
import type { ScraperContext } from "./shared.mts";

/**
 * vidfast.vc's player seals every request and unseals every answer inside
 * bytecode virtual machines in one obfuscated Next.js chunk; the AES key/IV,
 * the request base path, the CSRF token and the string table all change with
 * each deploy and live only in that bytecode (STRATEGIES.md, "vidfast.vc").
 * Rather than copy one deploy's constants, this runs the site's own player
 * code, downloaded fresh, in a `node:vm` context and calls its two entry
 * points:
 *
 *   - the server-list program (`X({crypto, encode, server, setServers, ...})`),
 *     which POSTs the sealed page token and hands back `[{name, data}, ...]`;
 *   - the stream program (`Y({dr, rs, ...})`), which takes the script a
 *     server's `data` POST returns and leaves `{url, tracks, ...}` in `dr[0]`.
 *
 * Everything is located by its shape in the minified source, never by name.
 * This is the repo's sandboxed-site-code pattern; its safeguards are listed in
 * AGENTS.md ("Running a site's own code") and every one is applied here.
 *
 * `vm` is NOT a security boundary: it limits what the code can reach by
 * accident or by a rotated bundle, not what a hostile one could do. Only the
 * code of a site already being scraped is ever run.
 */

const ORIGIN = "https://vidfast.vc";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const SCRIPT_RUN_TIMEOUT_MS = 20_000;
const MAX_SCRIPT_BYTES = 6_000_000;
const MAX_SCRIPTS = 20;
const RUNTIME_MAX_AGE_MS = 6 * 60 * 60_000;
/** The player module is the one that calls the server-list program. Found by `indexOf` on these anchors: regexes over a 2 MB minified module are slow. */
const SERVER_LIST_ANCHOR = "({crypto:";
const STREAM_ANCHOR = "({dr:";
const STREAM_FETCH_ANCHOR = 'fetch("".concat("/';
/** Matched against a short slice starting at the anchor: base path, segment (string-table index or literal), CSRF header. */
const STREAM_FETCH = /^fetch\(""\.concat\("(\/[^"]+)","\/"\)\.concat\((?:(\w+)\((\d+)\)|"([A-Za-z0-9_-]{6,})"),"\/"\)\.concat\(\w+\.data\),\{[^}]*?method:"POST",headers:\{\.\.\.JSON\.parse\('(\{[^']+\})'\)/;

/** The identifier immediately before `index` (the name of the function being called there). */
function nameBefore(source: string, index: number): string | undefined {
    return /(\w+)$/.exec(source.slice(Math.max(0, index - 40), index))?.[1];
}

export interface VidfastServer { name: string; data: string; description?: string }
export interface VidfastStream { url: string; tracks?: { file: string; label?: string }[]; mp4?: boolean }

export interface VidfastSession {
    servers: VidfastServer[];
    stream(server: VidfastServer): Promise<VidfastStream | null>;
}

interface Runtime {
    key: string;
    builtAt: number;
    sandbox: Record<string, unknown>;
    context: vm.Context;
    entry: { list: Function; stream: Function; crypto: unknown; encode: unknown; buffer: unknown };
    request: { base: string; headers: Record<string, string>; segment: string };
}

let runtime: Runtime | null = null;
/** The player keeps module-level state, so one title is processed at a time. */
let queue: Promise<unknown> = Promise.resolve();

const noop = () => undefined;
const element = (): object => new Proxy(function () {}, { get: (_t, key) => (key === "style" ? {} : key === Symbol.toPrimitive ? () => "" : element()), apply: () => element(), set: () => true });

/** The only host globals the player's modules touch; nothing else (no `process`, no `require`) is reachable. */
const HOST_GLOBALS = [
    "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "AbortController", "AbortSignal", "EventTarget", "Event", "CustomEvent",
    "Buffer", "atob", "btoa", "structuredClone", "queueMicrotask", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "performance", "crypto", "Blob", "FileReader", "ReadableStream", "WritableStream", "TransformStream", "MessageChannel", "BroadcastChannel", "Headers", "Request", "Response", "FormData"
];

async function getText(ctx: ScraperContext, url: string, referer: string): Promise<string | null> {
    const response = await ctx.fetch(url, { headers: { "User-Agent": USER_AGENT, Referer: referer }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const text = await response.text();
    return text.length > MAX_SCRIPT_BYTES ? null : text;
}

/** The page's flight data carries the sealed-token seed as `"en":"..."` (escaped inside a JS string). */
function pageToken(html: string): string | null {
    return /\\?"en\\?":\\?"([A-Za-z0-9_-]{40,})/.exec(html)?.[1] ?? null;
}

/** Same-origin chunks only: the webpack runtime is replaced here, polyfills and page entries are irrelevant. */
function scriptUrls(html: string): string[] {
    const urls = new Set<string>();
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
        const url = new URL(match[1]!, ORIGIN);
        if (url.origin !== ORIGIN || !url.pathname.startsWith("/_next/static/chunks/")) continue;
        if (/\/(webpack|polyfills|main-app)-|\/app\//.test(url.pathname)) continue;
        urls.add(url.href);
    }
    return [...urls].slice(0, MAX_SCRIPTS);
}

async function buildRuntime(ctx: ScraperContext, urls: string[], key: string): Promise<Runtime | null> {
    const texts = await Promise.all(urls.map((url) => getText(ctx, url, `${ORIGIN}/`).catch(() => null)));

    const modules: Record<string, Function> = {};
    const sandbox: Record<string, unknown> = {
        console: { log: noop, warn: noop, error: noop, debug: noop, info: noop, table: noop, clear: noop, trace: noop },
        navigator: { userAgent: USER_AGENT, platform: "Linux x86_64", language: "en-US", languages: ["en-US"], webdriver: false, vendor: "Google Inc.", maxTouchPoints: 0, hardwareConcurrency: 8, cookieEnabled: true, onLine: true, plugins: { length: 5 } },
        screen: { width: 1920, height: 1080 },
        innerWidth: 1920, innerHeight: 1080, name: "", chrome: { runtime: {} },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }),
        addEventListener: noop, removeEventListener: noop,
        VTTCue: class { constructor(public startTime: number, public endTime: number, public text: string) {} }
    };
    for (const name of HOST_GLOBALS) sandbox[name] = (globalThis as Record<string, unknown>)[name];
    // The player's anti-tamper checks want native-looking functions.
    const native = (name: string, fn: (...args: unknown[]) => unknown) => Object.defineProperty(fn.bind(null), "name", { value: name });
    sandbox.requestAnimationFrame = native("requestAnimationFrame", (callback) => setTimeout(() => (callback as (t: number) => void)(Date.now()), 16));
    sandbox.cancelAnimationFrame = native("cancelAnimationFrame", (id) => clearTimeout(id as NodeJS.Timeout));
    sandbox.document = {
        createElement: native("createElement", () => element()), querySelector: () => element(), querySelectorAll: () => [],
        addEventListener: noop, removeEventListener: noop, getElementsByTagName: () => [],
        head: element(), body: element(), documentElement: element(), cookie: "", referrer: `${ORIGIN}/`, currentScript: null
    };
    sandbox.parent = { postMessage: noop };
    sandbox.top = sandbox.parent;
    sandbox.opener = null;
    sandbox.location = new URL(`${ORIGIN}/`);
    sandbox.self = sandbox.window = sandbox.globalThis = sandbox;
    sandbox.webpackChunk_N_E = { push(chunk: [unknown, Record<string, Function>]) { Object.assign(modules, chunk[1]); } };

    const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });
    texts.forEach((text, i) => {
        if (!text) return;
        try { vm.runInContext(text, context, { filename: urls[i]!, timeout: SCRIPT_RUN_TIMEOUT_MS }); } catch { /* an unrelated chunk */ }
    });

    const sources = new Map<string, string>();
    const playerId = Object.keys(modules).find((id) => {
        const source = modules[id]!.toString();
        sources.set(id, source);
        const at = source.indexOf(SERVER_LIST_ANCHOR);
        return at >= 0 && /^\(\{crypto:\w+,encode:\w+,server:/.test(source.slice(at, at + 80));
    });
    if (!playerId) return null;
    const original = sources.get(playerId)!;
    const listAt = original.indexOf(SERVER_LIST_ANCHOR);
    const streamAt = original.indexOf(STREAM_ANCHOR);
    const listFn = nameBefore(original, listAt);
    const streamFn = streamAt >= 0 ? nameBefore(original, streamAt) : undefined;
    const refs = /^\(\{crypto:(\w+),encode:(\w+),server:/.exec(original.slice(listAt, listAt + 80));
    const bufferRef = streamAt >= 0 ? /Buffer:(\w+),atob:/.exec(original.slice(streamAt, streamAt + 4000))?.[1] : undefined;
    let fetchAt = original.indexOf(STREAM_FETCH_ANCHOR);
    let call: RegExpExecArray | null = null;
    while (fetchAt >= 0 && !(call = STREAM_FETCH.exec(original.slice(fetchAt, fetchAt + 600)))) fetchAt = original.indexOf(STREAM_FETCH_ANCHOR, fetchAt + 1);
    if (!listFn || !refs || !streamFn || !bufferRef || !call) return null;
    const [, cryptoRef, encodeRef] = refs;
    const [, base, aliasName, index, literal, csrf] = call;

    // The string-table reader is the alias the request calls with a numeric index (`a = readString` earlier in that scope).
    const reader = aliasName ? [...original.slice(Math.max(0, fetchAt - 30_000), fetchAt).matchAll(new RegExp(`[,{ ]${aliasName}=(\\w{2,})[;,]`, "g"))].pop()?.[1] : undefined;
    if (!literal && !reader) return null;

    const patched = vm.runInContext(`(${original.replace(/\}$/, `;globalThis.__vf={list:${listFn},stream:${streamFn},crypto:${cryptoRef},encode:${encodeRef},buffer:${bufferRef}${reader ? `,str:${reader}` : ""}}}`)})`, context) as Function;

    const cache: Record<string, { exports: unknown }> = {};
    const require = (id: string): unknown => {
        if (cache[id]) return cache[id]!.exports;
        const module = (cache[id] = { exports: {} });
        const fn = id === playerId ? patched : modules[id];
        if (!fn) throw new Error(`missing module ${id}`);
        fn.call(module.exports, module, module.exports, require);
        return module.exports;
    };
    const define = (target: object, definition: Record<string, () => unknown>) => { for (const k of Object.keys(definition)) if (!Object.prototype.hasOwnProperty.call(target, k)) Object.defineProperty(target, k, { enumerable: true, get: definition[k]! }); };
    Object.assign(require, {
        d: define,
        r: (target: object) => { Object.defineProperty(target, Symbol.toStringTag, { value: "Module" }); Object.defineProperty(target, "__esModule", { value: true }); },
        n: (m: { __esModule?: boolean; default?: unknown }) => { const getter = () => (m && m.__esModule ? m.default : m); define(getter, { a: getter }); return getter; },
        o: (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k),
        g: sandbox, nmd: (m: unknown) => m, e: () => Promise.resolve(), u: (x: unknown) => x, p: "/_next/", miniCssF: () => "", l: noop, h: () => "x", t: (v: unknown) => v
    });
    try { require(playerId); } catch { return null; }

    const entry = sandbox.__vf as (Runtime["entry"] & { str?: (index: number) => string }) | undefined;
    if (!entry) return null;
    const segment = literal ?? entry.str?.(Number(index));
    if (!segment) return null;
    return { key, builtAt: Date.now(), sandbox, context, entry, request: { base: base!, headers: JSON.parse(csrf!) as Record<string, string>, segment } };
}

/** `fetch` for the sandbox: relative URLs resolve against vidfast, any other host is refused. */
function sandboxFetch(ctx: ScraperContext, referer: string) {
    return (input: unknown, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(String(input), ORIGIN);
        if (url.origin !== ORIGIN) return Promise.reject(new TypeError("blocked host"));
        return ctx.fetch(url.href, { ...init, headers: { "User-Agent": USER_AGENT, Referer: referer, ...(init.headers as Record<string, string> | undefined) }, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    };
}

/** The globals object a program receives, built inside the context so it sees its own realm's builtins. */
function programGlobals(rt: Runtime, extra: Record<string, unknown>): Record<string, unknown> {
    const make = vm.runInContext(`(function (host) { return Object.assign({
        window, document, navigator, localStorage, console, screen, JSON, Math, Date, RegExp, Map, Set, WeakMap, WeakSet, Array, Object, Number, String, Boolean, Symbol, Function,
        Error, TypeError, RangeError, SyntaxError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, NaN, Infinity, undefined, Promise, Proxy, Reflect,
        Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt,
        TextEncoder, TextDecoder, URL, URLSearchParams, AbortSignal, AbortController, atob, btoa
    }, host); })`, rt.context) as (host: Record<string, unknown>) => Record<string, unknown>;
    return make(extra);
}

function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
}

/**
 * Opens a title: loads (or reuses) the player for the current deploy and lets
 * its own code fetch the server list. `null` when the page, the bundle's shape
 * or the sealed exchange isn't what this expects any more.
 */
export async function openTitle(ctx: ScraperContext, path: string): Promise<VidfastSession | null> {
    const pageUrl = `${ORIGIN}${path}`;
    const html = await getText(ctx, pageUrl, `${ORIGIN}/`);
    const en = html && pageToken(html);
    if (!html || !en) return null;
    const urls = scriptUrls(html);
    if (!urls.length) return null;
    const key = urls.join("|");

    if (!runtime || runtime.key !== key || Date.now() - runtime.builtAt > RUNTIME_MAX_AGE_MS) {
        runtime = null;
        runtime = await buildRuntime(ctx, urls, key);
        if (!runtime) return null;
    }
    const rt = runtime;
    const { entry, request } = rt;

    let servers: VidfastServer[] | null = null;
    await exclusive(async () => {
        rt.sandbox.location = new URL(pageUrl);
        const host = programGlobals(rt, {
            crypto: entry.crypto, encode: entry.encode, Buffer: entry.buffer, en, server: undefined,
            setServers: (list: VidfastServer[]) => { servers = list; }, setState: (x: unknown) => console.error('STATE', x), setFavServer: noop,
            fetch: sandboxFetch(ctx, `${ORIGIN}/`)
        });
        try { await entry.list(host); } catch (e) { console.error('LISTERR', e); }
    });
    const list = servers as VidfastServer[] | null;
    if (!list?.length) return null;

    return {
        servers: list,
        stream: (server) => exclusive(async () => {
            const response = await ctx.fetch(`${ORIGIN}${request.base}/${request.segment}/${server.data}`, {
                method: "POST", headers: { "User-Agent": USER_AGENT, Referer: pageUrl, ...request.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!response.ok) return null;
            const script = await response.text();
            const result: unknown[] = [];
            rt.sandbox.location = new URL(pageUrl);
            try {
                await entry.stream(programGlobals(rt, { dr: result, rs: script, crypto: entry.crypto, Buffer: entry.buffer, fetch: sandboxFetch(ctx, pageUrl) }));
            } catch { return null; }
            const found = result[0] as VidfastStream | undefined;
            return found && typeof found.url === "string" && /^https?:/.test(found.url) ? found : null;
        })
    };
}
