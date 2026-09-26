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
var import_playwright_core = require("playwright-core");
var import_node_fs = require("node:fs");
var TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
var TMDB_BASE = "https://api.themoviedb.org/3";
var MASTER_PLAYLIST_RE = /\.m3u8(\?.*)?$/i;
var DIRECT_FILE_RE = /\.(mp4|mkv|webm)(\?.*)?$/i;
var SEGMENT_OR_INIT_RE = /(^|\/)(init|seg(ment)?[-_]?\d+|\d+)\.(mp4|m4s|webm)(\?.*)?$/i;
var FILE_CANDIDATE_GRACE_MS = 4e3;
var IGNORED_MEDIA_RE = /media-imdb\.com|youtube\.com|ytimg\.com|googlevideo\.com/i;
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
async function captureMediaUrl(page, timeoutMs, trigger, options = {}) {
  const playlistRe = options.isPlaylist ?? MASTER_PLAYLIST_RE;
  let resolveMedia;
  const donePromise = new Promise((resolve) => {
    resolveMedia = resolve;
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
    if (IGNORED_MEDIA_RE.test(url)) return;
    if (playlistRe.test(url)) {
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
    await trigger(() => settled);
    return await Promise.race([
      donePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
  } catch {
    return null;
  } finally {
    page.off("request", onRequest);
    if (graceTimer) clearTimeout(graceTimer);
  }
}
async function expandMasterPlaylist(fetchImpl, masterUrl, referrer) {
  if (DIRECT_FILE_RE.test(masterUrl)) {
    const response2 = await fetchImpl(masterUrl, { headers: { Referer: referrer, Range: "bytes=0-1023" } });
    if (!response2.ok) throw new Error(`direct file not fetchable: ${response2.status}`);
    return [{ resolution: null, bandwidth: null, url: masterUrl }];
  }
  const response = await fetchImpl(masterUrl, { headers: { Referer: referrer } });
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
var PAGE_LOAD_CAPTURE_TIMEOUT_MS = 2e4;
async function* autoplayCapture(page, url, ctx, options = {}) {
  const timeoutMs = Math.min(PAGE_LOAD_CAPTURE_TIMEOUT_MS, Math.max(8e3, ctx.budgetMs));
  const mediaUrl = await captureMediaUrl(
    page,
    timeoutMs,
    async (isDone) => {
      if (!options.clickPlay) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        return;
      }
      let armed = false;
      await page.route("**/*", (route) => {
        const request = route.request();
        return armed && request.isNavigationRequest() && request.frame() === page.mainFrame() ? route.abort() : route.continue();
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      armed = true;
      for (let attempt = 0; attempt < 4 && !isDone(); attempt++) {
        await page.locator('button:has-text("Play"), a:has-text("Play")').first().click({ timeout: 2500, force: true }).catch(() => {
        });
        await page.waitForTimeout(4e3);
      }
    },
    options
  );
  if (mediaUrl) yield { mediaUrl };
}
function variantHeight(variant) {
  return Number.parseInt(variant.resolution?.split("x")[1] ?? "0", 10) || 0;
}
function heightFromUrl(url) {
  return Number.parseInt(/[-_/.]s?(\d{3,4})p(?=[-_/.?]|$)/i.exec(url)?.[1] ?? "0", 10) || 0;
}
var BEST_POSSIBLE_HEIGHT = 2160;
var SOFT_DEADLINE_MS = 1e4;
async function resolveSite(site, query, ctx) {
  const match = await resolveTmdbMatch(query, ctx.fetch);
  if (!match) return null;
  const target = { match, season: query.season, episode: query.episode };
  const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
  if ("httpCaptures" in site) return pickBestCapture(site, site.httpCaptures(target, ctx), displayTitle, ctx);
  const executablePath = findChromiumExecutable();
  if (!executablePath) return null;
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
    context.on("page", (popup) => void popup.close().catch(() => {
    }));
    return await pickBestCapture(site, site.captures(page, target, ctx), displayTitle, ctx);
  } finally {
    await browser.close();
  }
}
async function pickBestCapture(site, captures, displayTitle, ctx) {
  let best = null;
  const startedAt = Date.now();
  try {
    while (true) {
      const pending = captures.next();
      pending.catch(() => {
      });
      let step;
      if (best) {
        const remainingMs = SOFT_DEADLINE_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) break;
        step = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), remainingMs))]);
      } else {
        step = await pending;
      }
      if (!step || step.done) break;
      const { mediaUrl, label } = step.value;
      let variants;
      try {
        variants = await expandMasterPlaylist(ctx.fetch, mediaUrl, site.referrer);
      } catch {
        continue;
      }
      const top = variants[0];
      if (!top) continue;
      const height = Math.max(...variants.map(variantHeight)) || heightFromUrl(mediaUrl);
      const score = height * 1e9 + Math.max(...variants.map((v) => v.bandwidth ?? 0));
      if (best && score <= best.score) continue;
      const resolutions = variants.map((v) => v.resolution).filter((r) => Boolean(r));
      const multi = variants.length > 1;
      const mirror = label ? `${site.name} mirror: ${label}` : site.name;
      best = {
        score,
        height,
        link: {
          url: multi ? mediaUrl : top.url,
          resolveKind: "hls",
          quality: resolutions.length ? `${resolutions.join("/")} \xB7 ${label ?? site.name}` : height ? `${height}p \xB7 ${label ?? site.name}` : mirror,
          title: displayTitle,
          referrer: site.referrer
        }
      };
      if (best.height >= BEST_POSSIBLE_HEIGHT) break;
    }
  } finally {
    void captures.return(void 0).catch(() => {
    });
  }
  return best?.link ?? null;
}
async function searchSite(site, query, ctx) {
  if (!("httpCaptures" in site) && !findChromiumExecutable()) {
    console.warn(`[${site.id}] no Chromium binary found (set CHROMIUM_PATH, or apk add chromium) -- skipping`);
    return [];
  }
  const match = await resolveTmdbMatch(query, ctx.fetch);
  if (!match) return [];
  if (site.available && !await site.available(ctx).catch(() => false)) return [];
  const displayTitle = match.year ? `${match.title} (${match.year})` : match.title;
  return [{ url: "", resolveId: site.id, resolveKind: "hls", title: `${displayTitle} \xB7 ${site.name}` }];
}
function createScraper(site) {
  return {
    id: site.id,
    name: `${site.name} \xB7 up to ${site.maxQuality}`,
    search: (query, ctx) => searchSite(site, query, ctx),
    resolve: (_resolveId, query, ctx) => resolveSite(site, query, ctx)
  };
}

