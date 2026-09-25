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

// src/scraper.mts
var scraper_exports = {};
__export(scraper_exports, {
  default: () => scraper_default
});
module.exports = __toCommonJS(scraper_exports);
var import_playwright_core = require("playwright-core");
var import_node_fs = require("node:fs");
var BASE_URL = "https://cinejoy.pk";
var TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
var TMDB_BASE = "https://api.themoviedb.org/3";
var DEFAULT_PER_SERVER_TIMEOUT_MS = 2e4;
var MASTER_PLAYLIST_RE = /\.m3u8(\?.*)?$/i;
var DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
var SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
var FILE_CANDIDATE_GRACE_MS = 4e3;
async function tmdbSearch(fetchImpl, query) {
  const url = new URL(`${TMDB_BASE}/search/multi`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");
  const response = await fetchImpl(url.toString());
  if (!response.ok) throw new Error(`TMDB search failed: ${response.status}`);
  const data = await response.json();
  const results = [];
  for (const r of data.results) {
    if (r.media_type !== "movie" && r.media_type !== "tv") continue;
    const dateStr = r.media_type === "movie" ? r.release_date : r.first_air_date;
    const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
    const title = (r.media_type === "movie" ? r.title : r.name) || query;
    results.push({ tmdbId: r.id, mediaType: r.media_type, title, year: Number.isFinite(year) ? year : null });
  }
  return results;
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
    return { tmdbId: movie.id, mediaType: "movie", title: movie.title || imdbId, year: Number.isFinite(year) ? year : null };
  }
  const tv = data.tv_results[0];
  if (tv) {
    const year = tv.first_air_date ? Number.parseInt(tv.first_air_date.slice(0, 4), 10) : null;
    return { tmdbId: tv.id, mediaType: "tv", title: tv.name || imdbId, year: Number.isFinite(year) ? year : null };
  }
  return null;
}
async function listServers(fetchImpl) {
  const response = await fetchImpl("https://api.wing.st/servers");
  if (!response.ok) throw new Error(`Failed to list servers: ${response.status}`);
  const data = await response.json();
  return data.servers;
}
function watchUrl(tmdbId, mediaType, season, episode) {
  if (mediaType === "movie") return `${BASE_URL}/watch/movie/${tmdbId}`;
  return `${BASE_URL}/watch/tv/${tmdbId}/${season ?? 1}/${episode ?? 1}`;
}
async function selectServerAndCapture(page, serverName, timeoutMs) {
  let resolveMedia;
  const donePromise = new Promise((resolve2) => {
    resolveMedia = resolve2;
  });
  let fileCandidate = null;
  let graceTimer = null;
  let settled = false;
  const settle = (url) => {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    resolveMedia(url);
  };
  const onRequest = (request) => {
    const url = request.url();
    if (MASTER_PLAYLIST_RE.test(url)) {
      settle(url);
      return;
    }
    if (!fileCandidate && DIRECT_FILE_RE.test(url) && !SEGMENT_OR_INIT_RE.test(url)) {
      fileCandidate = url;
      graceTimer = setTimeout(() => settle(fileCandidate), FILE_CANDIDATE_GRACE_MS);
    }
  };
  page.on("request", onRequest);
  try {
    await page.getByRole("button", { name: "Servers", exact: true }).click();
    await page.getByText(serverName, { exact: true }).first().click({ timeout: 5e3 });
    return await Promise.race([
      donePromise,
      new Promise((resolve2) => setTimeout(() => resolve2(null), timeoutMs))
    ]);
  } catch {
    return null;
  } finally {
    page.off("request", onRequest);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
async function expandMasterPlaylist(fetchImpl, masterUrl) {
  if (!MASTER_PLAYLIST_RE.test(masterUrl)) {
    const response2 = await fetchImpl(masterUrl, { headers: { Referer: `${BASE_URL}/`, Range: "bytes=0-1023" } });
    if (!response2.ok) throw new Error(`direct file not fetchable: ${response2.status}`);
    return [{ resolution: null, bandwidth: null, url: masterUrl }];
  }
  const response = await fetchImpl(masterUrl, { headers: { Referer: `${BASE_URL}/` } });
  if (!response.ok) throw new Error(`master playlist not fetchable: ${response.status}`);
  const text = await response.text();
  if (!text.startsWith("#EXTM3U")) throw new Error("not a valid HLS playlist");
  if (!text.includes("#EXT-X-STREAM-INF")) return [{ resolution: null, bandwidth: null, url: masterUrl }];
  const lines = text.split(/\r?\n/);
  const variants = [];
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
      url: new URL(uriLine, masterUrl).toString()
    });
  }
  if (!variants.length) return [{ resolution: null, bandwidth: null, url: masterUrl }];
  variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  return variants;
}
function findChromiumExecutable() {
  const override = process.env.CHROMIUM_PATH;
  if (override && (0, import_node_fs.existsSync)(override)) return override;
  for (const candidate of ["/usr/bin/chromium-browser", "/usr/bin/chromium"]) {
    if ((0, import_node_fs.existsSync)(candidate)) return candidate;
  }
  return void 0;
}
async function resolveTmdbMatch(query, fetchImpl) {
  const wantType = query.type === "series" || query.type === "tv" ? "tv" : "movie";
  const imdbId = /^tt\d+/.exec(query.id)?.[0];
  if (imdbId) return tmdbFindByImdbId(fetchImpl, imdbId);
  const matches = await tmdbSearch(fetchImpl, query.title);
  return matches.find((m) => m.mediaType === wantType) ?? matches[0] ?? null;
}
async function search(query, ctx) {
  if (!findChromiumExecutable()) {
    console.warn("[cinejoy] no Chromium binary found (set CHROMIUM_PATH, or apk add chromium) -- skipping");
    return [];
  }
  const match = await resolveTmdbMatch(query, ctx.fetch);
  if (!match) return [];
  const servers = (await listServers(ctx.fetch)).filter((s) => s.status === "ok");
  const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
  return servers.map((server) => ({
    url: "",
    resolveId: server.name,
    resolveKind: "hls",
    quality: server["4k"] ? "4K" : void 0,
    /*
        stremio-tv's own streams page only ever renders `title` (as
        "release") -- `quality`/`labels` below feed a description field
        nothing in the UI displays (see stremio-tv's `streaminfo.ts`:
        `describe()` never reads `stream.description`). So the mirror
        name -- the one thing that tells four otherwise-identical rows
        apart -- has to live IN `title` itself, alongside the real
        movie title TMDB resolved (never `query.title`, which is only
        ever the raw content id). Real quality (resolution) is only
        known once resolve() actually captures the stream, too late for
        this list; "4k" is the one signal cinejoy's server list exposes
        this cheaply, so it's folded in here rather than left unseen.
    */
    title: server["4k"] ? `${displayTitle} \xB7 ${server.name} \xB7 4K` : `${displayTitle} \xB7 ${server.name}`
  }));
}
async function resolve(resolveId, query, ctx) {
  const executablePath = findChromiumExecutable();
  if (!executablePath) return null;
  const match = await resolveTmdbMatch(query, ctx.fetch);
  if (!match) return null;
  const timeoutMs = Math.min(DEFAULT_PER_SERVER_TIMEOUT_MS, Math.max(5e3, ctx.budgetMs));
  const browser = await import_playwright_core.chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    proxy: ctx.proxyUrl ? { server: ctx.proxyUrl } : void 0
  });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    await page.goto(watchUrl(match.tmdbId, match.mediaType, query.season, query.episode), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs
    });
    const mediaUrl = await selectServerAndCapture(page, resolveId, timeoutMs);
    if (!mediaUrl) return null;
    let variants;
    try {
      variants = await expandMasterPlaylist(ctx.fetch, mediaUrl);
    } catch {
      return null;
    }
    const best = variants[0];
    if (!best) return null;
    const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
    return {
      url: best.url,
      resolveKind: "hls",
      quality: best.resolution ? `${best.resolution} \xB7 ${resolveId}` : `CineJoy mirror: ${resolveId}`,
      title: displayTitle,
      referrer: `${BASE_URL}/`
    };
  } finally {
    await browser.close();
  }
}
var cinejoyScraper = {
  id: "cinejoy",
  name: "CineJoy",
  version: "1.2.2",
  search,
  resolve
};
var scraper_default = cinejoyScraper;
