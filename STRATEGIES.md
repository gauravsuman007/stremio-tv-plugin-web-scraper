# Scraper strategies

Worked-out recipes for sources that are ready (or nearly) to build, so a scraper can be written without redoing the research. Status lives in [SOURCES.md](SOURCES.md); this file is the *how*. Every recipe was checked by hand on 2026-09-27 with movie TMDB 27205 (Inception) and, where noted, TV 1399 (Game of Thrones) S1E1, decoding the result with ffmpeg:

```
ffmpeg -v error -rw_timeout 15000000 -user_agent "<browser UA>" \
  -headers "Referer: R\r\nOrigin: O\r\n" -f hls -allowed_extensions ALL -extension_picky 0 \
  -i "<url>" -t 8 -f null -
```

All of these are `HttpSite` scrapers (no Chromium): put the API call in `httpCaptures`, yield `{mediaUrl, label}`, let `pickBestCapture` do the rest. Cross-cutting lessons:

- **Send `Origin` as well as `Referer`.** Several CDNs (Cloudflare Workers fronts) return 403 to Referer alone and 200 once `Origin` matches; a browser always sends both. Set `WebLink.referrer` to the site root and have the consuming app send Origin too (AGENTS.md currently says Referer only -- update it when the first of these ships).
- Tokens are short-lived; always resolve at play time.
- A server that answers with a master is not necessarily playable: check a segment. Leaf-playlist duration (`leafDuration`) already catches stubs; segments on a forbidden CDN (see vidrock's Atlas) need a segment fetch, which `pickBestCapture` does not do today.

---

## vidrock.net  (status: candidate)

Pure HTTP; the server list is AES-GCM encrypted with a key shipped in the client bundle.

1. `GET https://vidrock.net/api/movie/{tmdb}` or `/api/tv/{tmdb}/{season}/{episode}` with `Referer: https://vidrock.net/`. Returns an object keyed by server name (`Nova`, `Atlas`, `Luna`, `Orion`, `Astra`); each is `{url, type:"hls", language, flag}` or `{url:null}`.
2. Decrypt each `url`: base64url -> bytes; first 12 bytes are the IV, the rest is ciphertext+tag; AES-GCM, key = hex `7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f`. Node: `crypto.subtle.importKey("raw", Buffer.from(KEY,"hex"), "AES-GCM", false, ["decrypt"])`, then `decrypt({name:"AES-GCM", iv}, key, rest)`. (The key is in `assets/index-*.js` as the constant next to `crypto.subtle.importKey`; if decryption starts failing, re-read it from there.)
3. Plaintext is the HLS master URL.
4. Send `Referer: https://vidrock.net/` **and** `Origin: https://vidrock.net`.

Servers seen:

| Server | Result |
|---|---|
| Orion (`shadowmoonwanderer.lol`, `moonfirekeeper.lol`) | master 1920x1080 / 1280x720 / 640x360; decodes. Movie and TV. |
| Luna (`lun.genesis-b23.workers.dev`) | master 640x266 / 1280x534 / 1920x800 (same encode as vidlove's vidapi); decodes. Needs Origin. |
| Atlas (`cdn1.ngcorp.dad`) | master and leaf playlists fetch fine, but every segment (`p16-ttam-va.ibyteimg.com/origin/ad-site-i18n/...`, a TikTok ad CDN) answers `403 {"code":1004,"error":"domain forbidden"}`, in a real browser too. **Dead; skip it.** This is the same CDN vidzee's `ipcloud` server returns, so vidzee adds nothing. |
| Nova, Astra | null |

Because Atlas returns a plausible master, a scraper must not take the first server: fetch the first segment of a candidate (or just prefer Orion, then Luna) before returning it.

---

## moviesapi.to / vidspark.to  (status: candidate -- best quality found)

Pure HTTP with a static key. This is the backend behind **PressPlay** (pressplayz.to only iframes it; its `/api/player-servers` lists moviesapi.to, vidspark.to, cdn.vidspark.to and vidfast.pro) and vidnest's `vidxyz` server.

1. `GET https://moviesapi.to/api/vidora/v1/movie/{tmdb}` or `/api/vidora/v1/tv/{tmdb}/{season}/{episode}` with headers `x-player-key: 3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13` (a constant in `assets/index-*.js`; without it, 401), `Referer: https://moviesapi.to/`, `Origin: https://moviesapi.to`.
2. JSON: `{result, title, tmdb_id, imdb_id, year, sources:[{file_code, url, source:"vidora", tracks}]}`. `sources[0].url` is a master on `*.workers.dev` (`north-man.kurututujohn.workers.dev/hls2/..../master.m3u8?t=...&s=...&e=43200`) that redirects to `bx.netrocdn.site`; fetch it with `redirect: "follow"`.
3. Playlist and segments both need `Referer` **and** `Origin` `https://moviesapi.to` (Referer alone -> 302, no headers -> 403).

Checked: movie 27205 (1920x1080, 8888 s), 238 (1920x1080, 10629 s), 872585 (1920x872), TV 1399 S1E1 (1280x720 + 1920x1080, 3697 s). ffmpeg decodes. Segments are direct (no signed proxy) and were still valid 30 s after the playlist fetch; ~6 MB each, so genuine high bitrate 1080p. `source:"vidora"`; the `sources` array had a single entry each time.

---

## vixsrc.to  (status: candidate)

Pure HTTP, no key.

1. `GET https://vixsrc.to/api/movie/{tmdb}` or `/api/tv/{tmdb}/{season}/{episode}` -> `{src:"/embed/{id}?token=...&t=...&expires=...&lang=en&canPlayFHD=1..."}`.
2. `GET https://vixsrc.to{src}` (Referer `https://vixsrc.to/movie/{tmdb}`). The HTML contains `window.masterPlaylist = { params: {token, expires, asn}, url: 'https://vixsrc.to/playlist/{id}?b=1' }` and `window.canPlayFHD`. Extract `url`, `token`, `expires` by regex.
3. Master URL = `{url}&token={token}&expires={expires}` (plus `&h=1` when `canPlayFHD` is true, and `&lang=en`). Fetch with `Referer: https://vixsrc.to/`. It is a real master with `#EXT-X-MEDIA` audio (English, Italian) and subtitle tracks; the variants' URLs carry their own per-rendition tokens.

Checked: movie 27205, 238, 157336, 872585 (API answers), TV 1399 S1E1 (API answers); playlist decoded in ffmpeg for 27205. Renditions in the master head: 480p, 720p (1080p not confirmed; check with `h=1`). It is the StreamingCommunity catalogue (Italian-first), so coverage differs. Streaming Unity is a front-end for it.

---

## api.vidlove.cc  (status: candidate)

Pure HTTP, Cinezo-style API.

`GET https://api.vidlove.cc/{movie?id=TMDB | tv?id=TMDB&season=S&episode=E}&mode=json&sources=vidapi` with `Referer: https://player.vidlove.cc/`, `Origin: https://player.vidlove.cc`. Response JSON has `meta` (TMDB), `subtitles`, and `source: {source:"vidapi", label:"VidAPI", url, manifest}`. `url` is a master on `*.whysosigmabro.cfd/api?d=...` (`application/vnd.apple.mpegurl`); `manifest` is the same master inlined (640x266 / 1280x534 / 1920x800). The body contains raw control characters: parse with a lenient JSON parser (`JSON.parse` fails; strip control chars first). Other `sources=` values (`moviebox2`, `megaknight`, `warden`, `cinefreak`, `berlin`) returned `source: null` on all titles tried. Checked movie 27205/238/157336/872585 and TV 1399 S1E1; ffmpeg decodes.

---

## atlantic.st  (status: candidate)

Pure HTTP; AES-GCM with a key shipped in the client bundle (same scheme as vidrock, different key).

1. `GET https://stream.hls.lol/helios?tmdbId={id}&type=movie` or `...&type=tv&seasonId={s}&episodeId={e}` (no special headers needed). Returns `{sources:{Moscow:{label,server,type:"hls",url:"ns_<hex>"}, Novo:{...}, Omsk:{...}}}`.
2. Decrypt `url`: strip the `ns_` prefix, hex-decode; first 12 bytes = IV, rest = ciphertext+tag; AES-GCM, key = hex `e4b8a1d6f2c9037b5a8e4d1c6f9b2085a7c3e9f6d1b4a8c2e5f7a0d3b6c9e2f5` (constant `xR` in `assets/index-*.js`; the function is `ER`). A `url` without `ns_` is plaintext.
3. Plaintext is `https://peraspera.nbsycfzrpa4.workers.dev/?payload=...&headers=...`; the `headers` param is an encrypted blob the proxy applies upstream, so leave the URL untouched. Fetch with `Referer: https://atlantic.st/` **and** `Origin: https://atlantic.st`; without them the proxy answers 302.

Checked movie 27205 (640x266/1280x534/1920x800, 8888 s) and TV 1399 S1E1 (640x360/1280x720, 3697 s), all three servers, segments fetched, ffmpeg decodes. Segments are MPEG-TS served as `text/html` (same as nextgencloudfabric below). The site also has a `cdn.hls.lol/content/{movie|tv}/...` route ("Aphrodite") that needs a header computed by a client helper; not needed since `helios` works.

---

## new.vidnest.fun  (status: candidate) -- one backend, many upstreams

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
