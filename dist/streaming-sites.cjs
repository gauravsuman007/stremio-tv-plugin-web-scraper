"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.mts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// src/shared.mts
var TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
var TMDB_BASE = "https://api.themoviedb.org/3";
var DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
async function tmdbSearch(fetchImpl, query) {
  const url = new URL(`${TMDB_BASE}/search/multi`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");
  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`TMDB search failed: ${response.status}`);
  const data = await response.json();
  const results2 = [];
  for (const r of data.results) {
    if (r.media_type !== "movie" && r.media_type !== "tv") continue;
    const dateStr = r.media_type === "movie" ? r.release_date : r.first_air_date;
    const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
    const title = (r.media_type === "movie" ? r.title : r.name) || query;
    results2.push({ tmdbId: r.id, mediaType: r.media_type, title, year: Number.isFinite(year) ? year : null, originalLanguage: r.original_language });
  }
  return results2;
}
async function tmdbFindByImdbId(fetchImpl, imdbId) {
  const url = new URL(`${TMDB_BASE}/find/${imdbId}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("external_source", "imdb_id");
  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`TMDB find failed: ${response.status}`);
  const data = await response.json();
  const movie = data.movie_results[0];
  if (movie) {
    const year = movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : null;
    return { tmdbId: movie.id, mediaType: "movie", title: movie.title || imdbId, year: Number.isFinite(year) ? year : null, originalLanguage: movie.original_language };
  }
  const tv = data.tv_results[0];
  if (tv) {
    const year = tv.first_air_date ? Number.parseInt(tv.first_air_date.slice(0, 4), 10) : null;
    return { tmdbId: tv.id, mediaType: "tv", title: tv.name || imdbId, year: Number.isFinite(year) ? year : null, originalLanguage: tv.original_language };
  }
  return null;
}
var MATCH_TTL_MS = 6e4;
var matchCache = /* @__PURE__ */ new Map();
function resolveTmdbMatch(query, fetchImpl) {
  const key = `${query.type}|${query.id}|${query.title}`;
  const cached = matchCache.get(key);
  if (cached && Date.now() - cached.at < MATCH_TTL_MS) return cached.match;
  const match = lookupTmdbMatch(query, fetchImpl);
  matchCache.set(key, { at: Date.now(), match });
  match.catch(() => matchCache.delete(key));
  return match;
}
async function lookupTmdbMatch(query, fetchImpl) {
  const wantType = query.type === "series" || query.type === "tv" ? "tv" : "movie";
  const imdbId = /^tt\d+/.exec(query.id)?.[0];
  if (imdbId) return tmdbFindByImdbId(fetchImpl, imdbId);
  const matches = await tmdbSearch(fetchImpl, query.title);
  return matches.find((m) => m.mediaType === wantType) ?? matches[0] ?? null;
}
function mediaHeaders(site) {
  return { Referer: site.referrer, ...site.headers };
}
var languageNames = new Intl.DisplayNames(["en"], { type: "language" });
function languageName(code) {
  const clean = code.trim();
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(clean)) return clean;
  try {
    const name = languageNames.of(clean);
    return name && name !== clean ? name : clean;
  } catch {
    return clean;
  }
}
function audioLanguages(master) {
  const names = [];
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/.test(line)) continue;
    const language = /LANGUAGE="([^"]+)"/.exec(line)?.[1];
    const name = /NAME="([^"]+)"/.exec(line)?.[1];
    const label = language ? languageName(language) : name && !/^(audio|default|main|stereo|und)\b/i.test(name) ? name : void 0;
    if (label && !names.includes(label)) names.push(label);
  }
  return names;
}
async function expandMasterPlaylist(fetchImpl, masterUrl, headers2) {
  if (DIRECT_FILE_RE.test(masterUrl)) {
    const response2 = await fetchImpl(masterUrl, { headers: { ...headers2, Range: "bytes=0-1023" } });
    if (!response2.ok) throw new Error(`direct file not fetchable: ${response2.status}`);
    return [{ resolution: null, bandwidth: null, url: masterUrl }];
  }
  const response = await fetchImpl(masterUrl, { headers: headers2 });
  if (!response.ok) throw new Error(`master playlist not fetchable: ${response.status}`);
  const text = await response.text();
  if (!text.startsWith("#EXTM3U")) throw new Error("not a valid HLS playlist");
  if (!text.includes("#EXT-X-STREAM-INF")) return [{ resolution: null, bandwidth: null, url: masterUrl }];
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audio = audioLanguages(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.startsWith("#EXT-X-STREAM-INF")) continue;
    const uriLine = lines[i + 1]?.trim();
    if (!uriLine || uriLine.startsWith("#")) continue;
    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
    const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
    variants.push({
      resolution: resolutionMatch?.[1] ?? null,
      bandwidth: bandwidthMatch?.[1] ? Number.parseInt(bandwidthMatch[1], 10) : null,
      url: new URL(uriLine, masterUrl).toString(),
      audio
    });
  }
  if (!variants.length) return [{ resolution: null, bandwidth: null, url: masterUrl }];
  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  return variants;
}
var MIN_PLAUSIBLE_DURATION_S = 300;
async function leafDuration(fetchImpl, url, headers2) {
  const response = await fetchImpl(url, { headers: headers2 });
  if (!response.ok) throw new Error(`playlist not fetchable: ${response.status}`);
  const text = await response.text();
  if (!text.includes("#EXT-X-ENDLIST") && !text.includes("#EXT-X-PLAYLIST-TYPE:VOD")) return null;
  let total = 0;
  for (const match of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number.parseFloat(match[1]);
  return total;
}
function variantHeight(variant) {
  const [width = 0, height = 0] = (variant.resolution ?? "").split("x").map((n) => Number.parseInt(n, 10) || 0);
  const exact = STANDARD_HEIGHTS.find((standard) => Math.abs(height - standard) <= standard * 0.05);
  if (exact) return exact;
  const tall = Math.max(height, Math.round(width * 9 / 16));
  return STANDARD_HEIGHTS.find((standard) => tall >= standard * 0.95) ?? tall;
}
var STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 576, 480, 360, 240];
function heightFromUrl(url) {
  return Number.parseInt(/[-_/.]s?(\d{3,4})p(?=[-_/.?]|$)/i.exec(url)?.[1] ?? "0", 10) || 0;
}
var BEST_POSSIBLE_HEIGHT = 2160;
var SOFT_DEADLINE_MS = 1e4;
var RESOLVE_DEADLINE_MS = 6e4;
async function verifyCapture(base, capture, match, ctx) {
  const displayTitle = displayName(match);
  const { mediaUrl, label } = capture;
  const site = { ...base, referrer: capture.referrer ?? base.referrer, headers: capture.headers ?? base.headers };
  const variants = await expandMasterPlaylist(ctx.fetch, mediaUrl, mediaHeaders(site)).catch(() => null);
  const top = variants?.[0];
  if (!variants || !top) return null;
  if (!DIRECT_FILE_RE.test(top.url)) {
    const duration = await leafDuration(ctx.fetch, top.url, mediaHeaders(site)).catch(() => 0);
    if (duration !== null && duration < MIN_PLAUSIBLE_DURATION_S) return null;
  }
  const height = Math.max(...variants.map(variantHeight)) || heightFromUrl(mediaUrl);
  const original = match.originalLanguage ? languageName(match.originalLanguage) : void 0;
  const stated = (capture.audio?.length ? capture.audio : top.audio ?? []).map(languageName).sort((a, b) => Number(b === original) - Number(a === original));
  const audio = stated.length ? stated : original ? [`${original} (assumed)`] : [];
  const dubbed = Boolean(original && stated.length && !stated.includes(original));
  const score = height * 1e9 + Math.max(...variants.map((v) => v.bandwidth ?? 0)) - (dubbed ? 5e8 : 0);
  const resolutions = variants.map((v) => v.resolution).filter((r) => Boolean(r));
  const multi = variants.length > 1;
  const mirror = label ? `${site.name} mirror: ${label}` : site.name;
  return {
    score,
    height,
    label,
    link: {
      url: multi ? mediaUrl : top.url,
      resolveKind: "hls",
      quality: resolutions.length ? `${resolutions.join("/")} \xB7 ${label ?? site.name}` : height ? `${height}p \xB7 ${label ?? site.name}` : mirror,
      title: displayTitle,
      referrer: site.referrer,
      ...site.headers && Object.keys(site.headers).length ? { headers: site.headers } : {},
      ...height ? { height } : {},
      ...audio.length ? { audio } : {},
      ...label ? { server: label } : {}
    }
  };
}
function collectCandidates(site, captures, match, ctx, deadlineMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const candidates = [];
    let pending = 0;
    let exhausted = false;
    let finished = false;
    let softTimer;
    const finish = (complete) => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      clearTimeout(softTimer);
      void captures.return(void 0).catch(() => {
      });
      candidates.sort((a, b) => b.score - a.score);
      resolve({ candidates, complete: complete || candidates.length > 0 });
    };
    const hardTimer = setTimeout(() => finish(false), deadlineMs);
    const onCandidate = (candidate) => {
      candidates.push(candidate);
      if (candidate.height >= BEST_POSSIBLE_HEIGHT) return finish(true);
      softTimer ??= setTimeout(() => finish(true), Math.max(0, SOFT_DEADLINE_MS - (Date.now() - startedAt)));
    };
    void (async () => {
      try {
        while (!finished) {
          const step = await captures.next();
          if (step.done || finished) break;
          pending++;
          void verifyCapture(site, step.value, match, ctx).catch(() => null).then((candidate) => {
            pending--;
            if (candidate && !finished) onCandidate(candidate);
            if (exhausted && pending === 0) finish(true);
          });
        }
      } catch {
      }
      exhausted = true;
      if (pending === 0) finish(true);
    })();
  });
}
function displayName(match) {
  return match.year ? `${match.title} (${match.year})` : match.title;
}
var LINK_MAX_AGE_MS = 6 * 60 * 6e4;
var PROBE_TIMEOUT_MS = 5e3;
var linkCache = /* @__PURE__ */ new Map();
function linkKey(resolveId, query) {
  return `${resolveId}|${query.type}|${query.id}|${query.season ?? ""}|${query.episode ?? ""}`;
}
function rememberLinks(site, candidates, query) {
  const now = Date.now();
  for (const [key, entry] of linkCache) if (now - entry.at > LINK_MAX_AGE_MS) linkCache.delete(key);
  if (candidates[0]) linkCache.set(linkKey(site.id, query), { at: now, link: candidates[0].link });
  for (const candidate of candidates) {
    if (candidate.label) linkCache.set(linkKey(`${site.id}~${candidate.label}`, query), { at: now, link: candidate.link });
  }
}
async function stillPlays(link, ctx) {
  try {
    const response = await ctx.fetch(link.url, {
      headers: { Referer: link.referrer ?? "", ...link.headers, ...DIRECT_FILE_RE.test(link.url) ? { Range: "bytes=0-1023" } : {} },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    if (DIRECT_FILE_RE.test(link.url)) return response.ok;
    return response.ok && (await response.text()).trimStart().startsWith("#EXTM3U");
  } catch {
    return false;
  }
}
async function candidatesFor(site, query, ctx, deadlineMs) {
  const match = await resolveTmdbMatch(query, ctx.fetch);
  if (!match) return null;
  const target = { match, season: query.season, episode: query.episode };
  const result = await collectCandidates(site, site.httpCaptures(target, ctx), match, ctx, deadlineMs);
  rememberLinks(site, result.candidates, query);
  if (result.complete) results.set(linkKey(site.id, query), { at: Date.now(), found: { match, ...result } });
  return { match, ...result };
}
var results = /* @__PURE__ */ new Map();
function recentResult(site, query) {
  const now = Date.now();
  for (const [key, entry] of results) if (now - entry.at > LINK_MAX_AGE_MS) results.delete(key);
  return results.get(linkKey(site.id, query))?.found;
}
var inflight = /* @__PURE__ */ new Map();
function sharedCandidates(site, query, ctx) {
  const key = linkKey(site.id, query);
  let run = inflight.get(key);
  if (!run) {
    run = candidatesFor(site, query, ctx, RESOLVE_DEADLINE_MS).catch(() => null).finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  return run;
}
async function resolveSite(site, resolveId, query, ctx) {
  const cached = linkCache.get(linkKey(resolveId, query));
  if (cached && Date.now() - cached.at < LINK_MAX_AGE_MS && await stillPlays(cached.link, ctx)) return cached.link;
  let found = await sharedCandidates(site, query, ctx);
  if (!found?.candidates.length && cached) found = await sharedCandidates(site, query, ctx);
  if (!found) return null;
  const label = resolveId.includes("~") ? resolveId.slice(resolveId.indexOf("~") + 1) : void 0;
  return (found.candidates.find((c) => label && c.label === label) ?? found.candidates[0])?.link ?? null;
}
var MAX_ROWS_PER_SITE = 3;
var SEARCH_MARGIN_MS = 500;
async function searchSite(site, query, ctx) {
  if (site.available && !await site.available(ctx).catch(() => false)) return [];
  const budgetMs = Math.max(1e3, ctx.budgetMs - SEARCH_MARGIN_MS);
  const found = recentResult(site, query) ?? await Promise.race([sharedCandidates(site, query, ctx), new Promise((r) => setTimeout(() => r("late"), budgetMs))]);
  if (found === "late") {
    const match = await resolveTmdbMatch(query, ctx.fetch).catch(() => null);
    return match ? [{ url: "", resolveId: site.id, resolveKind: "hls", title: `${displayName(match)} \xB7 ${site.name}` }] : [];
  }
  if (!found?.candidates.length) return [];
  const title = `${displayName(found.match)} \xB7 ${site.name}`;
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [index, candidate] of found.candidates.entries()) {
    if (!candidate.label && index > 0) continue;
    const resolveId = candidate.label ? `${site.id}~${candidate.label}` : site.id;
    if (seen.has(resolveId) || seen.has(candidate.link.url)) continue;
    seen.add(resolveId).add(candidate.link.url);
    rows.push({
      url: "",
      resolveId,
      resolveKind: "hls",
      title,
      quality: candidate.link.quality,
      ...candidate.height ? { height: candidate.height } : {},
      ...candidate.link.audio ? { audio: candidate.link.audio } : {},
      ...candidate.label ? { server: candidate.label } : {}
    });
    if (rows.length >= MAX_ROWS_PER_SITE) break;
  }
  return rows;
}
function createScraper(site) {
  return {
    id: site.id,
    name: `${site.name} \xB7 up to ${site.maxQuality}`,
    maxQuality: site.maxQuality,
    fetchMethod: "fast",
    search: (query, ctx) => searchSite(site, query, ctx),
    resolve: (resolveId, query, ctx) => resolveSite(site, resolveId, query, ctx)
  };
}

// src/sites/7movies.mts
var BASE = "https://embed.vidrift.net";
var TIMEOUT_MS = 15e3;
var PROVIDERS = ["moviebox", "vaplayer", "vidlove", "vidrock"];
var sevenMoviesSite = {
  id: "7movies",
  name: "7Movies",
  referrer: `${BASE}/`,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const headers2 = { Referer: `${BASE}/embed2/${path}` };
    const seen = /* @__PURE__ */ new Set();
    const offer = function* (streams) {
      for (const stream of streams ?? []) {
        const raw = stream.proxyUrl || stream.url;
        if (!raw || stream.type && stream.type !== "hls") continue;
        const mediaUrl = new URL(raw, BASE).href;
        if (seen.has(mediaUrl)) continue;
        seen.add(mediaUrl);
        const language = /\u00b7\s*(.+)$/.exec(stream.name ?? "")?.[1]?.trim();
        yield {
          mediaUrl,
          label: stream.name || stream.provider || void 0,
          ...language && !/^original$/i.test(language) ? { audio: [language] } : {}
        };
      }
    };
    const boot = await ctx.fetch(`${BASE}/api/boot/${path}?`, { headers: { ...headers2, "x-embed-parent": "" }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.ok ? r.json() : null).catch(() => null);
    const token = boot?.meta?.playbackToken;
    const answers = token ? PROVIDERS.map(
      (provider) => ctx.fetch(`${BASE}/api/source/${path}?token=${encodeURIComponent(token)}&provider=${provider}`, { headers: headers2, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.ok ? r.json() : null).catch(() => null)
    ) : [];
    if (boot?.meta?.evionUrl) yield* offer([{ url: boot.meta.evionUrl, type: "hls", provider: "Evion" }]);
    yield* offer((await answers[0])?.streams);
    yield* offer(boot?.meta?.warmStreams);
    for (const answer of answers.slice(1)) yield* offer((await answer)?.streams);
  }
};
var movies_default = createScraper(sevenMoviesSite);

// src/sites/cinezo.mts
var PLAYER = "https://player.cinezo.live/";
var API_TIMEOUT_MS = 2e4;
var cinezoSite = {
  id: "cinezo",
  name: "Cinezo",
  referrer: PLAYER,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie?id=${match.tmdbId}` : `tv?id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;
    const response = await ctx.fetch(`https://proxy1.flikhub.net/${path}&mode=json&sources=berlin&hevc=1`, {
      headers: { Referer: PLAYER, Origin: PLAYER.slice(0, -1) },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (!response.ok) return;
    const body = await response.json();
    if (body.source?.url) yield { mediaUrl: body.source.url, label: "Berlin" };
  }
};
var cinezo_default = createScraper(cinezoSite);

