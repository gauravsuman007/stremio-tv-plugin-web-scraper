# Scraper strategies

Worked-out recipes for sources that are ready (or nearly) to build, so a scraper can be written without redoing the research. Status lives in [SOURCES.md](SOURCES.md); this file is the *how*. Every recipe was checked by hand on 2026-09-27 with movie TMDB 27205 (Inception) and, where noted, TV 1399 (Game of Thrones) S1E1, decoding the result with ffmpeg:

```
ffmpeg -v error -rw_timeout 15000000 -user_agent "<browser UA>" \
  -headers "Referer: R\r\nOrigin: O\r\n" -f hls -allowed_extensions ALL -extension_picky 0 \
  -i "<url>" -t 8 -f null -
```

All of these are `HttpSite` scrapers (no Chromium): put the API call in `httpCaptures`, yield `{mediaUrl, label}`, let `pickBestCapture` do the rest. Cross-cutting lessons (read the first one before building anything):

- **Host limits decide what can ship** (`stremio-tv-plugin-web-links`, `src/plugin.mts`). The relay sends `Referer` on every playlist and segment fetch, plus any `WebLink.headers` (web-links >= 0.9.0: `Origin`, `Accept`, `Accept-Language`, `User-Agent`, `X-*` only -- no `Cookie`). It relays `#EXT-X-MEDIA` audio/subtitle playlists as playlists since 0.8.3 (before that it treated them as segments, which left a master with separate audio silent). Test a new source **through the relay**, not just in ffmpeg: `relay-e2e`-style (a local HTTP server fronting the plugin's `variant`/`segment` routes, ffprobe/ffmpeg pulling from it) proves audio + video decode with only the headers the link declares. Measured: moviesapi, atlantic, vidlove, vidnest `nextgencloudfabric` and vixsrc play with Referer alone; **vidrock Orion/Luna need `Origin`** (403 without) -- shipped by setting `headers` on the site.
- **Cloudflare/Turnstile-gated sources are no longer an automatic reject.** [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) can solve the challenge and hand back `cf_clearance` + a matching User-Agent for research (see AGENTS.md's "Getting past Cloudflare/Turnstile with FlareSolverr"). But if the *stream itself* needs that cookie to fetch (not just the site's HTML), it can't ship yet: the relay allowlist has no `Cookie`, so record it as `blocked` in SOURCES.md pending that host change, don't mark it `implemented`. If only the API/HTML is Cloudflare-gated but the resulting playlist/segment URLs are cookie-free (a signed URL, a token in the query string), it ships normally -- FlareSolverr was only needed to find the recipe.
- Tokens are short-lived; always resolve at play time.
- A server that answers with a master is not necessarily playable: check a segment. Leaf-playlist duration (`leafDuration`) already catches stubs; segments on a forbidden CDN (see vidrock's Atlas) need a segment fetch, which `pickBestCapture` does not do today.
- **A WASM-gated id/key derivation is not automatically a `BrowserSite`.** See AGENTS.md's "Reverse-engineering WASM-gated sources instead of accepting BrowserSite" for the general approach (run the module standalone in Node with `WebAssembly.instantiate` + its own glue, stubbing only the globals it actually touches; disassemble with `wasm2wat` when the entry point isn't obvious; confirm parity against a captured browser input/output before trusting the standalone run). vidlink.pro below is a worked *dead end* for this -- read it before re-attempting that specific site, but the technique is still worth trying on other WASM-gated candidates since the reason it failed there (CDN rejects every requester but the site's undocumented internal client) is specific to that CDN, not to WASM extraction in general.

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

## play.xpass.top  (status: implemented in 1.23.0 -- `src/sites/xpass.mts`)

1Shows' "Premium embeds" server (viduki.net/4 iframes it). Plain HTTP, checked 2026-09-27 on Inception and GoT S1E1.

1. `GET https://play.xpass.top/e/movie/<tmdb>` or `/e/tv/<tmdb>/<s>/<e>`: the HTML has `var dataUrl="/data/movie/<tmdb>?autostart=...&token=<v3|...>.<64 hex>"`.
2. `GET` that dataUrl: the body is base64url(iv[12] || AES-256-GCM ciphertext || tag). Key = SHA-256 of the string `spv3-data-response|spv3-build-1787821613-50e5fc97c9dce367|<dataUrl pathname>|<token>`. The build label is a constant inside the player script `/static/<random>.js` (loaded by `/static/mainmini.js`; both obfuscated with the usual string-array rotator -- run the decoder in `node:vm` to read them). If decryption fails, it rotated.
3. Plaintext: `[{id, name:"VIP 1", url:"/vip/<blob>/1/playlist.json", dl}, ...]`, 30-60 servers (VIP, FIL, WIS, FEB, BOX, LUL, VID, MOL, BIG, MIX, TAP, SAF, ZUR, MEG, VXR, VRK).
4. `GET` a server's `playlist.json` (Referer the embed): `{playlist:[{sources:[{file, type:"hls"}]}]}`.

What played (ffmpeg, Referer `https://play.xpass.top/` alone): **VIP** (`vip.1x2.space/playlist/.../master.m3u8`, the 640x266/1280x534/1920x800 encode vidlove also serves) and **LUL** (`cflul.*.workers.dev`, Aether's CDN; 1080p on TV). FIL/WIS masters were empty or 404, MEG timed out, FEB is FebBox at 360p, BOX is MP4. The playlist endpoint answers 429 after ~15 quick calls, so the scraper asks at most two VIP and two LUL servers.

## Byse (ex-Filemoon)  (status: implemented in 1.23.0 -- `src/byse.mts`, used by arc018 and filmo)

The embed (`https://<rotating domain>/e/<code>`, e.g. mfw09.org, bysezejataos.com; `/d/<code>` is the same video's download page) is a React app; everything below was read from `assets/videoPagesBundle-*.js` and `assets/pow-*.js` and confirmed by logging the page's requests (hooking `crypto.subtle` and `allHeaders()`, see AGENTS.md). All `POST`s go to the embed's own origin with `Referer: <the page that iframes it>`, `Origin: <embed origin>`, `X-Embed-Origin: <referer host>`, `X-Embed-Parent: <embed url>`, `X-Embed-Referer: <referer>`.

1. `POST /api/videos/access/challenge` (no body) -> `{challenge_id, nonce}`.
2. Make an ECDSA P-256 key, sign the nonce's UTF-8 bytes (SHA-256, raw r||s, base64url). `POST /api/videos/access/attest {viewer_id:"", device_id:"", challenge_id, nonce, signature, public_key:<JWK x/y>, client:{user_agent, platform, screen_*, webgl_*, canvas_hash, audio_hash, fonts_hash, ...}, storage:{}, attributes:{entropy:"high"}}` -> `{token, viewer_id, device_id, confidence}`. The client profile is only scored: a made-up Mac Chrome with random hashes gets 0.55 (headless Chromium 0.88) and passes. Send `Cookie: byse_viewer_id=..; byse_device_id=..` from here on.
3. `POST /api/videos/<code>/embed/captcha {fingerprint}` -> `{pow_nonce, pow_difficulty:16, pow_token, algorithm:"sha256-leading-zero-bits"}`. Despite the name the hash is **not** SHA-256: it is a custom 512-word memory-hard mix of ChaCha quarter rounds (`gr` in `pow-*.js`, ported in `powHash`). Solution = first counter `c` with `leadingZeroBits(hash("<pow_nonce>:<c>")) >= difficulty`; ~65k tries, 0.5-3 s in Node.
4. `POST /api/videos/<code>/embed/captcha/verify {pow_token, solution, fingerprint}` -> `{token}`.
5. `POST /api/videos/<code>/embed/playback {fingerprint}` with `X-Captcha-Token: <token>` -> `{playback:{iv, payload, key_parts[30], version}}` (without steps 1-2 this answers 405). Key = base64url(key_parts[v-1]) || base64url(key_parts[31-v-1]) (v=12 -> parts 12 and 19, 16 bytes each); AES-256-GCM, tag = last 16 bytes of payload. Plaintext: `{sources:[{url:<master.m3u8>, label:"1080p", height}], tracks}`.

The master (`*-sprintcdn.*/hls2/.../master.m3u8?t=&s=&e=10800&...&asn=<caller ASN>`) plays with no Referer at all; the label always says 1080p, the real rendition is often 1280x536. The URL is bound to the resolving network's ASN, so resolve where you play. Whole resolve 0.7-3 s.

## VOE  (status: implemented in 1.23.0 -- `src/voe.mts`, used by filmo)

`voe.sx/e/<code>` returns `window.location.href = '<mirror>/e/<code>'`. The mirror page has `<script type="application/json">["<blob>"]</script>`: rot13, delete the markers `@$ ^^ ~@ %? *~ !! #&`, base64-decode, subtract 3 from every char code, reverse, base64-decode -> JSON with `source` (HLS master, multi-audio renditions as `#EXT-X-MEDIA`) and `direct_access_url` (MP4). The master is ASN-bound (`asn=`) and played with or without a Referer.

## arc018.stream / BFLIX  (status: implemented in 1.23.0 -- `src/sites/arc018.mts`)

Same backend (the `data-token` blobs and videos match). Movie page `/watch-movie/<slug>-<year>-watch-online/`, episode page `/episode/<slug>-<year>-watch-online/sXX-eYY/`; slug = title lower-cased with every run of non-alphanumerics one `-` (`Léon: The Professional` -> `l-on-the-professional`); `/search?q=` as fallback. The page's `<section ... data-token="...">` goes to `POST /ajax/ajax.php` as multipart `players=<token>` (movie) or `players_show=<token>` (episode) -> `[{name:"arc018", link:"https://mfw09.org/e/<code>?sub.info=..."}, {name:"Vidmoly", link:"https://kaembed.net/embed-<id>.html?..."}]`. Byse: above. Vidmoly: the embed HTML has `sources: [{ file: '<master.m3u8>' }]`; plays with Referer `https://kaembed.net/`. BFLIX movies also redirect straight through `https://0123movie.space/mv/<imdb>/<tmdb>/` -> the Byse embed (an unknown imdb falls back to `vidsrc-embed.ru`).

## filmo.to  (status: implemented in 1.23.0 -- `src/sites/filmo.mts`)

German, movies only; a Laravel site. `GET /search/suggest?q=` -> `{movies:[{title,url}]}` (German release titles, so the scraper also asks TMDB for the `de-DE` title). The movie page has one `provider-row__lang` row per audio language (English / Deutsch) with chips `data-p="<Laravel encrypted blob>" aria-label="VOE|Byse"`. With the page's session cookies and `<meta name="csrf-token">`: `POST /n {"p":...}` (`X-CSRF-TOKEN`) -> `{x}`; `GET /n/<x>` -> 302 to the VOE embed, or a 200 interstitial whose `<a class="open" href>` is the Byse `/d/<code>` page (use `/e/<code>`). Tokens are single use.

## movienestbd.best  (status: implemented in 1.24.0 -- `src/sites/movienestbd.mts`)

Bengali/Hindi-dub catalogue, plain HTTP, no key. `GET /search?q=<title>` -> `<a href="/<slug>" class="movie-card ...">`; the title page's `<title>` is `Name (Year) ...` and its inline `rawLinks` array has `{link: "https:\/\/jiofiles.pics\/<24hex>", quality: "1080P"}` per quality. `jiofiles.pics/<id>` is an obfuscated React app that renders nothing headless -- use `https://embed.jiofiles.pics/<id>` instead: plain HTML with an iframe `indbd.pages.dev/embed/<host>/<vid>`. `GET https://indbd.pages.dev/api/info?url=<host>&id=<vid>` (no headers) -> `{referer, data:{cfNativeDirect, hlsVideoTiktok, sourceDirect, ...}}`. `cfNativeDirect` is `https://<host>/v4/pl/.../master.<ver>.m3u8?k=&kx=` (kx = expiry, ~6h ahead); its children carry the query themselves and segments are absolute fMP4 on `stn.professionalidentity.cyou`. All need `Referer: https://<host>/` (403 without). Verified 2026-09-30 with ffmpeg: video leaf and English audio playlist each decode 8s; ~350 KB/s per connection. `hlsVideoTiktok` -- and occasionally the cf master itself -- lists `p16/p19-ad-site-sign-sg.tiktokcdn.com` "images": MPEG-TS behind a 120-byte PNG header (ffmpeg's probe sees PNG), so it is not offered. Series pages carry season packs (`rawEpisodes` empty), not episodes: not served. `sourceDirect` is a bare-IP host, not tried.

## Upstream players behind the untriaged front-ends (2026-09-30)

What the embeds named in SOURCES.md's untriaged rows turned out to be, so a front-end listing only these is covered or stuck:
- `111movies.net/movie/<tmdb>` iframes `player.vidlove.cc` -- covered by `vidlove`.
- `vaplayer.ru/embed/movie/<tmdb>` iframes `nextgencloudfabric.com` -- vidnest's CDN, covered by `vidnest`.
- `embed.filmu.in` -- Bingr's own player (its allowlist names bingr.live); see Bingr in SOURCES.md.
- `mappletv.uk` redirects to `mapple.fun/watch/movie/<tmdb>`: first call `POST /api/request-token` -> a JWT; no stream request followed in 20 s headless. Not followed further.
- `peachify.top`, `1embed.cc`, `multiembed.mov` (-> `streamingnow.mov`): Cloudflare challenge on the embed itself (403 "Attention Required" / "Just a moment").
- `cinemaos.tech/player/<tmdb>` 500s; `megaplay.buzz/stream/...` answers an "Error" page.
- `vidfast`: see its SOURCES.md row.

Tooling note for this container: Chromium only works reliably through the agent proxy when it is passed explicitly -- `chromium.launch({ proxy: { server: process.env.HTTPS_PROXY }, args: ["--disable-http2", "--disable-quic"] })` and `ignoreHTTPSErrors`; without it most navigations fail with `ERR_TOO_MANY_RETRIES`. A blind sweep of the 88 untriaged front-ends (guessing `/watch/movie/<tmdb>` etc. and clicking) captured no media request on any of them: their players mount only on real interaction, so each needs its own look.

## vidzee  (status: rejected -- redundant)

`core.vidzee.wtf/streams/movie/{id}?s={server}&e=1` returns `{"c": "<encrypted>"}` (server `ipcloud` gave an HLS master on `cdn1.ngcorp.dad`, the same Atlas CDN whose segments are 403 "domain forbidden"). The plain call with `s=dcloud` returned 502. Its useful output is available more simply from vidrock (same sources) and vidnest's `vidzee` route (a single MKV that timed out). No further work justified.

---

## WASM reverse-engineering: cinejoy, shuttletv (HttpSite since 1.18.0), flixer (HttpSite since 1.19.0) (2026-09-27)

Applied AGENTS.md's "Reverse-engineering WASM-gated sources instead of accepting BrowserSite" to the three shipped scrapers that were `BrowserSite` because of a WASM gate. **cinejoy and shuttletv are now plain-HTTP `HttpSite`s** (browser versions archived in `src/sites/archive/`); flixer followed in 1.19.0 (below) -- its earlier "needs fingerprinting" verdict was wrong. Verified by ffmpeg-decoding 8 s of each returned link: cinejoy 5/5 (Inception, Superman 2025 in 4K, Breaking Bad S2E3, The Matrix, Casablanca), shuttletv 4/5 (Casablanca not on cinesrc). Not yet re-tested inside the server container (Docker was down) -- do that before trusting it from the datacentre IP.

### What finally worked (techniques, in the order they paid off)

- **Real Playwright with `context.addInitScript`**, never the sandboxed MCP browser (it injects after page scripts run and silently drops network history).
- **Hook `crypto.subtle` with a stack trace on every call.** The stack names the bundle and column of each crypto step, which turned "where does this come from" into a lookup. Log args *and* results, including `exportKey` results: that is how the XOR key and a "random" field were identified below.
- **Log requests with `request.allHeaders()`** (includes cookies) and every request, not just `/api/`: the missing half of the shuttletv protocol was a Next.js **server action** (`POST /embed/movie/<id>` with a `next-action` header), invisible to a filter on `/api/`.
- **Hand the page a substitute WASM instance.** A WebAssembly `exports` object is frozen, so assigning wrappers into it silently does nothing (last round's cinejoy dead end). Instead wrap `WebAssembly.instantiate`/`instantiateStreaming` and *return a different object* `{ module, instance: { exports: { ...wrapped } } }`; the page calls through the wrappers. Dump linear memory at every pointer argument before and after the call -- that exposes plaintext inputs and outputs of an opaque export.
- **Splice test in a real session.** Let the browser build a request, then in `page.route` replace one component with your Node-built one and see whether the server still accepts. This isolated the one rejected field (below) in three runs.
- **Instrument an internal WASM function without renumbering anything** (flixer): `wasm2wat`, find the function by a constant it uses (SHA-256's `K[0]` = `i32.const 1116352408`; AES fixslice has no S-box table, but its function stands out by having ~100 `i32.rotr`), and insert at its entry `local.get 0..n; f64.const -12345; ...; call <an existing import of a matching type>` -- reusing an import that is dead on the path you trace (flixer's `fillText`), so no index shifts. `wat2wasm`, load it in a Node research harness with the site's own glue JS, and have that import's JS side dump memory when it sees the sentinel. Logging every SHA-256 compression block (state + 64-byte block) reads the whole key derivation off directly.
- **Find a derived AES key by brute force over memory.** After the module decrypts once in the harness, try every 4-byte-aligned 32-byte window of linear memory as an AES-256-CTR key over the first ciphertext block, with the obvious IV layouts; a JSON-looking plaintext gives you the key and the IV/counter convention in seconds (flixer: 12-byte nonce, counter from 2 -- i.e. GCM).
- **A module's import list is not evidence it uses those imports on your path.** flixer's `img_data_bg.wasm` imports canvas/navigator/localStorage; they only feed anti-bot checks (errors `E24`, `E57` in a naive harness: page age from `performance.now()`, time bucket) around a pure key schedule, which is easy to rebuild. Trace before you give up.
- **Run an obfuscated JS VM in `node:vm`, for instrumentation only.** donut.js (a bytecode VM) ran in a `vm` context with a stubbed `document`/`canvas`/`navigator`, a `Worker` shim (it spawns blob-URL workers), and a `with (Proxy)` wrapper that logs every global it reads that the sandbox lacks. Then patch its opcode handlers (`function(a,b,c){c(a,b(a)^b(a))}` etc., found by grepping the source) to log operands, which exposes a custom hash's constants and structure. **Never ship this**: `node:vm` is not a security boundary and would run the site's code in the host process. The shipped scrapers run only the sites' zero-import `.wasm` (checked with `WebAssembly.Module.imports(m).length === 0` at load), everything else is reimplemented.

### cinejoy.pk -> `api.wing.st` (implemented, `src/sites/cinejoy.mts`)

- `GET https://api.wing.st/servers` -> `{servers:[{name,status,"4k"}]}` (Nebula, Lisbon, Solara, Athens).
- `https://api.wing.st/crush.wasm`: Rust, zero imports, exports `memory`, `alloc(len)`, `dealloc(ptr,len)`, `seal_request(json, jsonLen, rand, 44, out, outLen) -> written`. Inputs: `JSON.stringify({path, payload})` and 44 random bytes. `path` is `/<Server>/movie` or `/<Server>/series`; `payload` is `{tmdb, title, year}` (+ `season`, `episode` for series; the page also sends `imdb`, not required). Output: `out[0..32]` = response AES key, `out[32..98]` unused, `out[98..written]` = the exact `POST /g` body (content-type `text/plain;charset=UTF-8`; no Referer/Origin required).
- Response: `iv = resp[0..12]`, AES-256-GCM, `additionalData = "lumen-gate-v2\0" || body[0..67]` -> `{"data":{"stream":[{"type":"hls","playlist":"https://..."}]},"status":200}` or `{"data":{"error":"..."},"status":404}`.
- CDNs: Nebula `nebula.bright67.online/hls/<uuid>/master.m3u8` (1080p, same files as cinesrc's Nebula), Lisbon `lit.cheaptruckrepairs.cc/playlist/*.m3u8` (up to 4K, Rivestream's source too), Solara `cheaptruckrepairs.cc/content?v=` (403 without Referer). A Referer of `https://cinejoy.pk/` is all any needs. No need to understand the cipher: crush.wasm is a black box that only computes.

### shuttletv.su -> `cinesrc.st` (implemented, `src/cinesrc.mts` + `src/sites/shuttletv.mts`)

Last round's writeup got three things wrong, corrected here: the PoW proof **is** needed (it travels inside the encrypted challenge, not in a header); our ECDH public key **is** sent (inside the same challenge, so there is no degenerate-point paradox); and `pack[4]` is **not** a custom alphabet, it is a token written backwards.

1. `POST /api/c/bootstrap`, header `x-cs-q: base64url(JSON.stringify([mediaType("movie"|"tv"), id, season|null, episode|null]))` (strings) -> `{v, r, p}`. Cookies `cs_ac=r`, `cs_pb_<sha256(q)[0..16]>=p` (set them yourself).
2. `GET /api/c/issue` with `x-cs-q`, `x-cs-p: p`, `x-cs-r: r` -> `{w, t, n, s}`. Solve `w` with `pow-v3.wasm` (zero imports: `a(len)` alloc, `b(ptr,len)` -> pointer to a NUL-terminated `m3.<hex>`; 3-20 ms).
3. `GET /api/c/stage2/issue` with `x-cs-q`, `x-cs-r` -> `{pack:[hex64, 52, reverse(RSA-1024 SPKI base64), hex32, reverse(ss2 token)]}`. `GET /api/c/pk` -> RSA-2048 PEM.
4. Challenge `s1~A~B~C::c2::D::c3::<r>`:
   - **s1** (prod.js): a JSON array of 17 fixed field UUIDs, each followed by its value, with random `"_zXX", base64(4 random bytes)` decoy pairs between: protocol label `csp3-20260613-b`, `"s1"`, `w`, proof, `issue.t`, `issue.n`, `issue.s`, `Date.now()`, 8 random bytes hex, UA, page path, a fingerprint object (`tz, lang, langs, pf, cm, dpr, sw, sh, cd, cvs, wgl, jit`), 16 random bytes b64, 32 random bytes hex, **our raw P-256 ECDH public key (b64)**, `1`, 18 random bytes b64 (echoed back as `n`). UTF-8, **XORed with the AES key itself** (32-byte repeat), then AES-256-GCM (AAD and RSA-OAEP label both `cinesrc-challenge|csp3-20260613-b|s1`), key RSA-OAEP-SHA256-wrapped with `/api/c/pk`. `A~B~C` = standard base64 of wrapped key, iv, ciphertext. The field order and ids are in `src/cinesrc.mts`.
   - **c2** (donut.js, `window.__ss2_challenge.gc()`): `{v:1, t, ua, p:{s:salt, x}, fp:{c,g,tz,l,ls,pf,sw,sh,cd,ce,dpr}, xg:{r:ss2, t, s, m}}`, AES-256-GCM (no AAD) with the key RSA-OAEP-SHA256-wrapped under the reversed `pack[2]`, base64url `c2~wrapped~iv~ct`. `ss2 = reverse(pack[4]) = "ss2." + base64("<ipHash>.<base64url JSON {salt,target,d:17,...}>") + "." + hex sig`. `x` is 5 hex digits with `sha256(salt + x) == target` (<= 2^17 tries). `xg.s = H(inner + "\x1e" + salt + "\x1e" + x + "\x1e" + target + "\x1e" + t)` and `xg.m = H(ss2 + "\x1f" + salt + "\x1fstage2")[0..24]`, where `H` is donut's own 160-bit mixing hash (5 lanes, rotl 5/7/11/13/17 per byte, 12 finalization rounds; constants `c2b2ae35 03040506 04040404 9e3779b9 85ebca6b 27d4eb2d 045d9f3b`, round multipliers `9e3779b1 85ebca77 c2b2ae3d 27d4eb2f`) -- `donutHash` in `src/cinesrc.mts`, verified against browser-produced values. **`xg.s`/`xg.m` were the only thing the server rejected when faked**; the fingerprints themselves are replayed constants.
5. Server action `getStream(tmdbId, "movie"|"show", season|"$undefined", episode|"$undefined", challenge, providerId)`: `POST /embed/<type>/<id>`, headers `next-action: <id>`, `accept: text/x-component`, body the JSON array. Action ids come from `createServerReference)("<id>",...,"getStream")` in the page's `/_next/static/chunks/*.js` (also `getProviderList`, no args, -> `[{id,name,rank,flags}]`). The answer is an RSC stream containing `r3.<serverPubB64u>.<salt>.<iv>.<hdrB64u>.<ct>` (inline `1:"r3..."` or, when long, a `2:T<len>,r3...` text chunk) or `e1:invalid_challenge`.
6. Decrypt: ECDH(our private key, serverPub) -> HKDF-SHA256(salt, info `cinesrc-response|csp3-20260613-b|r3|<serverPub>|<hdr>|<ourPubB64u>|kdf`) -> AES-256-GCM(iv, AAD `cinesrc-response|csp3-20260613-b|r3|<serverPub>|<hdr>`) -> `{url:[{source:"HLS", url:"/api/playlist/<token>.m3u8"}], name, provider}`. A challenge is single-use: every provider tried repeats steps 1-6 (~1.5 s).

Fragile points, most likely first: the action ids (rediscovered automatically), the `csp3-20260613-b` label and s1 field ids (in `/300726c-prod.js`, string-obfuscated; a change shows as `e1:invalid_challenge`), donut's hash constants.

### flixer.gd -> `plsdontscrapemelove.flixer.gd` (implemented, `src/sites/flixer.mts`, 1.19.0)

The previous write-up here said `img_data_bg.wasm` fingerprints the browser and flixer must stay a `BrowserSite`. Wrong: the stream comes from a signed API call whose answer that module decrypts, and nothing it checks reaches the server.

1. The player (`plsdontscrapemelove.flixer.gd/assets/client/tmdb-image-enhancer.js`, readable) gets a 64-hex "api key" from the WASM's `get_img_key` -- **the server accepts any random 64-hex string**.
2. `GET /api/time` -> `{timestamp}` (server seconds).
3. `GET /api/tmdb/movie/<id>/images` or `/api/tmdb/tv/<id>/season/<s>/episode/<e>/images`, headers `X-Api-Key: key`, `X-Request-Timestamp: t`, `X-Request-Nonce` (22 base64 chars, `/+=` stripped), `X-Request-Signature: base64(HMAC-SHA256(key, "key:t:nonce:path"))`, `X-Client-Fingerprint` (a 32-bit string hash; any constant, `tomljm`), `X-Fingerprint-Lite: b4f8a1fc72e905d63e` (a constant set by a `fetch` wrapper in `index-*.js`; **403 "no sources found" without it**), `Accept: text/plain`, Origin/Referer flixer.gd. With `bW90aGFmYWth: 1` it lists servers; with `X-Only-Sources: 1` + `X-Server: <nato>` it answers one server.
4. The body is base64 `iv(12) || ciphertext || tag(16)`, **AES-256-GCM** with key `HMAC-SHA256(R, floor(t / 300) + key)`, where `R = sha256^600(key || salt)` (first hash over the key string plus a 16-byte salt, then 599 more over the 32-byte digest) and **the salt changes every hour**: `salt[i] = (i + 1) ^ (hour >> (i & 7))`, `hour = floor(t / 3600)` (read off the WASM: bytes `01..10` at a fixed address, XORed with the shifted hour count). A first version hard-coded one hour's salt and went dead at the top of the hour -- when a derived constant looks random, vary the clock in the harness before trusting it. Plaintext `{"servers":{...}}` or `{"sources":[{"server","url"}]}`.
5. Servers `alpha`..`hotel`. `alpha` gives `fuckme.dragonballzfans.xyz/<32hex>/<32hex>.m3u8` (single playlist), `delta` `serve.dragonballzfans.xyz/proxy?data=` (a master, segments PNG-prefixed), `bravo`/`charlie` often `null`. No header needed to play either.

How it was found: `crypto.subtle` hook -> the HMAC and headers; running the module in a Node harness with stubbed globals (`performance.now()` must look like a page several seconds old, else `E24`) -> plaintext; memory scan -> AES key + GCM counter; SHA-256 compress instrumented via a reused import -> the key schedule. The shipped scraper runs none of the site's code. Verified 5/5 (Inception, Game of Thrones S1E1, Superman 2025, Casablanca, Breaking Bad S2E3), 6-9 s with servers asked in parallel.

Fragile points: the salt formula, round count and the `X-Fingerprint-Lite` constant are baked into the current bundle/module; a change shows as 403 or a GCM auth failure (the scraper then returns nothing).

---

## movy, bciney, 7movies: browser-only for no good reason (HttpSite since 1.19.0, 2026-09-27)

These were `BrowserSite`s because the player needed a click or the capture was the easy path, not because of a gate. Each turned out to need one to three plain requests. Method: `netlog` the real page (Playwright, every request with `allHeaders()` and every text/JSON response, `crypto.subtle` + `WebAssembly.instantiate*` hooks); where nothing crypto shows, grep the bundle for the endpoint.

**movy.sx -> `api.wecollege.net` (`src/sites/movy.mts`).** `GET /seed?mediaId=<tmdb>` -> `{seed: "<floor(t/30)>.<22 chars>", ttlMs: 30000}`; then `GET /<city>/sources?title=<encodeURIComponent(title)>&mediaType=movie|tv&year=&episodeId=&seasonId=&tmdbId=&enc=2&seed=` with Origin/Referer `www.movy.sx`. Sixteen cities (miami, boise, seattle, atlanta, austin, berlin, cancun, dallas, delhi, denver, munich, orlando, paris, phoenix, portland, tampa); miami/boise (`moon.quietridge.top`, per-quality single playlists), atlanta (a Workers proxy) and paris (vidzy master) played for Inception and GoT; several others 500 upstream. imdbId isn't needed. The body is base64url XOR a keystream from the seed and tmdb id -- a 61-slot sparse state seeded by FNV-1a + murmur3 `fmix32`, in the `1zyk0gv4kwtq5.js`-style chunk that references `/miami/sources` (module 8311 at the time) -- and must start with `mvm1`. **Reuse one seed across providers**: a fresh seed per call (16 at once) got every later seed rejected with `401 STREAMCRYPTO_SEED_INVALID` for about a minute; the four providers asked in parallel on one seed are fine (since 1.20.0). Players need only the Referer.

**bciney.to -> `player.bciney.to` (`src/sites/bciney.mts`).** `GET /embed/movie/<tmdb>` (or `tv/<id>/<s>/<e>`) is server-rendered; its Next.js flight data (`self.__next_f.push([1,"..."])` string chunks, concatenated) contains `"initialServers":[{name, url, type: "hls", quality, resolution}]`, the url being `v.bciney.to/v?url=<upstream master>&headers=...`. Nothing else is needed.

**7movies.ac -> `embed.vidrift.net` (`src/sites/7movies.mts`).** `GET /api/boot/<path>?` (header `x-embed-parent:` empty) -> `meta.playbackToken` (a signed JWT-like token, ~12 h) `meta.warmStreams` (already-resolved relay URLs) and, for some titles, `meta.evionUrl` (a ready `relay.vidrift.net/ev/.../index.m3u8`, H.264 with dub audio tracks, which the player leads with). A title the site doesn't carry answers `{"error":"Playback is not available for this title."}` (Breaking Bad). `GET /api/source/<path>?token=<t>&provider=<p>` -> `{streams:[{proxyUrl|url, type, provider}]}`; the player's cascade is `moviebox` (label Orion; HEVC 1080p master with a separate audio group, relative `/api/mb/<id>/master.m3u8`; dropped by browsers without HEVC), `vaplayer` (Earth), `vidlove` (Star), `vidrock` (Atlas). Some providers answered a Cloudflare 502 page when asked right after others; the scraper asks the four in parallel. The page also runs Cloudflare's JS-detection (`cdn-cgi/challenge-platform`), but the API didn't require its cookie from a plain Node client.

---

## vidlink.pro  (status: possible -- hard, and MP4 not HLS)

`GET /api/b/movie/{id}?multiLang=0` where `{id}` is produced client-side by `window.getAdv(tmdbId)`, implemented in a Go WebAssembly module (`/fu.wasm`, run through the `Dm` wasm_exec shim) that also needs `window.sodium` (libsodium-wrappers). The request also carries a header (constant `i.Zt` in the page chunk) and the response is decoded by a function `n.D`. The streams it produced in a browser were signed **MP4 files** on `noon.mooncase.online/mp/...` (a proxy to the moviebox CDN `bcdn.hakunaymatata.com`), not HLS.

If ever needed: cheapest route is a `BrowserSite` that loads `https://vidlink.pro/movie/{id}` and captures the `media` requests (that is what the 28 s probe did), returning `resolveKind: "file"` links -- but `pickBestCapture` is HLS-only today, so it needs a file path first. Low priority: moviebox is also reachable elsewhere.

**Tried again 2026-09-27, dead end.** Fetching `/api/b/movie/{id}` directly (bypassing the WASM entirely, since it's a plain `GET`) works and returns `stream.qualities` with plain, already-signed URLs straight on `bcdn.hakunaymatata.com` -- no wrapper -- for 360p/480p/1080p, each flagged `"requiresProxy": true`. But the site's own player never issues an ordinary browser request for one of them either: with a real page open and the video visibly playing, no `bcdn.hakunaymatata.com` request ever appears in the page's network log, so whatever the player does to actually pull the bytes is invisible to `page.on('request')` (worker-thread fetch, or something the WASM does directly) -- there's nothing for a `BrowserSite`'s capture to intercept. And the returned URL is unusable on its own: fetching it directly (even with the right Referer) answers `428 Forbidden`, whether from this machine or from inside the same browser context that requested it, so it's bound to something beyond a Referer/Origin check -- consistent with `requiresProxy`. Not pursued further: this isn't a header or signature we're missing, it's the CDN refusing every requester that isn't the site's own undocumented internal client. Still `possible`, still low priority.

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
| `scrapper.rivestream.app/api/provider?provider=vanguard&id=TMDB[&season=&episode=]` | **Built** as `rivestream` (1.15.0). Plain JSON, no key, no headers needed for the API. `data.sources[0].url` is `proxy.valhallastream.com/m3u8-proxy?url=<real>&headers=<json>`; unwrap it: the real URL is a cinejoy-CDN master (`lit.cheaptruckrepairs.cc/playlist/...`, 3840x2160 HEVC / 1080 / 720 / 360) and the headers are `Referer: https://cinejoy.pk/`, `Origin: https://cinejoy.pk` (needs web-links >= 0.9.0). 8/10 titles (Casablanca, The Last of Us null), under 1 s. Same pool as cinejoy but no browser. `provider=pulse` and `apex` returned `{data:null}` then; on 2026-09-27 it was the other way round (`vanguard` null for 7/7, `apex` -> Vidnest's CDN with `Referer/Origin: https://nextgencloudfabric.com`, `pulse` -> `tiki.aether.cx`), so 1.21.0 asks all three in parallel and takes each source's Referer/Origin from its own `headers=` parameter (`Capture.referrer`/`headers`). |
| `www.lookmovie2.to` | **Built** as `lookmovie` (1.15.0). (1) `GET /api/v1/{movies\|shows}/do-search/?q=TITLE` -> `result[]{slug,title,year}`. (2) `GET /{movies\|shows}/play/SLUG`: inline `hash: "..."`, `expires: N`, `id_movie: N` (movies) or `window.seasons='{...}'` (shows; a JS single-quoted string, unescape `\'`, `\"`, `\\`, then JSON; `seasons[S].episodes[E].id_episode`). (3) `GET /api/v1/security/movie-access?id_movie=&hash=&expires=` or `episode-access?id_episode=...` -> `streams` (`{"480p"\|"480":url\|null,...}`), single-rendition HLS. No Referer needed, no Cloudflare on the API. Mostly 480p only; some titles `/aes/` (AES-128, relayed fine). 9/10 titles (The Godfather not in the catalogue). Homepage mentions Turnstile but the API path never hit it. |
| `api.speedracelight.com/{hdmovie,cdn,lamovie,meine}/sources-with-title?title=&mediaType=&year=&tmdbId=&imdbId=&enc=2&seed=` (seed from `/seed?mediaId=TMDB`, 30 s TTL) | Not built. `hdmovie`/`cdn` return an encrypted blob whose scheme is not visible from outside (it lives in the blocked library); `lamovie`/`meine` 500. Left as `possible`. |
| `proxy.valhallastream.com/m3u8-proxy` | Rivestream's proxy; unwrapped, not used. |

Repeated on the Aether fork (aether.ist) with a TV episode (Game of Thrones S1E1): it surfaced `lul.aether.cx` above, plus its own TMDB/OpenSubtitles/analytics calls (not streams) and `nebula.aether.cx` (always 502).

The forks also call `sub.wyzie.io`, `sub.vdrk.site` (subtitles), `api.theintrodb.org`, `api.skipdb.tv`, `v3-cinemeta.strem.io`: metadata, not streams. Repeat the method on another fork or another title to find more upstreams (the source list changes per media type, so try a TV episode too).

Repeated again on the Basement fork (basementx.lol) with the same movie: it surfaced a `videasy.to` master (2160p, full length) reachable with just `Origin`/`Referer: player.videasy.to`, but only through Basement's own signed backend (`be.basementx.lol`/`dim.basementx.lol`, per-request `sig`+`exp`) -- not reproducible without their key, so not built. See SOURCES.md's `videasy.net / videasy.to` row.

**2026-09-27, six more forks checked, one hit (Aether above), rest dead ends or malicious:**
- pstream.cfd: down (Cloudflare 524) that day.
- icefy.top, streamwatch.online: both a bait popup ("install this extension to unlock the content") / an ad redirect to an unrelated Opera-install page on load, before any player runs -- malvertising, not a real fork. Skip on sight; don't interact with either kind of page.
- cinecat.eu: surfaced `cdn.hls.lol/content/{movie|tv}/...` (Atlantic's own "Aphrodite" route, already flagged above as needing a client-computed header) -- but every title's `payload` proxies to the exact same `totallyacdn.org` response, the Atlantic *landing page* HTML, regardless of `tmdb_id`. Dead: this route is decommissioned, not just gated.
- cinefork.net: surfaced `cdn.reelvault.click/movie_{tmdb}/vod.m3u8` -- the domain doesn't resolve (NXDOMAIN) at all, so this "source" is simply broken on their own site. Its other backend (`/api/ext/nest/...`) is vidnest's `yflix` upstream, already noted above as PNG-segment/not real video.

Six forks in, the easy wins from this method are exhausted: what's left needs either reverse-engineering a heavier client (videasy's Next.js bundle) or chasing domains that don't even resolve. Diminishing returns; stop here unless a genuinely new fork surfaces.

## vidfast.vc (status: blocked, researched 2026-09-30)

Not built. Recorded so the research isn't repeated.

- `vidfast.pro` redirects to `vidfast.vc`, a Next.js app. The title page (`/movie/<tmdb>`, `/tv/<tmdb>/<s>/<e>`) carries an `en` token in its flight data.
- Chunk `365-<hash>.js` (~2 MB, obfuscated) holds several JS bytecode VMs. One of them seals `en` into the request path; another runs a devtools detector (it times a `console.table` call), which trips under Playwright's console hook and leaves the page stuck on "FETCHING".
- Server list: `POST https://vidfast.vc/<long rotating base path>/imtoz/<id>/<sealed en>` with a fixed `X-Csrf-Token`. Streams: `POST .../imtoz/<other id>/<server.data>`.
- Responses are base64 AES-256-GCM (`salt16 ‖ iv12 ‖ ciphertext ‖ tag16`); the key derives from a per-deploy constant and the salt, and the plaintext is an 8-byte timestamp followed by JSON.
- Streams seen: a `moon.zenoak.top` master playlist up to 4K, needing `Referer`/`Origin: https://vidfast.vc`.
- Blocker: the request seal's outer encoding lives inside the bytecode VM. Hand-built requests get HTTP 500. The base path, ids, CSRF token and all crypto constants rotate with each deploy, so any rebuilt seal would break on the next release.
- Decision: the VM is a purpose-built anti-scraping measure; defeating it (or auto-tracking its rotations) is out of scope for this repo. vidfast is widely embedded by other sites (see SOURCES.md), so prefer those sites' other servers.
