# Scraper strategies

Worked-out recipes for sources that are ready (or nearly) to build, so a scraper can be written without redoing the research. Status lives in [SOURCES.md](SOURCES.md); this file is the *how*. Every recipe was checked by hand on 2026-09-27 with movie TMDB 27205 (Inception) and, where noted, TV 1399 (Game of Thrones) S1E1, decoding the result with ffmpeg:

```
ffmpeg -v error -rw_timeout 15000000 -user_agent "<browser UA>" \
  -headers "Referer: R\r\nOrigin: O\r\n" -f hls -allowed_extensions ALL -extension_picky 0 \
  -i "<url>" -t 8 -f null -
```

All of these are `HttpSite` scrapers (no Chromium): put the API call in `httpCaptures`, yield `{mediaUrl, label}`, let `pickBestCapture` do the rest. Cross-cutting lessons (read the first one before building anything):

- **Host limits decide what can ship** (`stremio-tv-plugin-web-links`, `src/plugin.mts`). The relay sends `Referer` on every playlist and segment fetch, plus any `WebLink.headers` (web-links >= 0.9.0: `Origin`, `Accept`, `Accept-Language`, `User-Agent`, `X-*` only). It relays `#EXT-X-MEDIA` audio/subtitle playlists as playlists since 0.8.3 (before that it treated them as segments, which left a master with separate audio silent). Test a new source **through the relay**, not just in ffmpeg: `relay-e2e`-style (a local HTTP server fronting the plugin's `variant`/`segment` routes, ffprobe/ffmpeg pulling from it) proves audio + video decode with only the headers the link declares. Measured: moviesapi, atlantic, vidlove, vidnest `nextgencloudfabric` and vixsrc play with Referer alone; **vidrock Orion/Luna need `Origin`** (403 without) -- shipped by setting `headers` on the site.
- Tokens are short-lived; always resolve at play time.
- A server that answers with a master is not necessarily playable: check a segment. Leaf-playlist duration (`leafDuration`) already catches stubs; segments on a forbidden CDN (see vidrock's Atlas) need a segment fetch, which `pickBestCapture` does not do today.

---

## vidrock.net  (status: implemented in 1.13.0 -- `src/sites/vidrock.mts`; needs web-links >= 0.9.0)

Pure HTTP; the server list is AES-GCM encrypted with a key shipped in the client bundle.

1. `GET https://vidrock.net/api/movie/{tmdb}` or `/api/tv/{tmdb}/{season}/{episode}` with `Referer: https://vidrock.net/`. Returns an object keyed by server name (`Nova`, `Atlas`, `Luna`, `Orion`, `Astra`); each is `{url, type:"hls", language, flag}` or `{url:null}`.
2. Decrypt each `url`: base64url -> bytes; first 12 bytes are the IV, the rest is ciphertext+tag; AES-GCM, key = hex `7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f`. Node: `crypto.subtle.importKey("raw", Buffer.from(KEY,"hex"), "AES-GCM", false, ["decrypt"])`, then `decrypt({name:"AES-GCM", iv}, key, rest)`. (The key is in `assets/index-*.js` as the constant next to `crypto.subtle.importKey`; if decryption starts failing, re-read it from there.)
3. Plaintext is the HLS master URL.
4. Send `Referer: https://vidrock.net/` **and** `Origin: https://vidrock.net`. **Both Orion and Luna answer 403 to Referer alone** (Orion with a Cloudflare page, Luna "Forbidden"), and the host relay never sends Origin, so the link declares `headers: { Origin: "https://vidrock.net" }` (`SiteBase.headers` in `shared.mts` -> `WebLink.headers`), which web-links 0.9.0's relay sends on every hop. Verified through the relay: 1080p/720/360 with audio decodes for a movie and a TV episode; without the header the same relay run fails (control). Shipped and run through the real scraper on 10 titles: 10 of 10 resolved (Orion or Luna, 2-4 s each). An older host (< 0.9.0) ignores the field and the links 403.

Servers seen:

| Server | Result |
|---|---|
| Orion (`shadowmoonwanderer.lol`, `moonfirekeeper.lol`) | master 1920x1080 / 1280x720 / 640x360; decodes. Movie and TV. |
| Luna (`lun.genesis-b23.workers.dev`) | master 640x266 / 1280x534 / 1920x800 (same encode as vidlove's vidapi); decodes. Needs Origin. |
| Atlas (`cdn1.ngcorp.dad`) | master and leaf playlists fetch fine, but every segment (`p16-ttam-va.ibyteimg.com/origin/ad-site-i18n/...`, a TikTok ad CDN) answers `403 {"code":1004,"error":"domain forbidden"}`, in a real browser too. **Dead; skip it.** This is the same CDN vidzee's `ipcloud` server returns, so vidzee adds nothing. |
| Nova, Astra | null |

Because Atlas returns a plausible master, a scraper must not take the first server: fetch the first segment of a candidate (or just prefer Orion, then Luna) before returning it.

---

## moviesapi.to / vidspark.to  (status: implemented in 1.12.0 -- `src/sites/moviesapi.mts`)

Pure HTTP with a static key. This is the backend behind **PressPlay** (pressplayz.to only iframes it; its `/api/player-servers` lists moviesapi.to, vidspark.to, cdn.vidspark.to and vidfast.pro) and vidnest's `vidxyz` server.

1. `GET https://moviesapi.to/api/vidora/v1/movie/{tmdb}` or `/api/vidora/v1/tv/{tmdb}/{season}/{episode}` with headers `x-player-key: 3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13` (a constant in `assets/index-*.js`; without it, 401), `Referer: https://moviesapi.to/`, `Origin: https://moviesapi.to`.
2. JSON: `{result, title, tmdb_id, imdb_id, year, sources:[{file_code, url, source:"vidora", tracks}]}`. `sources[0].url` is a master on `*.workers.dev` (`north-man.kurututujohn.workers.dev/hls2/..../master.m3u8?t=...&s=...&e=43200`) that redirects to `bx.netrocdn.site`; fetch it with `redirect: "follow"`.
3. Playlist and segments need the `Referer` `https://moviesapi.to/` (no headers -> 403; the master redirects, so follow redirects). `Origin` is not needed. The API call itself is made with Origin too, as the player does.

Checked: movie 27205 (1920x1080, 8888 s), 238 (1920x1080, 10629 s), 872585 (1920x872), TV 1399 S1E1 (1280x720 + 1920x1080, 3697 s). ffmpeg decodes. Segments are direct (no signed proxy) and were still valid 30 s after the playlist fetch; ~6 MB each, so genuine high bitrate 1080p. `source:"vidora"`; the `sources` array had a single entry each time. One rendition, H.264 + AAC muxed, no `EXT-X-KEY`. Shipped and run through the real scraper on 10 titles: 7 resolved (1s each), 3 upstream gaps (Casablanca and The Last of Us answer 502; Breaking Bad S1E2 answers 404 "No Vidora link").

---

## vixsrc.to  (status: implemented in 1.13.0 -- `src/sites/vixsrc.mts`; needs web-links >= 0.8.3)

Pure HTTP, no key.

1. `GET https://vixsrc.to/api/movie/{tmdb}` or `/api/tv/{tmdb}/{season}/{episode}` -> `{src:"/embed/{id}?token=...&t=...&expires=...&lang=en&canPlayFHD=1..."}`.
2. `GET https://vixsrc.to{src}` (Referer `https://vixsrc.to/movie/{tmdb}`). The HTML contains `window.masterPlaylist = { params: {token, expires, asn}, url: 'https://vixsrc.to/playlist/{id}?b=1' }` and `window.canPlayFHD`. Extract `url`, `token`, `expires` by regex.
3. Master URL = `{url}&token={token}&expires={expires}` (plus `&h=1` when `canPlayFHD` is true, and `&lang=en`). Fetch with `Referer: https://vixsrc.to/`. It is a real master with `#EXT-X-MEDIA` audio (English, Italian) and subtitle tracks; the variants' URLs carry their own per-rendition tokens.

**Host dependency:** the video renditions are video-only (ffprobe on a leaf: `h264` video, no audio stream). Audio is a separate `#EXT-X-MEDIA:TYPE=AUDIO` playlist (Italian default, English) and the leaves are `AES-128` with a relative key (`/storage/enc.key`). Before 0.8.3 the relay rewrote those `URI="..."` attributes as segments (raw audio playlist, unproxied absolute segment URLs); flattening to one video leaf would give silent video, so the scraper always returns the whole master. The host has routed `#EXT-X-MEDIA` URIs through its variant route since web-links 0.8.3, so the master goes out whole and works (verified through the relay: h264 video plus two aac tracks, 10 s decoded clean, movie and TV). Referer alone is enough for everything else.

Checked: movie 27205, 238, 157336, 872585 (API answers), TV 1399 S1E1 (API answers); playlist decoded in ffmpeg for 27205. Renditions: 854x480 and 1280x720 only (`h=1` did not add 1080p). It is the StreamingCommunity catalogue (Italian-first), so coverage differs. Streaming Unity is a front-end for it.

---

## api.vidlove.cc  (status: implemented in 1.14.0 -- `src/sites/vidlove.mts`)

Pure HTTP, Cinezo-style API.

`GET https://api.vidlove.cc/{movie?id=TMDB | tv?id=TMDB&season=S&episode=E}&mode=json&sources=vidapi` with `Referer: https://player.vidlove.cc/`, `Origin: https://player.vidlove.cc`. Response JSON has `meta` (TMDB), `subtitles`, and `source: {source:"vidapi", label:"VidAPI", url, manifest}`. `url` is a master on `*.whysosigmabro.cfd/api?d=...` (`application/vnd.apple.mpegurl`); `manifest` is the same master inlined (640x266 / 1280x534 / 1920x800). The body contains raw control characters: parse with a lenient JSON parser (`JSON.parse` fails; strip control chars first). Other `sources=` values (`moviebox2`, `megaknight`, `warden`, `cinefreak`, `berlin`) returned `source: null` on all titles tried. Checked movie 27205/238/157336/872585 and TV 1399 S1E1; ffmpeg decodes.

---

## atlantic.st  (status: implemented in 1.14.0 -- `src/sites/atlantic.mts`; needs web-links >= 0.9.0)

Pure HTTP; AES-GCM with a key shipped in the client bundle (same scheme as vidrock, different key).

1. `GET https://stream.hls.lol/helios?tmdbId={id}&type=movie` or `...&type=tv&seasonId={s}&episodeId={e}` (no special headers needed). Returns `{sources:{Moscow:{label,server,type:"hls",url:"ns_<hex>"}, Novo:{...}, Omsk:{...}}}`.
2. Decrypt `url`: strip the `ns_` prefix, hex-decode; first 12 bytes = IV, rest = ciphertext+tag; AES-GCM, key = hex `e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5` (constant `xR` in `assets/index-*.js`; the function is `ER`). A `url` without `ns_` is plaintext.
3. Plaintext is `https://peraspera.nbsycfzrpa4.workers.dev/?payload=...&headers=...`; the `headers` param is an encrypted blob the proxy applies upstream, so leave the URL untouched. Fetch with `Referer: https://atlantic.st/` **and** `Origin: https://atlantic.st`; without them the proxy answers 302.

Checked movie 27205 (640x266/1280x534/1920x800, 8888 s) and TV 1399 S1E1 (640x360/1280x720, 3697 s), all three servers, segments fetched, ffmpeg decodes. Segments are MPEG-TS served as `text/html` (same as nextgencloudfabric below). The site also has a `cdn.hls.lol/content/{movie|tv}/...` route ("Aphrodite") that needs a header computed by a client helper; not needed since `helios` works.

---

## new.vidnest.fun  (status: implemented in 1.15.0 -- `src/sites/vidnest.mts`, `nextgencloudfabric` only) -- one backend, many upstreams

Pure HTTP, **no key**. `GET https://new.vidnest.fun/{upstream}/movie/{tmdb}` or `/{upstream}/tv/{tmdb}/{season}/{episode}` with `Referer: https://vidnest.fun/`, `Origin: https://vidnest.fun`. Responses are `{encrypted:true, data:"..."}` where `data` is base64 in a **custom alphabet** `RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=` (standard base64 decoding with that alphabet substituted, then UTF-8 -> JSON). The decode is 10 lines (see `decryptCipherResponse` in `_next/static/chunks/*47fb*.js`); an unencrypted response is plain JSON.

Upstreams (`{upstream}`) and what each returned for movie 27205 / TV 1399 S1E1:

| Upstream | Shape | Verdict |
|---|---|---|
| `nextgencloudfabric` | `{url, all_urls[], headers?, label}`; masters on `onlinevisibilitysystem.site` / `highperformancebrands.site` | **Works** (640x266/1280x534/1920x800 movie; 640x360/1280x720 TV). Referer `https://nextgencloudfabric.com/`. Segments are MPEG-TS served as `text/html`; ffmpeg decodes. Same encode and CDN as atlantic, vidlove, vidrock Luna. |
| `allmovies` | `{streams:[{headers:{Referer},language,type:"hls",url}]}` | **Works** (up to 1920x800 / 1920x1080 TV), but `language: "Hindi"` (dub) and hosts `hunts439kow.com`. ffmpeg decodes with warnings about connection reuse. Referer taken from the response's `headers.Referer`. |
| `vidxyz` | `{streams:[{type:"hls",url}]}` | Same as moviesapi.to (above); needs Referer `https://moviesapi.to/` (a vidnest Referer gets 403). Prefer calling moviesapi directly. |
| `videasy` | `{url, headers}` via `tiktoks.animanga.fun` proxy | Master and leaf fetch, but segments go through `streamvaultsrc.click/stream-proxy/seg?u=...` and answered `403 bad signature`. Skip; same CDN as nextgencloudfabric. |
| `yflix`, `rogflix` | `{url}` via `pwcloud.animanga.fun` / `akcloud.animanga.fun` | Masters valid, full length (8888 s), but segments are PNG images (`89504e47`); ffmpeg reports "Video: png" and cannot decode. Same trick as Flixer; unverified in a real hls.js player. Not recommended. |
| `vidzee` | `{streams:[{type:"mp4",url:".../inception.mkv"}]}` | A single MKV file (`s1.streamflixserver.site`); the request timed out. Skip. |
| `vidrock`, `vidlink`, `klikxxi` | 502 from vidnest | Broken here. Call vidrock directly (above). |
| `hollymoviehd` | `{streams:[{type:"hls"}]}` on `goodstream.cc` | 403 Cloudflare page. Skip. |

The vidnest player also wraps some upstreams in its own proxies (`vidproxy.*.workers.dev/proxy?url=...&headers=...`); ignore those and use the raw URLs plus the `headers` each response carries.

---

## vidzee  (status: rejected -- redundant)

`core.vidzee.wtf/streams/movie/{id}?s={server}&e=1` returns `{"c": "<encrypted>"}` (server `ipcloud` gave an HLS master on `cdn1.ngcorp.dad`, the same Atlas CDN whose segments are 403 "domain forbidden"). The plain call with `s=dcloud` returned 502. Its useful output is available more simply from vidrock (same sources) and vidnest's `vidzee` route (a single MKV that timed out). No further work justified.

---

## vidlink.pro  (status: possible -- hard, and MP4 not HLS)

`GET /api/b/movie/{id}?multiLang=0` where `{id}` is produced client-side by `window.getAdv(tmdbId)`, implemented in a Go WebAssembly module (`/fu.wasm`, run through the `Dm` wasm_exec shim) that also needs `window.sodium` (libsodium-wrappers). The request also carries a header (constant `i.Zt` in the page chunk) and the response is decoded by a function `n.D`. The streams it produced in a browser were signed **MP4 files** on `noon.mooncase.online/mp/...` (a proxy to the moviebox CDN `bcdn.hakunaymatata.com`), not HLS.

If ever needed: cheapest route is a `BrowserSite` that loads `https://vidlink.pro/movie/{id}` and captures the `media` requests (that is what the 28 s probe did), returning `resolveKind: "file"` links -- but `pickBestCapture` is HLS-only today, so it needs a file path first. Low priority: moviebox is also reachable elsewhere.

---

## Duplicate content pools (why not all of these are worth shipping)

Several sources are the same catalogue behind different fronts. Identical encode (640x266 / 1280x534 / 1920x800 for Inception, 8888 s) appears on atlantic (peraspera), vidnest `nextgencloudfabric`, vidlove `vidapi`, vidrock `Luna`, and vidnest `videasy`. Distinct pools worth having: **moviesapi.to** (`netrocdn`, real 1080p), **vidrock Orion** (1080/720/360), **vixsrc** (Italian catalogue), **allmovies** (Hindi dub). Suggested build order: moviesapi, vixsrc, vidrock, then one of the shared-pool fronts (vidlove is the simplest), then atlantic/vidnest if more coverage is wanted.

---

## github.com/p-stream (researched 2026-09-27)

**Source code: nothing.** Every source P-Stream uses lives in `p-stream/providers`, which is disabled on GitHub (DMCA); the front-end only imports it. Do not look for mirrors or forks of it, and do not pull its code out of a fork's bundle. `providers-api` (a Worker wrapping the package) needs a Cloudflare Turnstile token per call. The userscript/extension only inject headers.

**Black-box method that did work.** Open a fork (pstream.cfd) on `/media/tmdb-movie-27205-inception`, let it run its source search, then read `performance.getEntriesByType('resource')` in the page: the app sends every upstream request through its own relays (`eve.pstream.cfd/?destination=<url>`, `ava.pstream.cfd`), and many destinations are plain (URL-encoded) so the upstream APIs and their parameters are visible. Some destinations are hex-obfuscated; ignore those. This is ordinary observation of a public site, the same as watching any player. Then probe the upstream APIs directly from Node. (Its sources have random names in the UI: Lola, Elsie, ...)

Upstreams seen for Inception, and what came of each:

| Upstream | Result |
|---|---|
| `scrapper.rivestream.app/api/provider?provider=vanguard&id=TMDB[&season=&episode=]` | **Built** as `rivestream` (1.15.0). Plain JSON, no key, no headers needed for the API. `data.sources[0].url` is `proxy.valhallastream.com/m3u8-proxy?url=<real>&headers=<json>`; unwrap it: the real URL is a cinejoy-CDN master (`lit.cheaptruckrepairs.cc/playlist/...`, 3840x2160 HEVC / 1080 / 720 / 360) and the headers are `Referer: https://cinejoy.pk/`, `Origin: https://cinejoy.pk` (needs web-links >= 0.9.0). 8/10 titles (Casablanca, The Last of Us null), under 1 s. Same pool as cinejoy but no browser. `provider=pulse` and `apex` returned `{data:null}`. |
| `www.lookmovie2.to` | **Built** as `lookmovie` (1.15.0). (1) `GET /api/v1/{movies\|shows}/do-search/?q=TITLE` -> `result[]{slug,title,year}`. (2) `GET /{movies\|shows}/play/SLUG`: inline `hash: "..."`, `expires: N`, `id_movie: N` (movies) or `window.seasons='{...}'` (shows; a JS single-quoted string, unescape `\'`, `\"`, `\\`, then JSON; `seasons[S].episodes[E].id_episode`). (3) `GET /api/v1/security/movie-access?id_movie=&hash=&expires=` or `episode-access?id_episode=...` -> `streams` (`{"480p"\|"480":url\|null,...}`), single-rendition HLS. No Referer needed, no Cloudflare on the API. Mostly 480p only; some titles `/aes/` (AES-128, relayed fine). 9/10 titles (The Godfather not in the catalogue). Homepage mentions Turnstile but the API path never hit it. |
| `api.speedracelight.com/{hdmovie,cdn,lamovie,meine}/sources-with-title?title=&mediaType=&year=&tmdbId=&imdbId=&enc=2&seed=` (seed from `/seed?mediaId=TMDB`, 30 s TTL) | Not built. `hdmovie`/`cdn` return an encrypted blob whose scheme is not visible from outside (it lives in the blocked library); `lamovie`/`meine` 500. Left as `possible`. |
| `proxy.valhallastream.com/m3u8-proxy` | Rivestream's proxy; unwrapped, not used. |

Repeated on the Aether fork (aether.ist) with a TV episode (Game of Thrones S1E1): it surfaced `lul.aether.cx` above, plus its own TMDB/OpenSubtitles/analytics calls (not streams) and `nebula.aether.cx` (always 502).

The forks also call `sub.wyzie.io`, `sub.vdrk.site` (subtitles), `api.theintrodb.org`, `api.skipdb.tv`, `v3-cinemeta.strem.io`: metadata, not streams. Repeat the method on another fork or another title to find more upstreams (the source list changes per media type, so try a TV episode too).