// src/sites/bciney.mts
var PLAYER2 = "https://player.bciney.to";
var TIMEOUT_MS2 = 3e4;
function jsonArrayAfter(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return null;
  const start = text.indexOf("[", at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "[" || c === "{") depth++;
    else if ((c === "]" || c === "}") && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}
var bcineySite = {
  id: "bciney",
  name: "bCine",
  referrer: `${PLAYER2}/`,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const response = await ctx.fetch(`${PLAYER2}/embed/${path}?autoplay=true`, { signal: AbortSignal.timeout(TIMEOUT_MS2) });
    if (!response.ok) return;
    const html = await response.text();
    const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => JSON.parse(m[1])).join("");
    const servers = jsonArrayAfter(flight, '"initialServers":') ?? [];
    for (const server of servers) {
      if (server.url && (!server.type || server.type === "hls")) yield { mediaUrl: server.url, label: server.name };
    }
  }
};
var bciney_default = createScraper(bcineySite);

// src/sites/cinejoy.mts
var import_node_crypto = require("node:crypto");
var BASE_URL = "https://cinejoy.pk";
var API = "https://api.wing.st";
var TIMEOUT_MS3 = 15e3;
var RESPONSE_AAD = new TextEncoder().encode("lumen-gate-v2\0");
var crushModule;
async function crush(fetchImpl) {
  crushModule ??= fetchImpl(`${API}/crush.wasm`, { signal: AbortSignal.timeout(TIMEOUT_MS3) }).then((r) => {
    if (!r.ok) throw new Error(`crush.wasm ${r.status}`);
    return r.arrayBuffer();
  }).then(async (bytes) => {
    const module3 = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module3).length) throw new Error("crush.wasm now has imports");
    return module3;
  });
  const module2 = await crushModule.catch((err) => {
    crushModule = void 0;
    throw err;
  });
  return (await WebAssembly.instantiate(module2, {})).exports;
}
async function listServers(fetchImpl) {
  const response = await fetchImpl(`${API}/servers`, { signal: AbortSignal.timeout(TIMEOUT_MS3) });
  if (!response.ok) throw new Error(`Failed to list servers: ${response.status}`);
  const data = await response.json();
  return data.servers;
}
async function askServer(fetchImpl, path, payload) {
  const wasm = await crush(fetchImpl);
  const json = new TextEncoder().encode(JSON.stringify({ path, payload }));
  const rand = (0, import_node_crypto.randomBytes)(44);
  const outLen = 616 + json.length;
  const pJson = wasm.alloc(json.length), pRand = wasm.alloc(rand.length), pOut = wasm.alloc(outLen);
  let sealed;
  try {
    new Uint8Array(wasm.memory.buffer).set(json, pJson);
    new Uint8Array(wasm.memory.buffer).set(rand, pRand);
    const written = wasm.seal_request(pJson, json.length, pRand, rand.length, pOut, outLen);
    if (written <= 98) throw new Error(`seal_request returned ${written}`);
    sealed = new Uint8Array(wasm.memory.buffer).slice(pOut, pOut + written);
  } finally {
    wasm.dealloc(pJson, json.length);
    wasm.dealloc(pRand, rand.length);
    wasm.dealloc(pOut, outLen);
  }
  const key = sealed.subarray(0, 32), body = new Uint8Array(sealed.subarray(98));
  const response = await fetchImpl(`${API}/g`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: BASE_URL, Referer: `${BASE_URL}/` },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS3)
  });
  if (!response.ok) return [];
  const answer = new Uint8Array(await response.arrayBuffer());
  const aad = new Uint8Array(RESPONSE_AAD.length + 67);
  aad.set(RESPONSE_AAD);
  aad.set(body.subarray(0, 67), RESPONSE_AAD.length);
  const aesKey3 = await import_node_crypto.webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await import_node_crypto.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: answer.subarray(0, 12), additionalData: aad }, aesKey3, answer.subarray(12));
  const data = JSON.parse(new TextDecoder().decode(plain));
  return (data.data?.stream ?? []).filter((s) => s.playlist && (!s.type || s.type === "hls")).map((s) => s.playlist);
}
var cinejoySite = {
  id: "cinejoy",
  name: "CineJoy",
  referrer: `${BASE_URL}/`,
  maxQuality: "4K",
  async available(ctx) {
    return (await listServers(ctx.fetch)).some((s) => s.status === "ok");
  },
  async *httpCaptures({ match, season, episode }, ctx) {
    const servers = (await listServers(ctx.fetch)).filter((s) => s.status === "ok").sort((a, b) => Number(b["4k"]) - Number(a["4k"]));
    const payload = { tmdb: String(match.tmdbId), title: match.title };
    if (match.year) payload.year = String(match.year);
    if (match.mediaType === "tv") Object.assign(payload, { season: String(season ?? 1), episode: String(episode ?? 1) });
    const kind = match.mediaType === "movie" ? "movie" : "series";
    for (const server of servers) {
      const playlists = await askServer(ctx.fetch, `/${server.name}/${kind}`, payload).catch(() => []);
      for (const mediaUrl of playlists) yield { mediaUrl, label: server.name };
    }
  }
};
var cinejoy_default = createScraper(cinejoySite);