// src/sites/7movies.mts
var sevenMoviesSite = {
  id: "7movies",
  name: "7Movies",
  referrer: "https://embed.vidrift.net/",
  maxQuality: "1080p",
  async *captures(page, { match, season, episode }, ctx) {
    const base = "https://embed.vidrift.net/embed2";
    const url = match.mediaType === "movie" ? `${base}/movie/${match.tmdbId}` : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    yield* autoplayCapture(page, url, ctx);
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
var bcineySite = {
  id: "bciney",
  name: "bCine",
  referrer: "https://player.bciney.to/",
  maxQuality: "1080p",
  async *captures(page, { match, season, episode }, ctx) {
    const base = "https://player.bciney.to/embed";
    const url = match.mediaType === "movie" ? `${base}/movie/${match.tmdbId}?autoplay=true` : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}?autoplay=true`;
    yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/v\.bciney\.to\/v\?url=/i });
  }
};
var bciney_default = createScraper(bcineySite);

// src/sites/cinejoy.mts
var BASE_URL = "https://cinejoy.pk";
var DEFAULT_PER_SERVER_TIMEOUT_MS = 2e4;
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
function selectServerAndCapture(page, serverName, timeoutMs) {
  return captureMediaUrl(page, timeoutMs, async () => {
    await page.getByRole("button", { name: "Servers", exact: true }).click();
    await page.getByText(serverName, { exact: true }).first().click({ timeout: 5e3 });
  });
}
var cinejoySite = {
  id: "cinejoy",
  name: "CineJoy",
  referrer: `${BASE_URL}/`,
  maxQuality: "4K",
  async available(ctx) {
    return (await listServers(ctx.fetch)).some((s) => s.status === "ok");
  },
  async *captures(page, { match, season, episode }, ctx) {
    const servers = (await listServers(ctx.fetch)).filter((s) => s.status === "ok").sort((a, b) => Number(b["4k"]) - Number(a["4k"]));
    if (!servers.length) return;
    const perServerTimeoutMs = Math.min(DEFAULT_PER_SERVER_TIMEOUT_MS, Math.max(5e3, ctx.budgetMs / servers.length));
    await page.goto(watchUrl(match.tmdbId, match.mediaType, season, episode), {
      waitUntil: "domcontentloaded",
      timeout: perServerTimeoutMs
    });
    for (const server of servers) {
      const mediaUrl = await selectServerAndCapture(page, server.name, perServerTimeoutMs);
      if (mediaUrl) yield { mediaUrl, label: server.name };
    }
  }
};
var cinejoy_default = createScraper(cinejoySite);

// src/sites/flixer.mts
var flixerSite = {
  id: "flixer",
  name: "Flixer",
  referrer: "https://flixer.gd/",
  maxQuality: "1080p",
  async *captures(page, { match, season, episode }, ctx) {
    const base = "https://flixer.gd/watch";
    const url = match.mediaType === "movie" ? `${base}/movie/${match.tmdbId}` : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    yield* autoplayCapture(page, url, ctx);
  }
};
var flixer_default = createScraper(flixerSite);

// src/sites/movy.mts
var movySite = {
  id: "movy",
  name: "Movy",
  referrer: "https://movy.sx/",
  maxQuality: "1080p",
  async *captures(page, { match, season, episode }, ctx) {
    const base = "https://movy.sx";
    const url = match.mediaType === "movie" ? `${base}/movie/${match.tmdbId}` : `${base}/tv/${match.tmdbId}/${season ?? 1}/${episode ?? 1}`;
    yield* autoplayCapture(page, url, ctx, { clickPlay: true });
  }
};
var movy_default = createScraper(movySite);

// src/sites/shuttletv.mts
var shuttletvSite = {
  id: "shuttletv",
  name: "ShuttleTV",
  referrer: "https://cinesrc.st/",
  maxQuality: "4K",
  async *captures(page, { match, season, episode }, ctx) {
    const base = "https://cinesrc.st/embed";
    const url = match.mediaType === "movie" ? `${base}/movie/${match.tmdbId}` : `${base}/tv/${match.tmdbId}?season=${season ?? 1}&episode=${episode ?? 1}`;
    yield* autoplayCapture(page, url, ctx, { isPlaylist: /^https:\/\/cinesrc\.st\/api\/playlist\//i });
  }
};
var shuttletv_default = createScraper(shuttletvSite);

// src/index.mts
var scrapers = [cinejoy_default, flixer_default, bciney_default, movy_default, shuttletv_default, movies_default, cinezo_default].map((scraper) => ({ ...scraper, version: "1.11.0" }));
var index_default = scrapers;