// src/sites/flixer.mts
var import_node_crypto2 = require("node:crypto");
var BASE_URL2 = "https://flixer.gd";
var API2 = "https://plsdontscrapemelove.flixer.gd";
var TIMEOUT_MS4 = 15e3;
var KEY_ROUNDS = 600;
var NATO = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray", "yankee", "zulu"];
function newSession() {
  return { apiKey: (0, import_node_crypto2.randomBytes)(32).toString("hex"), rootKeys: /* @__PURE__ */ new Map() };
}
function rootKey(session, hour) {
  let key = session.rootKeys.get(hour);
  if (!key) {
    const salt = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) salt[i] = i + 1 ^ Number(BigInt(hour) >> BigInt(i & 7) & 0xffn);
    key = (0, import_node_crypto2.createHash)("sha256").update(Buffer.concat([Buffer.from(session.apiKey), salt])).digest();
    for (let i = 1; i < KEY_ROUNDS; i++) key = (0, import_node_crypto2.createHash)("sha256").update(key).digest();
    session.rootKeys.set(hour, key);
  }
  return key;
}
async function serverTime(fetchImpl, session) {
  session.clockSkew ??= fetchImpl(`${API2}/api/time?t=${Date.now()}`, { signal: AbortSignal.timeout(TIMEOUT_MS4) }).then(async (r) => (await r.json()).timestamp - Date.now() / 1e3).catch(() => 0);
  return Math.floor(Date.now() / 1e3 + await session.clockSkew);
}
function decrypt(session, body, time) {
  const data = Buffer.from(body.trim(), "base64");
  for (const t of [time, time - 300, time + 300]) {
    const key = (0, import_node_crypto2.createHmac)("sha256", rootKey(session, Math.floor(t / 3600))).update(`${Math.floor(t / 300)}${session.apiKey}`).digest();
    const decipher = (0, import_node_crypto2.createDecipheriv)("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(data.length - 16));
    try {
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString());
    } catch {
    }
  }
  throw new Error("flixer: could not decrypt answer");
}
async function ask(fetchImpl, session, path, server) {
  const time = await serverTime(fetchImpl, session);
  const nonce = (0, import_node_crypto2.randomBytes)(16).toString("base64").replace(/[/+=]/g, "").slice(0, 22);
  const signature = (0, import_node_crypto2.createHmac)("sha256", session.apiKey).update(`${session.apiKey}:${time}:${nonce}:${path}`).digest("base64");
  const response = await fetchImpl(`${API2}${path}`, {
    headers: {
      Accept: "text/plain",
      Origin: BASE_URL2,
      Referer: `${BASE_URL2}/`,
      "X-Api-Key": session.apiKey,
      "X-Request-Timestamp": String(time),
      "X-Request-Nonce": nonce,
      "X-Request-Signature": signature,
      "X-Client-Fingerprint": "tomljm",
      "X-Fingerprint-Lite": "b4f8a1fc72e905d63e",
      ...server ? { "X-Only-Sources": "1", "X-Server": server } : { bW90aGFmYWth: "1" }
    },
    signal: AbortSignal.timeout(TIMEOUT_MS4)
  });
  if (!response.ok) return null;
  return decrypt(session, await response.text(), time);
}
function sourceUrl(answer, server) {
  const sources = answer?.sources;
  if (!sources) return void 0;
  if (Array.isArray(sources)) return sources.find((s) => s.server?.toLowerCase() === server && s.url)?.url ?? sources.find((s) => s.url)?.url;
  return sources.file || sources.url || void 0;
}
var flixerSite = {
  id: "flixer",
  name: "Flixer",
  referrer: `${BASE_URL2}/`,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `/api/tmdb/movie/${match.tmdbId}/images` : `/api/tmdb/tv/${match.tmdbId}/season/${season ?? 1}/episode/${episode ?? 1}/images`;
    const session = newSession();
    const listed = Object.keys((await ask(ctx.fetch, session, path).catch(() => null))?.servers ?? {});
    const servers = listed.length ? NATO.filter((s) => listed.includes(s)).concat(listed.filter((s) => !NATO.includes(s))) : NATO.slice(0, 8);
    const answers = servers.map((server) => ask(ctx.fetch, session, path, server).catch(() => null));
    for (const [i, server] of servers.entries()) {
      const mediaUrl = sourceUrl(await answers[i], server);
      if (mediaUrl) yield { mediaUrl, label: server };
    }
  }
};
var flixer_default = createScraper(flixerSite);

// src/sites/movy.mts
var BASE_URL3 = "https://www.movy.sx";
var API3 = "https://api.wecollege.net";
var TIMEOUT_MS5 = 15e3;
var PROVIDERS2 = ["miami", "boise", "atlanta", "paris"];
var MAGIC = [109, 118, 109, 49];
var GOLDEN = 2654435769;
function fmix(h) {
  h >>>= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  return (h ^ h >>> 16) >>> 0;
}
function rotl(x, n) {
  x >>>= 0;
  n &= 31;
  return n === 0 ? x : (x << n | x >>> 32 - n) >>> 0;
}
function keystream(seed, mediaId, length) {
  let fnv = 2166136261;
  for (let i = 0; i < seed.length; i++) fnv = Math.imul(fnv ^ seed.charCodeAt(i), 16777619) >>> 0;
  let n = fmix(fmix(fnv) ^ fmix(mediaId >>> 0 ^ GOLDEN)) >>> 0;
  const state = new Array(61);
  for (let i = 0; i < 8; i++) {
    const slot = n % 61;
    n = rotl(n + GOLDEN >>> 0, 7 + (7 & i));
    state[slot] = (n ^ fmix(n)) >>> 0;
    n = fmix(n + slot >>> 0);
  }
  let acc = fmix(2779096485 ^ n) >>> 0;
  const out = new Uint8Array(length);
  for (let pos = 0, step = 0; pos < length; step++) {
    const slot = acc % 61;
    const mask = slot in state ? -1 : 0;
    const s = (state[slot] >>> 0 ^ Math.imul(GOLDEN, step + 1) >>> 0) >>> 0;
    let b = ((acc ^ s) >>> 0 | (acc & s & mask) >>> 0) >>> 0;
    b = (rotl(b + acc >>> 0, 31 & slot) ^ rotl(acc, 31 & Math.imul(slot, 7))) >>> 0;
    acc = fmix(b + GOLDEN >>> 0);
    state[slot] = acc;
    for (let k = 0; k < 4 && pos < length; k++) out[pos++] = acc >>> 8 * k & 255;
  }
  return out;
}
function decrypt2(body, seed, mediaId) {
  const data = Buffer.from(body.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const stream = keystream(seed, mediaId, data.length);
  for (let i = 0; i < data.length; i++) data[i] ^= stream[i];
  if (MAGIC.some((byte, i) => data[i] !== byte)) throw new Error("movy: bad seed");
  return data.subarray(MAGIC.length).toString("utf8");
}
var headers = { Origin: BASE_URL3, Referer: `${BASE_URL3}/` };
async function getSeed(fetchImpl, mediaId) {
  const response = await fetchImpl(`${API3}/seed?mediaId=${mediaId}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS5) });
  if (!response.ok) throw new Error(`movy seed ${response.status}`);
  return (await response.json()).seed;
}
var movySite = {
  id: "movy",
  name: "Movy",
  referrer: `${BASE_URL3}/`,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const seed = await getSeed(ctx.fetch, match.tmdbId);
    const answers = PROVIDERS2.map((provider) => {
      const params = new URLSearchParams({
        title: encodeURIComponent(match.title),
        mediaType: match.mediaType,
        ...match.year ? { year: String(match.year) } : {},
        episodeId: String(episode ?? 1),
        seasonId: String(season ?? 1),
        tmdbId: String(match.tmdbId),
        enc: "2",
        seed
      });
      return ctx.fetch(`${API3}/${provider}/sources?${params}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS5) }).then(async (r) => r.ok ? JSON.parse(decrypt2(await r.text(), seed, match.tmdbId)).sources : void 0).catch(() => void 0);
    });
    for (const [i, answer] of answers.entries()) {
      const mediaUrl = (await answer)?.find((s) => s.url)?.url;
      if (mediaUrl) yield { mediaUrl, label: PROVIDERS2[i] };
    }
  }
};
var movy_default = createScraper(movySite);

// src/sites/moviesapi.mts
var SITE = "https://moviesapi.to/";
var PLAYER_KEY = "3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13";
var API_TIMEOUT_MS2 = 2e4;
var moviesapiSite = {
  id: "moviesapi",
  name: "MoviesAPI",
  referrer: SITE,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const response = await ctx.fetch(`${SITE}api/vidora/v1/${path}`, {
      headers: { Referer: SITE, Origin: SITE.slice(0, -1), "x-player-key": PLAYER_KEY },
      signal: AbortSignal.timeout(API_TIMEOUT_MS2)
    });
    if (!response.ok) return;
    const body = await response.json();
    if (!body.result) return;
    for (const source of body.sources ?? []) {
      if (source.url) yield { mediaUrl: source.url, label: source.source };
    }
  }
};
var moviesapi_default = createScraper(moviesapiSite);

// src/sites/vidrock.mts
var import_node_crypto3 = require("node:crypto");
var SITE2 = "https://vidrock.net/";
var KEY_HEX = "7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f";
var SERVERS = ["Orion", "Luna"];
var API_TIMEOUT_MS3 = 2e4;
var IV_BYTES = 12;
var aesKey;
function importKey() {
  aesKey ??= import_node_crypto3.webcrypto.subtle.importKey("raw", Buffer.from(KEY_HEX, "hex"), "AES-GCM", false, ["decrypt"]);
  return aesKey;
}
async function decrypt3(blob) {
  const bytes = Buffer.from(blob.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const plain = await import_node_crypto3.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) }, await importKey(), bytes.subarray(IV_BYTES));
  return Buffer.from(plain).toString("utf8");
}
var vidrockSite = {
  id: "vidrock",
  name: "Vidrock",
  referrer: SITE2,
  headers: { Origin: SITE2.slice(0, -1) },
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const response = await ctx.fetch(`${SITE2}api/${path}`, { headers: { Referer: SITE2 }, signal: AbortSignal.timeout(API_TIMEOUT_MS3) });
    if (!response.ok) return;
    const servers = await response.json();
    for (const name of SERVERS) {
      const entry = servers[name];
      if (!entry?.url || entry.type !== "hls") continue;
      let mediaUrl;
      try {
        mediaUrl = entry.url.startsWith("http") ? entry.url : await decrypt3(entry.url);
      } catch {
        continue;
      }
      yield { mediaUrl, label: name };
    }
  }
};
var vidrock_default = createScraper(vidrockSite);

// src/sites/vixsrc.mts
var SITE3 = "https://vixsrc.to/";
var API_TIMEOUT_MS4 = 2e4;
var vixsrcSite = {
  id: "vixsrc",
  name: "VixSrc",
  referrer: SITE3,
  maxQuality: "720p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const signal = AbortSignal.timeout(API_TIMEOUT_MS4);
    const api = await ctx.fetch(`${SITE3}api/${path}`, { headers: { Referer: SITE3 }, signal });
    if (!api.ok) return;
    const { src } = await api.json();
    if (!src) return;
    const page = await ctx.fetch(new URL(src, SITE3).toString(), { headers: { Referer: `${SITE3}${path}` }, signal });
    if (!page.ok) return;
    const html = await page.text();
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
var vixsrc_default = createScraper(vixsrcSite);

// src/sites/atlantic.mts
var import_node_crypto4 = require("node:crypto");
var SITE4 = "https://atlantic.st/";
var API4 = "https://stream.hls.lol/helios";
var KEY_HEX2 = "e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5";
var PREFIX = "ns_";
var API_TIMEOUT_MS5 = 2e4;
var IV_BYTES2 = 12;
var aesKey2;
async function decrypt4(value) {
  if (!value.startsWith(PREFIX)) return value;
  aesKey2 ??= import_node_crypto4.webcrypto.subtle.importKey("raw", Buffer.from(KEY_HEX2, "hex"), "AES-GCM", false, ["decrypt"]);
  const bytes = Buffer.from(value.slice(PREFIX.length), "hex");
  const plain = await import_node_crypto4.webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES2) }, await aesKey2, bytes.subarray(IV_BYTES2));
  return Buffer.from(plain).toString("utf8");
}
var atlanticSite = {
  id: "atlantic",
  name: "Atlantic",
  referrer: SITE4,
  headers: { Origin: SITE4.slice(0, -1) },
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const query = match.mediaType === "movie" ? `tmdbId=${match.tmdbId}&type=movie` : `tmdbId=${match.tmdbId}&type=tv&seasonId=${season ?? 1}&episodeId=${episode ?? 1}`;
    const response = await ctx.fetch(`${API4}?${query}`, { headers: { Referer: SITE4, Origin: SITE4.slice(0, -1) }, signal: AbortSignal.timeout(API_TIMEOUT_MS5) });
    if (!response.ok) return;
    const body = await response.json();
    for (const [name, entry] of Object.entries(body.sources ?? {})) {
      if (!entry?.url || entry.type && entry.type !== "hls") continue;
      try {
        yield { mediaUrl: await decrypt4(entry.url), label: name };
      } catch {
        continue;
      }
    }
  }
};
var atlantic_default = createScraper(atlanticSite);

// src/sites/vidlove.mts
var PLAYER3 = "https://player.vidlove.cc/";
var API5 = "https://api.vidlove.cc/";
var API_TIMEOUT_MS6 = 2e4;
var vidloveSite = {
  id: "vidlove",
  name: "Vidlove",
  referrer: PLAYER3,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie?id=${match.tmdbId}` : `tv?id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;
    const response = await ctx.fetch(`${API5}${path}&mode=json&sources=vidapi`, {
      headers: { Referer: PLAYER3, Origin: PLAYER3.slice(0, -1) },
      signal: AbortSignal.timeout(API_TIMEOUT_MS6)
    });
    if (!response.ok) return;
    const text = (await response.text()).replace(/[\u0000-\u001f]/g, " ");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    if (body.source?.url) yield { mediaUrl: body.source.url, label: "VidAPI" };
  }
};
var vidlove_default = createScraper(vidloveSite);

// src/sites/vidnest.mts
var API6 = "https://new.vidnest.fun/";
var PLAYER4 = "https://vidnest.fun/";
var MEDIA_REFERRER = "https://nextgencloudfabric.com/";
var ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
var API_TIMEOUT_MS7 = 2e4;
var LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));
var PAD = 64;
function decode(data) {
  const bytes = [];
  for (let at = 0; at < data.length; at += 4) {
    const chunk = data.slice(at, at + 4).padEnd(4, "=");
    const [a = PAD, b = PAD, c = PAD, d = PAD] = [...chunk].map((char) => LOOKUP.get(char) ?? PAD);
    bytes.push((a << 2 | b >> 4) & 255);
    if (c !== PAD) bytes.push(((b & 15) << 4 | c >> 2) & 255);
    if (d !== PAD) bytes.push(((c & 3) << 6 | d) & 255);
  }
  return Buffer.from(bytes).toString("utf8");
}
var vidnestSite = {
  id: "vidnest",
  name: "Vidnest",
  referrer: MEDIA_REFERRER,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const response = await ctx.fetch(`${API6}nextgencloudfabric/${path}`, {
      headers: { Referer: PLAYER4, Origin: PLAYER4.slice(0, -1) },
      signal: AbortSignal.timeout(API_TIMEOUT_MS7)
    });
    if (!response.ok) return;
    let body;
    try {
      body = await response.json();
      if (body.encrypted && body.data) body = JSON.parse(decode(body.data));
    } catch {
      return;
    }
    const urls = [...new Set([body.url, ...body.all_urls ?? []].filter((url) => !!url))];
    for (const [index, mediaUrl] of urls.entries()) yield { mediaUrl, label: `Cloud ${index + 1}` };
  }
};
var vidnest_default = createScraper(vidnestSite);

// src/sites/rivestream.mts
var API7 = "https://scrapper.rivestream.app/api/provider";
var API_TIMEOUT_MS8 = 2e4;
var PROVIDERS3 = ["vanguard", "apex", "pulse"];
function unwrap(url) {
  try {
    const params = new URL(url).searchParams;
    const mediaUrl = params.get("url");
    if (!mediaUrl) return { mediaUrl: url };
    const sent = JSON.parse(params.get("headers") || "{}");
    const referrer = sent.Referer ?? sent.referer;
    const origin = sent.Origin ?? sent.origin;
    return { mediaUrl, ...referrer ? { referrer } : {}, ...origin ? { headers: { Origin: origin } } : {} };
  } catch {
    return null;
  }
}
var rivestreamSite = {
  id: "rivestream",
  name: "Rivestream",
  referrer: "https://cinejoy.pk/",
  headers: { Origin: "https://cinejoy.pk" },
  maxQuality: "4K",
  async *httpCaptures({ match, season, episode }, ctx) {
    const query = match.mediaType === "movie" ? `id=${match.tmdbId}` : `id=${match.tmdbId}&season=${season ?? 1}&episode=${episode ?? 1}`;
    const answers = PROVIDERS3.map(
      (provider) => ctx.fetch(`${API7}?provider=${provider}&${query}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS8) }).then((r) => r.ok ? r.json() : null).catch(() => null)
    );
    for (const [i, answer] of answers.entries()) {
      for (const source of (await answer)?.data?.sources ?? []) {
        if (!source.url || source.format && source.format !== "hls") continue;
        const link = unwrap(source.url);
        if (!link) continue;
        const label = PROVIDERS3[i].replace(/^./, (c) => c.toUpperCase());
        yield { ...link, headers: link.headers ?? (link.referrer ? {} : void 0), label };
      }
    }
  }
};
var rivestream_default = createScraper(rivestreamSite);

// src/sites/lookmovie.mts
var SITE5 = "https://www.lookmovie2.to/";
var API_TIMEOUT_MS9 = 2e4;
var normalise = (text) => text.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
var QUALITY_ORDER = ["1080p", "1080", "720p", "720", "480p", "480", "360p", "360"];
async function getText(ctx, url) {
  const response = await ctx.fetch(url, { headers: { Referer: SITE5 }, signal: AbortSignal.timeout(API_TIMEOUT_MS9) });
  return response.ok ? response.text() : null;
}
var lookmovieSite = {
  id: "lookmovie",
  name: "LookMovie",
  referrer: SITE5,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const kind = match.mediaType === "movie" ? "movies" : "shows";
    const search = await getText(ctx, `${SITE5}api/v1/${kind}/do-search/?q=${encodeURIComponent(match.title)}`);
    if (!search) return;
    let results2;
    try {
      results2 = JSON.parse(search).result ?? [];
    } catch {
      return;
    }
    const wanted = normalise(match.title);
    const hit = results2.find((entry) => normalise(entry.title) === wanted && (!match.year || entry.year === match.year)) ?? results2.find((entry) => normalise(entry.title) === wanted);
    if (!hit) return;
    const page = await getText(ctx, `${SITE5}${kind}/play/${hit.slug}`);
    if (!page) return;
    const hash = /hash:\s*["']([^"']+)["']/.exec(page)?.[1];
    const expires = /expires:\s*(\d+)/.exec(page)?.[1];
    if (!hash || !expires) return;
    let access;
    if (match.mediaType === "movie") {
      const id = /id_movie:\s*(\d+)/.exec(page)?.[1];
      if (!id) return;
      access = `movie-access?id_movie=${id}`;
    } else {
      const raw = /window\.seasons='(.*)';\s*\n/.exec(page)?.[1];
      if (!raw) return;
      let episodeId;
      try {
        const seasons = JSON.parse(raw.replace(/\\(['"\\])/g, "$1"));
        episodeId = seasons[String(season ?? 1)]?.episodes?.[String(episode ?? 1)]?.id_episode;
      } catch {
        return;
      }
      if (!episodeId) return;
      access = `episode-access?id_episode=${episodeId}`;
    }
    const body = await getText(ctx, `${SITE5}api/v1/security/${access}&hash=${hash}&expires=${expires}`);
    if (!body) return;
    let streams;
    try {
      streams = JSON.parse(body).streams ?? {};
    } catch {
      return;
    }
    for (const quality of QUALITY_ORDER) {
      const mediaUrl = streams[quality];
      if (mediaUrl) yield { mediaUrl, label: quality.endsWith("p") ? quality : `${quality}p` };
    }
  }
};
var lookmovie_default = createScraper(lookmovieSite);

// src/sites/aetherlul.mts
var API8 = "https://lul.aether.cx/";
var API_TIMEOUT_MS10 = 2e4;
var FRONT_END = "https://aether.ist/";
var aetherlulSite = {
  id: "aetherlul",
  name: "Aether",
  referrer: API8,
  maxQuality: "1080p",
  async *httpCaptures({ match, season, episode }, ctx) {
    const path = match.mediaType === "movie" ? `movie/${match.tmdbId}` : `tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    const response = await ctx.fetch(`${API8}${path}`, { headers: { Referer: FRONT_END }, signal: AbortSignal.timeout(API_TIMEOUT_MS10) });
    if (!response.ok) return;
    const body = await response.json();
    if (body.stream) yield { mediaUrl: body.stream, label: "Aether" };
  }
};
var aetherlul_default = createScraper(aetherlulSite);

// src/cinesrc.mts
var import_node_crypto5 = require("node:crypto");
var subtle = import_node_crypto5.webcrypto.subtle;
var CINESRC_ORIGIN = "https://cinesrc.st";
var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var PROTOCOL = "csp3-20260613-b";
var TIMEOUT_MS6 = 15e3;
var FIELD = [
  "f78e3f38-5436-4d74-98e1-3ff89c437531",
  "14f36d78-cd51-4c30-a14f-c9837603f11a",
  "d320ff1b-828b-40d8-8078-51223f760da2",
  "c95a9d35-0eab-4763-ae6d-84e88bf9b95a",
  "a4df7df1-ad2c-475d-bf9a-32aef923db26",
  "5ebfd557-0100-4a61-ab6d-ad01367b29ae",
  "9729037b-4b95-48a5-aad2-9dd5a6c0fbf0",
  "187cd216-ab92-41f1-9f5a-81e311b07f4e",
  "36252f09-c35f-4397-aa77-6a9732995c78",
  "49ac9c1d-32cd-4e3f-8036-cc822845d864",
  "734a3ec4-0aa2-4e4c-9c98-f41f6677669b",
  "53cb60c4-b283-412d-899b-5bc36242df50",
  "9f23a7cc-e448-45c6-b38a-089bc7afb150",
  "f19257de-6e6c-4159-9837-65bc66117d6b",
  "65a17c01-9e53-4e40-b1e7-3fe9171229b3",
  "89fd8156-2e9e-4bc4-9f58-e2b31f781f12",
  "362c5fe0-82df-4a68-84cc-9f830748444e"
];
var S1_FP = {
  tz: "Europe/Berlin",
  lang: "en-US",
  langs: "en-US",
  pf: "MacIntel",
  cm: true,
  dpr: 1,
  sw: 1280,
  sh: 720,
  cd: 24,
  cvs: "21a9107876214fe3eb34060b571202e12902e03b3ec8ca796076175f73166c14",
  wgl: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)|Google Inc. (Google)",
  jit: "0.7999999523162842,0.8999999761581421,0.8999999761581421,0.8999999761581421,0.8999999761581421"
};
var C2_FP = {
  c: "6459ff4d5300250cd77b3f29d7dd0f9978345a8baefab32bb62aa61cb18c3bf3",
  g: "d6e2257b4df542735f146b8f5177f7e5ffc544f7ffc256f2c2645bc23dad9692",
  tz: "Europe/Berlin",
  l: "en-US",
  ls: "en-US",
  pf: "MacIntel",
  sw: 1280,
  sh: 720,
  cd: 24,
  ce: true,
  dpr: 1
};
var b64 = (b) => Buffer.from(b).toString("base64");
var b64u = (b) => Buffer.from(b).toString("base64url");
var reverse = (s) => s.split("").reverse().join("");
var rotl2 = (x, n) => (x << n | x >>> 32 - n) >>> 0;
function donutHash(input) {
  const bytes = new TextEncoder().encode(input);
  let a = (3266489909 ^ bytes.length) >>> 0, b = 50595078, c = 67372036, d = 2654435769, e = 2246822507;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    b = rotl2((b ^ ch + i + a >>> 0) >>> 0, 5) + c >>> 0;
    const c1 = rotl2(c + (b >>> 16 ^ ch) + 668265261 >>> 0, 7);
    const y = rotl2((c1 ^ ch << (i & 3) * 8 >>> 0) >>> 0, 11) + e >>> 0;
    const e1 = rotl2(e + y + ((b ^ ch) >>> 0) >>> 0, 13);
    c = (c1 ^ d) >>> 0;
    d = y;
    e = (e1 ^ a) >>> 0;
    a = rotl2((e1 ^ ch + Math.imul(i + 1, 73244475) >>> 0) >>> 0, 17);
  }
  for (let r = 0; r < 12; r++) {
    b = (rotl2(b + a + Math.imul(r + 1, 2654435761) >>> 0, 3) ^ c) >>> 0;
    c = rotl2((c ^ d ^ Math.imul(r + 3, 2246822519)) >>> 0, 9) + e >>> 0;
    d = (rotl2(d + b + Math.imul(r + 5, 3266489917) >>> 0, 15) ^ a) >>> 0;
    e = rotl2((e ^ c ^ Math.imul(r + 7, 668265263)) >>> 0, 21) + b >>> 0;
    a = (rotl2(a + d + e + r >>> 0, 27) ^ b) >>> 0;
  }
  return [b, c, d, e, a].map((v) => v.toString(16).padStart(8, "0")).join("");
}
var powModule;
async function solveIssuePow(fetch, work) {
  powModule ??= fetch(`${CINESRC_ORIGIN}/pow-v3.wasm`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS6) }).then((r) => {
    if (!r.ok) throw new Error(`pow-v3.wasm ${r.status}`);
    return r.arrayBuffer();
  }).then(async (bytes) => {
    const module3 = await WebAssembly.compile(bytes);
    if (WebAssembly.Module.imports(module3).length) throw new Error("pow-v3.wasm now has imports");
    return module3;
  });
  const module2 = await powModule.catch((err) => {
    powModule = void 0;
    throw err;
  });
  const exports2 = (await WebAssembly.instantiate(module2, {})).exports;
  const input = Buffer.from(work, "base64url");
  const ptr = exports2.a(input.length);
  new Uint8Array(exports2.memory.buffer).set(input, ptr);
  const out = exports2.b(ptr, input.length);
  const mem = new Uint8Array(exports2.memory.buffer);
  let end = out;
  while (mem[end]) end++;
  return Buffer.from(mem.subarray(out, end)).toString("latin1");
}
function solveFingerprintPow(salt, target) {
  for (let n = 0; n < 1 << 24; n++) {
    const x = n.toString(16).padStart(5, "0");
    if ((0, import_node_crypto5.createHash)("sha256").update(salt + x).digest("hex") === target) return x;
  }
  throw new Error("fingerprint pow unsolved");
}
async function seal(spki, plaintext, context) {
  const raw = new Uint8Array((0, import_node_crypto5.randomBytes)(32));
  const aesKey3 = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const rsaKey = await subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const iv = new Uint8Array((0, import_node_crypto5.randomBytes)(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, ...context ? { additionalData: context } : {} }, aesKey3, plaintext(raw)));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP", ...context ? { label: context } : {} }, rsaKey, raw));
  return { wrapped, iv, ct };
}
async function buildC2(pack, now) {
  const ss2 = reverse(String(pack[4]));
  const inner = Buffer.from(ss2.split(".")[1] ?? "", "base64").toString();
  const token = JSON.parse(Buffer.from(inner.split(".")[1] ?? "", "base64url").toString());
  const x = solveFingerprintPow(token.salt, token.target);
  const body = {
    v: 1,
    t: now,
    ua: UA,
    p: { s: token.salt, x },
    fp: C2_FP,
    xg: {
      r: ss2,
      t: now,
      s: donutHash(`${inner}${token.salt}${x}${token.target}${now}`),
      m: donutHash(`${ss2}${token.salt}stage2`).slice(0, 24)
    }
  };
  const spki = Buffer.from(reverse(String(pack[2])), "base64");
  const sealed = await seal(spki, () => new TextEncoder().encode(JSON.stringify(body)));
  return `c2~${b64u(sealed.wrapped)}~${b64u(sealed.iv)}~${b64u(sealed.ct)}`;
}
var decoy = () => ["_z" + Math.floor(Math.random() * 1296).toString(36).padStart(2, "0"), b64((0, import_node_crypto5.randomBytes)(4))];
async function buildS1(opts) {
  const { issue, proof, now, path, clientPub, pem } = opts;
  const fields = [
    FIELD[0],
    PROTOCOL,
    FIELD[1],
    "s1",
    FIELD[2],
    issue.w,
    ...decoy(),
    FIELD[3],
    proof,
    FIELD[4],
    issue.t,
    FIELD[5],
    issue.n,
    ...decoy(),
    FIELD[6],
    issue.s,
    FIELD[7],
    now,
    FIELD[8],
    (0, import_node_crypto5.randomBytes)(8).toString("hex"),
    ...decoy(),
    FIELD[9],
    UA,
    FIELD[10],
    path,
    FIELD[11],
    S1_FP,
    ...decoy(),
    FIELD[12],
    b64((0, import_node_crypto5.randomBytes)(16)),
    FIELD[13],
    (0, import_node_crypto5.randomBytes)(32).toString("hex"),
    FIELD[14],
    b64(clientPub),
    ...decoy(),
    FIELD[15],
    1,
    FIELD[16],
    b64((0, import_node_crypto5.randomBytes)(18))
  ];
  const context = new TextEncoder().encode(`cinesrc-challenge|${PROTOCOL}|s1`);
  const spki = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  const json = new TextEncoder().encode(JSON.stringify(fields));
  const sealed = await seal(spki, (key) => json.map((byte, i) => byte ^ key[i % 32]), context);
  return `s1~${b64(sealed.wrapped)}~${b64(sealed.iv)}~${b64(sealed.ct)}`;
}
var FALLBACK_ACTIONS = {
  getStream: "7eaf09c6d168184a0b875694dce39c349662222742",
  getProviderList: "00db14302a7e49e28e8eecf1a657ce239ab8b44c47"
};
var actions = FALLBACK_ACTIONS;
var actionsRefreshedAt = 0;
async function refreshActions(fetch, path) {
  if (Date.now() - actionsRefreshedAt < 6e4) return false;
  actionsRefreshedAt = Date.now();
  const html = await (await fetch(CINESRC_ORIGIN + path, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS6) })).text();
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) ?? [])];
  const found = {};
  await Promise.all(chunks.map(async (chunk) => {
    const js = await (await fetch(CINESRC_ORIGIN + chunk, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS6) })).text().catch(() => "");
    for (const m of js.matchAll(/createServerReference\)\("([0-9a-f]{40,})",[^)]*?"(getStream|getProviderList)"\)/g)) found[m[2]] = m[1];
  }));
  if (!found.getStream) return false;
  actions = { ...actions, ...found };
  return true;
}
async function callAction(fetch, path, id, args) {
  const res = await fetch(CINESRC_ORIGIN + path, {
    method: "POST",
    headers: { "user-agent": UA, referer: `${CINESRC_ORIGIN}/`, origin: CINESRC_ORIGIN, accept: "text/x-component", "content-type": "text/plain;charset=UTF-8", "next-action": id },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TIMEOUT_MS6)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`action ${res.status}`);
  return text;
}
function pagePath(target) {
  return `/embed/${target.mediaType}/${target.tmdbId}`;
}
async function listProviders(fetch, target) {
  const path = pagePath(target);
  let rsc = await callAction(fetch, path, actions.getProviderList, []).catch(() => "");
  if (!rsc.includes('"rank"') && await refreshActions(fetch, path).catch(() => false)) rsc = await callAction(fetch, path, actions.getProviderList, []).catch(() => "");
  const line = rsc.split("\n").find((l) => l.startsWith("1:["));
  if (!line) return [];
  return JSON.parse(line.slice(2)).sort((x, y) => y.rank - x.rank);
}
async function getStream(fetch, target, provider) {
  const path = pagePath(target);
  const cookies = /* @__PURE__ */ new Map();
  const api = async (p, init = {}) => {
    const res = await fetch(CINESRC_ORIGIN + p, {
      ...init,
      headers: { "user-agent": UA, referer: `${CINESRC_ORIGIN}/`, origin: CINESRC_ORIGIN, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS6)
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) cookies.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    if (!res.ok) throw new Error(`${p} ${res.status}`);
    return await res.json();
  };
  const query = JSON.stringify([target.mediaType, String(target.tmdbId), target.season != null ? String(target.season) : null, target.episode != null ? String(target.episode) : null]);
  const xq = b64u(new TextEncoder().encode(query));
  const boot = await api("/api/c/bootstrap", { method: "POST", headers: { "x-cs-q": xq } });
  cookies.set("cs_ac", boot.r);
  const pbCookie = "cs_pb_" + (0, import_node_crypto5.createHash)("sha256").update(query).digest("hex").slice(0, 16);
  cookies.set(pbCookie, boot.p);
  const issue = await api("/api/c/issue", { headers: { "x-cs-q": xq, "x-cs-p": boot.p, "x-cs-r": boot.r } });
  cookies.delete(pbCookie);
  const [{ pack }, { pk }, proof] = await Promise.all([
    api("/api/c/stage2/issue", { headers: { "x-cs-q": xq, "x-cs-r": boot.r } }),
    api("/api/c/pk"),
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
  if (!rsc.includes(":") && await refreshActions(fetch, path).catch(() => false)) return getStream(fetch, target, provider);
  const answer = rsc.match(/r3\.[^"\n\\]+/)?.[0];
  if (!answer) return null;
  const [, serverPub = "", salt = "", iv = "", header = "", ct = ""] = answer.split(".");
  const serverKey = await subtle.importKey("raw", Buffer.from(serverPub, "base64url"), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, ecdh.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const context = `cinesrc-response|${PROTOCOL}|r3|${serverPub}|${header}`;
  const aes = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: Buffer.from(salt, "base64url"), info: new TextEncoder().encode(`${context}|${b64u(clientPub)}|kdf`) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64url"), additionalData: new TextEncoder().encode(context) }, aes, Buffer.from(ct, "base64url"));
  return JSON.parse(new TextDecoder().decode(plain));
}

// src/sites/shuttletv.mts
var MAX_PROVIDERS = 4;
var shuttletvSite = {
  id: "shuttletv",
  name: "ShuttleTV",
  referrer: `${CINESRC_ORIGIN}/`,
  maxQuality: "4K",
  async *httpCaptures({ match, season, episode }, ctx) {
    const target = match.mediaType === "movie" ? { tmdbId: match.tmdbId, mediaType: "movie" } : { tmdbId: match.tmdbId, mediaType: "tv", season: season ?? 1, episode: episode ?? 1 };
    const listed = await listProviders(ctx.fetch, target).catch(() => []);
    const providers = listed.length ? listed.slice(0, MAX_PROVIDERS) : [{ id: "nebula", name: "Nebula", rank: 0 }];
    for (const provider of providers) {
      const stream = await getStream(ctx.fetch, target, provider.id).catch(() => null);
      for (const source of stream?.url ?? []) {
        if (!source.url || source.source && source.source !== "HLS") continue;
        yield { mediaUrl: new URL(source.url, CINESRC_ORIGIN).href, label: stream?.name ?? provider.name };
      }
    }
  }
};
var shuttletv_default = createScraper(shuttletvSite);

// src/index.mts
var scrapers = [cinejoy_default, flixer_default, bciney_default, movy_default, shuttletv_default, movies_default, cinezo_default, moviesapi_default, vidrock_default, vixsrc_default, atlantic_default, vidlove_default, vidnest_default, rivestream_default, lookmovie_default, aetherlul_default].map((scraper) => ({ ...scraper, version: "1.22.0" }));
var index_default = scrapers;
