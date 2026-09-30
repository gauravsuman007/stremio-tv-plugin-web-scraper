# Source tracker

Every source considered for this bundle, so the list can be worked through. The worked-out recipes for candidates are in [STRATEGIES.md](STRATEGIES.md) -- read the recipe before touching a candidate, don't redo the research. Update it in the same commit whenever a source changes status. Statuses:

- **implemented** -- shipped in `src/index.mts`.
- **candidate** -- verified by hand to give a playable HLS link (ffmpeg decode) with plain HTTP or a simple browser step; ready to build.
- **blocked** -- works end to end in ffmpeg, but the current host (`vendor/web-links`) can't play it: it sends only `Referer`, and rewrites `#EXT-X-MEDIA` URIs as segments. Needs a host change, see STRATEGIES.md.
- **possible** -- a real lead, but needs work (decryption, a gate to understand) before it is a candidate.
- **untriaged** -- reachable, no blocker seen, not yet examined. `embeds:` lists upstream players its bundles reference; if one of those becomes a scraper, this site is covered too.
- **rejected** -- dead, DASH-only, sign-up-walled, or otherwise a dead end. Reasons are recorded so nobody retries them blindly. A Cloudflare/Turnstile challenge alone is no longer a rejection reason -- see AGENTS.md's "Getting past Cloudflare/Turnstile with FlareSolverr" -- so rows below rejected only for that are marked `retriage: FlareSolverr` and are candidates for another pass, not settled.

Sources: the *Stream Aggregators*, *Dedicated-Server*, *Multi-Server* and *P-Stream Forks* sections of <https://fmhy.net/video> (checked 2026-09-27), plus atlantic.st, nepu.io, ee3.me and pressplayz.to supplied directly. Triage was a single homepage fetch per site (status, Cloudflare/Turnstile markers, sign-in redirect) plus a scan of its JS bundles for the upstream players it references. The p-stream GitHub org has no usable code (DMCA-disabled library, Turnstile-gated API), so P-Stream was studied black-box instead: which upstream APIs a live fork calls (STRATEGIES.md).

Totals: implemented 17, candidate 0, blocked 1, possible 4, untriaged 88, rejected 53 (163 sites).

## Upstream players (where the leverage is)

Most aggregators are front-ends over a handful of upstream players, so a scraper for the upstream covers many sites. Probed with movie 27205 (Inception) and, where noted, TV.

| Upstream | Status | Notes |
|---|---|---|
| player.cinezo.live / proxy1.flikhub.net | implemented | Cinezo scraper. HTTP only. |
| moviesapi.to / vidspark.to | implemented | Shipped in 1.12.0. Best find: real 1080p, static `x-player-key`, plain JSON API. Also the backend of PressPlay and vidnest `vidxyz`. See STRATEGIES.md. |
| vixsrc.to | implemented | Shipped in 1.13.0 (needs web-links >= 0.8.3 for its separate audio playlist). Pure HTTP; tokenised master from the embed page. Italian-first catalogue. Backend of Streaming Unity. See STRATEGIES.md. |
| vidrock.net | implemented | Shipped in 1.13.0 (Orion + Luna; sends Origin via WebLink.headers, needs web-links >= 0.9.0). Pure HTTP; AES-GCM with a key in the bundle; use servers Orion (1080p) and Luna, skip Atlas (dead segments). Needs Origin. See STRATEGIES.md. |
| api.vidlove.cc (player.vidlove.cc, 111movies.net) | implemented | Shipped in 1.14.0 (`vidlove`). Pure HTTP, `sources=vidapi`; Referer alone plays. Same content pool as Atlantic/vidrock Luna. See STRATEGIES.md. |
| atlantic.st (stream.hls.lol) | implemented | Shipped in 1.14.0 (`atlantic`; needs web-links >= 0.9.0 for Origin). Pure HTTP; AES-GCM key in the bundle; three servers. See STRATEGIES.md. |
| new.vidnest.fun | implemented | Shipped in 1.15.0 (`vidnest`, upstream `nextgencloudfabric` only). Keyless custom-alphabet base64. `allmovies` (Hindi dub) is not built: it returned Cloudflare 502 for every title on 2026-09-27. Others broken or PNG-segment. See STRATEGIES.md. |
| scrapper.rivestream.app | implemented | Shipped in 1.15.0 (`rivestream`, provider `vanguard` = 4K HDR cinejoy CDN, plain JSON). Found by watching P-Stream. Since 1.21.0 all three providers are asked at once: on 2026-09-27 `vanguard` was empty for every title and `apex` (Vidnest's CDN) / `pulse` (Aether's) answered instead, 3/7 titles. See STRATEGIES.md. |
| www.lookmovie2.to | implemented | Shipped in 1.15.0 (`lookmovie`). Search -> play page (hash, expires) -> access API; mostly 480p; TV works. Found by watching P-Stream. See STRATEGIES.md. |
| lul.aether.cx | implemented | Shipped in 1.16.0 (`aetherlul`). Plain HTTP backend of the Aether P-Stream fork: {stream: url} on cflul.*.workers.dev. Since 2026-09-27 the API's Cloudflare blocks a request with no Referer (403 "Attention Required"); 1.21.0 sends `Referer: https://aether.ist/`. 4/7 titles. Found by watching P-Stream. See STRATEGIES.md. |
| api.speedracelight.com | possible | Used by P-Stream (`{hdmovie,cdn,lamovie,meine}/sources-with-title?...&enc=2&seed=` after `/seed?mediaId=`). Returns an encrypted blob; the decryption scheme is not visible from outside and lives in the blocked library, so not pursued. `lamovie`/`meine` 500. | 2026-09-27 lead: movy's `api.wecollege.net` uses the identical `/seed` + `enc=2&seed=` scheme, and its keystream is now ported (`src/sites/movy.mts`) -- very likely the same decryption; retry with it. 2026-09-30: retried with movy's keystream, but `/seed` itself now answers Cloudflare 502 (origin down), so untestable. |
| vidzee (player.vidzee.wtf / core.vidzee.wtf) | rejected | Redundant: its working output is vidrock's (Atlas CDN, whose segments are 403 "domain forbidden") and vidnest's MKV route. |
| vidlink.pro | possible | Id minted by a Go WASM module (`fu.wasm` + libsodium); streams are moviebox MP4 files via `noon.mooncase.online`. Needs a BrowserSite and MP4/`file` support in `pickBestCapture`. Low priority. See STRATEGIES.md. |
| videasy.net / videasy.to | untriaged | Direct embed captured nothing in 24s; loading player.videasy.to directly gets 403 (checks the caller). Via vidnest it resolves to the nextgencloudfabric CDN with signed segments that answered 403. Watching a P-Stream fork (basementx.lol) that embeds it: the real master (moon.quietridge.top/vd/.../index-s2160p...m3u8, full length, 2160p) plays with Origin/Referer player.videasy.to, but the fork reaches it through its own backend (be.basementx.lol / dim.basementx.lol), which signs a `sig`+`exp` per request -- not reproducible without that private key. Not a candidate. |
| vidfast.pro / .vc | untriaged | No stream captured in 24s; heavy page. Widely embedded. 2026-09-30: `.pro` redirects to `vidfast.vc` (Next.js). The page carries an encrypted `en` token; chunk `365-*.js` (2 MB, obfuscated) POSTs `/<long rotating path>/imtoz/<server>/<data>` with a fixed `X-Csrf-Token` and decrypts the answer with AES-CBC via `crypto.subtle`. Headless Chromium never reaches that call (it waits on ad/anti-bot scripts on rotating throwaway domains), so no response captured. Needs the obfuscated builder reverse-engineered; the path and token rotate per deploy. |
| vidup.to | untriaged | No stream captured in 24s. |
| 2embed (2embed.skin) | untriaged | No stream captured in 24s. |
| peachify.top | rejected | Cloudflare challenge on the embed; its API host (`x.eat-peach.sbs`) answered 522. |
| vidking.net | rejected | Cloudflare challenge / no connection. |
| vidsrc.to | possible | 2026-09-27: no real Cloudflare gate (homepage loads plain). `embed/movie/<tmdb>` redirects through `vsembed.ru` (`vs_src.php?type=movie&id=<tmdb>`) to `cloudorchestranova.com/embed/movie/<tmdb>?vs=<token>`, which loads `vsdec.js` -- an obfuscated decoder for an encrypted source blob, the same "ProRCP"-style scheme vidsrc.to is publicly known for. No stream URL recovered; would need reverse-engineering `vsdec.js`'s decryption, not attempted this pass. |
| vidcore.net / vidcore.io | rejected | 403 (checked earlier). |
| api.wing.st | implemented | CineJoy's backend (cinejoy scraper). Plain HTTP since 1.18.0 (was browser-driven): requests to `/g` are sealed by running its zero-import `crush.wasm` in Node, answers are AES-GCM. Servers: Nebula (nebula.bright67.online, same files as cinesrc's Nebula), Lisbon (lit.cheaptruckrepairs.cc, up to 4K), Solara (cheaptruckrepairs.cc), Athens. See STRATEGIES.md. |
| cinesrc.st | implemented | ShuttleTV's backend (shuttletv scraper). Plain HTTP since 1.18.0 (was browser-driven): its challenge/ECDH protocol is rebuilt in `src/cinesrc.mts`, only its zero-import `pow-v3.wasm` is run. Providers seen: Nebula (nebula.bright67.online, 1080p), Lisbon (up to 4K). See STRATEGIES.md. |
| play.xpass.top (1x2.space) | implemented | Shipped in 1.23.0 (`xpass`). 1Shows' "Premium embeds"; TMDB-keyed `/e/movie/<id>`. The `/data/` answer is AES-256-GCM with key SHA-256(`spv3-data-response|<build>|<path>|<token>`); ~50 servers, VIP (vip.1x2.space) and LUL (cflul, Aether's CDN) play. See STRATEGIES.md. |
| Byse (ex-Filemoon: mfw09.org, bysezejataos.com, ...) | implemented | `src/byse.mts`, used by arc018 and filmo (1.23.0). challenge -> ECDSA attest -> custom memory-hard PoW -> AES-GCM playback whose key is two of its own `key_parts`. Stream URLs are ASN-bound. PrimeWire's Filemoon servers are this too. See STRATEGIES.md. |
| VOE (voe.sx + rotating mirrors) | implemented | `src/voe.mts`, used by filmo (1.23.0). Config is rot13/base64/shift/reverse/base64 JSON in the embed page; `source` is an HLS master (multi-audio as `#EXT-X-MEDIA`). ASN-bound. |
| Vidmoly (kaembed.net) | implemented | Used by arc018 (1.23.0): the embed page has `sources: [{file: '<master.m3u8>'}]` in plain JS; Referer kaembed.net. |
| viduki.net | possible | 1Shows' own player (`api.viduki.net/main/<type>/<id>?srv=`, altcha challenge + `makima` wasm + `pepper-key`). Its stream is the hunts439kow `i-arch-400` encode (640x266..1920x800), the same files as vidlove's vidapi, so not pursued. |
| vidy.st | implemented | Covered by movy: it calls `api.wecollege.net/miami/sources` with movy's seed scheme. |

## Implemented (17)

| Site | Section | Note |
|---|---|---|
| [Atlantic](https://atlantic.st/) | dedicated-server | atlantic (Atlantic) -- 1.14.0 |
| [LookMovie, 2](https://lookmovie2.to/) | dedicated-server | lookmovie (LookMovie) -- 1.15.0; plain HTTP, mostly 480p |
| [PressPlay](https://pressplayz.to/) | dedicated-server | covered by MoviesAPI: it only iframes moviesapi.to / vidspark.to / vidfast.pro |
| [Streaming Unity](https://streamingunity.vip/) | dedicated-server | covered by VixSrc (its front-end) |
| [7Movies](https://7movies.ac/) | stream-aggregators | sevenMovies -- plain HTTP (embed.vidrift.net boot/source API) since 1.19.0 |
| [ArrowTV, 2 or Cinezo, 2](https://arrowtv.net/) | stream-aggregators | cinezo (Cinezo) |
| [bCine](https://bcine.ru/) | stream-aggregators | bciney -- plain HTTP (servers in the embed page's flight data) since 1.19.0 |
| [Cinejoy](https://cinejoy.pk/) | stream-aggregators | cinejoy -- plain HTTP (crush.wasm in Node) since 1.18.0 |
| [Flixer, 2, 3 or Hexa](https://flixer.gd) | stream-aggregators | flixer -- plain HTTP (signed API, AES-GCM key schedule of img_data_bg.wasm rebuilt) since 1.19.0 |
| [Movy](https://www.movy.sx/) | stream-aggregators | movy -- plain HTTP (api.wecollege.net, seed keystream ported) since 1.19.0 |
| [Rive, 2, 3 or CorsFlix, 2, 3](https://www.rivestream.app/) | stream-aggregators | rivestream (Rivestream) -- 1.15.0; its scraper API is plain JSON (the Turnstile is only on the site UI) |
| [ShuttleTV, 2, 3](https://shuttletv.su/) | stream-aggregators | shuttletv -- plain HTTP (cinesrc protocol, src/cinesrc.mts) since 1.18.0 |
| [arc018](https://arc018.stream/) | dedicated-server | arc018 -- 1.23.0; plain HTTP: page `data-token` -> `ajax.php` -> a Byse embed (mfw09.org, src/byse.mts) and Vidmoly (kaembed.net). Movies and TV, 720p-1080p |
| [BFLIX](https://bbflix.one/) | dedicated-server | covered by arc018: same backend (same `ajax.php` tokens and Byse/Vidmoly videos); its movies also redirect via `0123movie.space/mv/<imdb>/<tmdb>/` to the same Byse file |
| [Filmo](https://filmo.to/) | dedicated-server | filmo -- 1.23.0; German site, movies only. VOE (src/voe.mts) and Byse mirrors per audio language (English/German), minted via `POST /n`. 720p-1080p |
| [1Shows, 1Flex or 1Tube](http://1shows.bz) | multi-server | xpass -- 1.23.0; its "Premium embeds" server is play.xpass.top (AES-GCM server list, key = SHA-256 of path+token). Its other servers: viduki.net (own API, altcha + `makima` wasm; same hunts439kow encode as vidlove, not built), vidy.st (= movy's wecollege backend, covered), vidfast, vidlink, vidrock (covered), vidzee |
| [MovieNestBD](https://movienestbd.best/) | dedicated-server | movienestbd -- 1.24.0; plain HTTP, movies only (series pages hold season packs). Page `rawLinks` -> `embed.jiofiles.pics/<id>` -> `indbd.pages.dev/api/info` -> `cfNativeDirect`, a signed master with Hindi+English `#EXT-X-MEDIA` audio, 1920x800. Segments ~350 KB/s (about 1.5x the 1080p bitrate) |

## Candidates (verified, ready to build) (0)

| Site | Section | Note |
|---|---|---|

## Blocked (works, but the host cannot play it yet) (1)

| Site | Section | Note |
|---|---|---|
| [Abibli](https://abibli.com/) | dedicated-server | 2026-09-27: its own player `rov.funnyotter.xyz/#<id>` (from `$store.streamPlayer.play(...)` on the title page). `POST https://s5v.lazyrocket.space/mQ7x2P {video, client:<32 hex>}` with header `x-s5v-client: <same>` returns a signed `/<id>/<x>.txt?session=&exp=&sig=&client=` master (Hindi+English audio). Works with plain HTTP, but the master's child playlists and segments (`.txt`, `.woff2`) are listed **without** the query and 403 without it: the page's player appends `?session=...` to every request. Needs the relay to carry a master's query onto its relative children (plus `X-S5v-Client`, which `X-*` already allows). |

## Possible (leads) (4)

| Site | Section | Note |
|---|---|---|
| [RidoMovies](https://ridomovies.is/) | dedicated-server | 2026-09-27: plain fetch of `/movies/<slug>` (curl 403s the raw domain, but the site itself HTTP-redirects to `ridomovie.to` and loads fine there with a browser UA -- not a real Cloudflare gate, `solveInProcess` not needed). `/movies/inception` resolves; the player is a same-origin iframe whose real `src` is only set on click, and every click target on the page is intercepted by an ad overlay (`directyp.org` popunder) in an automated Chromium session, so the actual stream request was never captured this pass. Needs a real click-through (dismiss/close the ad tab first) or a devtools-attached manual session. Not attempted: cookie check on the eventual player. |
| [Bingr](https://bingr.one/) | stream-aggregators | 2026-09-27: no Cloudflare gate in practice (Turnstile script loads but never blocks). `POST https://api.bingr.one/api/stream` with `{"srv":"s40","t":"movie","id":"<tmdb>","query":{"title":...,"year":...}}` (plain JSON, `Referer: https://bingr.one/`, no auth header, no cookie) returns `{"scraperName":"DarkMatter","sources":[{"url":"https://img.rousav.tech/media/<id>/index.m3u8",...}]}`. Verified with ffmpeg: the master (despite being named `index.m3u8` -> `tiles.m3u8` -> segments named `tiles/00000.png`) is real H.264 1920x800 video, full 2h28m runtime for Inception, decodes cleanly for 8s with only `Referer` (no cookie). But the master has no `#EXT-X-MEDIA` audio reference at all -- audio lives on a completely separate, unlinked `track_english.m3u8` (confirmed AAC via ffprobe on its segments) that the relay has no way to attach, so as returned this is video-only. Needs checking whether another `srv` value (only `s40`/DarkMatter tried) gives a master that properly links its audio track before this is buildable. 2026-09-30: every `srv` s1..s49 tried: only s30 (Nova, empty), s31 (Orion) and s40 answer. s31 is Vidrock (`shadowmoonwanderer.lol` master, `Referer/Origin: vidrock.ru`), already covered by `vidrock`. So nothing new here; embed.filmu.in is the same backend (its allowlist names bingr.live). |
| [Stellar](https://stellar.gdn/) | stream-aggregators | 2026-09-27: no real Cloudflare gate. The watch page (`/watch/movie/<tmdb>`) calls `POST https://api.stellar.gdn/api/resolve` with an encrypted body (`q`/`s`/`t`/`d` fields, opaque) and gets back a signed `cdn.reallyfast.ch/stream/<id>?e=<exp>&sig=<hex>` URL. That master fetches fine with just `Referer: https://stellar.gdn/` (HTTP 200, real playlist: 360p/1080p/4K variants each with a proper `#EXT-X-MEDIA` AUDIO group -- exactly the shape AGENTS.md wants) but every leaf/segment URL under it (`cdn.reallyfast.ch/v/...`) answered `502` on every attempt, with fresh tokens, with and without `Origin`, across all three renditions and both audio tracks. Either the reallyfast.ch origin is flaky, or it wants something (TLS fingerprint, a session cookie from `api.stellar.gdn`) a plain curl doesn't send. The `/api/resolve` request body itself is encrypted client-side (same shape as the already-`possible` `api.speedracelight.com` entry above) so this can't be reproduced without replaying the site's own JS. Not verified end to end; do not implement from this alone. |
| [PrimeWire, 2, 3](https://www.primewire.mov/) | dedicated-server | 2026-09-27: front-end of primesrc (`/js/primesrc-*.js`). `GET /api/v1/s?s_id=<id>&tmdb_id=<tmdb>&type=movie` is plain JSON listing servers (Filemoon = Byse, etc.) with a `key` each, but `GET /api/v1/l?key=` (the link) sits behind a Cloudflare **managed challenge** (and a Turnstile `token` on 403). The resulting embeds (Byse, ...) are cookie-free, so this needs a per-resolve challenge solve -- real FlareSolverr, not the in-process solver. |

## Untriaged (88)

| Site | Section | Note |
|---|---|---|
| [321Movies](https://321movies.xyz/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [7REELS](https://7reels.cc/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [AmberFlix](https://www.amberflix.xyz/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [AniCine](https://anicine.xyz/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Anixtv, 2, 3](https://anixx.fun/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [AuroraScreen, 2](https://aurorascreen.org/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Bingeflix](https://bingeflix.tv/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [CandleStream](https://candlestream.xyz/#home) | multi-server | embeds: new.vidnest.fun, peachify.top, player.videasy.to, player.vidzee.wtf, vaplayer.ru, vidcore.net, vidfast.in, vidfast.io |
| [CinebyTV](https://cinebytv.com) | multi-server | no known upstream seen in its bundles; needs its own look |
| [CineGo](https://cinego.co/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [CineNest](https://cine-nest-nine.vercel.app/) | multi-server | embeds: autoembed.co, cinesrc.st, moviesapi.to, multiembed.mov, player.autoembed.app, player.videasy.net, player.vidzee.wtf, primesrc.me |
| [CineStream](https://cinestream.kje.us/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [CineVibe](https://cinevibe.cc/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [CineWave](https://watch.cinewave.qzz.io/) | multi-server | embeds: 111movies.net, 2embed.cc, cinemaos.tech, hexa.su, mappletv.uk, peachify.top, player.videasy.net, player.vidzee.wtf |
| [Ernax](https://ernax.pro/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Fireflix](https://fireflix4.pages.dev/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [FishyStream](https://fishystream-app.pages.dev/) | multi-server | embeds: 111movies.net, 1embed.cc, cinesrc.st, embed.filmu.in, megaplay.buzz, peachify.top, player.cinezo.live, player.videasy.net |
| [Flicker](https://flicker-mini.pages.dev/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [FLIKER](https://fliker.freebuff.app/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Flixvo, 2](https://flixvo.live/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Flixzy](https://flixzy.pages.dev/) | multi-server | embeds: player.videasy.net, player.vidzee.wtf, vidfast.vc, vidlink.pro, vidrock.net |
| [FLNK](https://flnk.fun/) | multi-server | embeds: 111movies.net, 1embed.cc, autoembed.co, embed.smashystream.com, multiembed.mov, peachify.top, player.cinezo.live, player.videasy.net |
| [FluxTV](https://fluxtv.co.uk/) | multi-server | embeds: cinesrc.st, vidlink.pro |
| [Flyflix](https://flyflix.net/) | multi-server | embeds: 1embed.cc, cinemaos.tech, cinesrc.st, embed.filmu.in, moviesapi.to, player.cinezo.live, player.videasy.net, player.vidlove.cc |
| [FreeInterTV](http://www.freeintertv.com/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Heartive](https://heartivelovestv.pages.dev/) | multi-server | embeds: cinesrc.st, videasy.net, vidfast.pro, vidlink.pro, vidnest.fun, vidsrc.cc, vidzee.wtf, vixsrc.to |
| [HydraHD, 2](https://hydrahd.ws/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [KaitoVault](https://www.kaitovault.com/) | multi-server | embeds: 111movies.net, mappletv.uk, player.videasy.net, player.vidzee.wtf, vidfast.vc |
| [Meowly](https://meowly.qzz.io/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [MovieFY](https://player.xtra.wtf/search) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Movies To Watch](https://www.moviestowatch.top/) | multi-server | embeds: 111movies.com, 2embed.biz, autoembed.cc, cinesrc.st, multiembed.mov, player.videasy.net, vidfast.pro, vidking.xyz |
| [Primeshows, NetShows or Youshows](https://www.primeshows.org/) | multi-server | embeds: streamed.pk |
| [Snowstream](https://snowstream.vercel.app/) | multi-server | embeds: 111movies.net, embed.filmu.in, moviesapi.club, vidcore.net, vidfast.pro, vidlink.pro, vidnest.fun, vidrock.net |
| [StreameX, 2](https://streamex.sh/) | multi-server | embeds: cinemaos.tech, frembed.buzz, megaplay.buzz, peachify.top, vidcore.net, vidnest.fun, vixsrc.to, www.zxcstream.xyz |
| [StreamGoblin](https://streamgoblin.cc/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [TVids, 2, 3, 4](https://www.tvids.to/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Vidbox, 2, 3](https://vidbox.vc/) | multi-server | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [Warflix](https://warflix.im/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [WatchOrbit](https://watchorbit.me/) | multi-server | embeds: 111movies.net, 1embed.cc, cinemaos.tech, cinesrc.st, dl.peachify.top, embed.smashystream.com, frembed.help, moviesapi.club |
| [WatchSeries](https://watchseries.show/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Youflex](https://youflex.top/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [Zencine](https://zencine.org/) | multi-server | embeds: player.videasy.net, vidfast.pro, vidfast.vc, vidlink.pro, vidrock.ru, vidsrc.xyz |
| [Zerostream](https://zerostream.alwaysdata.net/) | multi-server | embeds: megaplay.buzz |
| [ZetMoon](https://zetmoon.live/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [ZFlix](https://zflix.me/) | multi-server | no known upstream seen in its bundles; needs its own look |
| [3eyedraven](https://3eyedraven.watch/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [All You Can Watch](https://allyoucanwatch.net/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Apexmovies](https://apexmovies.net/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [BingeBang](https://bingebang.st/) | stream-aggregators | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [Boomflix](https://boomflix.pages.dev/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Chillflix](https://chillflix.lol/) | stream-aggregators | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [Cineapse](https://www.cineapse.net/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Cineby (gdn), FMovies / 2, 3 or CineFlix](https://cineby.gdn/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Cinegram](https://cinegram.tv/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Cinema (BZ)](https://cinema.army/) | stream-aggregators | embeds: vidzee.wtf |
| [CinemaOS, 2 or NoirX, 2](https://cinemaos.live/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Cinemove](https://cinemove.cc/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [FRAME](https://www.framemovie.online/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [frameXTV](https://framextv.tech/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [GaiaFlix](https://gaiaflix.live/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [HiveX](https://hivex.stream/) | stream-aggregators | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [koddo](https://koddo.ch/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Lightflix](https://lightflix.app/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Mapple](https://mapple.fun/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Moonflix](https://moonflix.website/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [MovieBite](https://moviebite.org/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Movish or LatestMovies](https://movish.to/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [NetPlay or Cinelove](https://netplayz.icu/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Nippleflix, Redflix, 2 or PantyFlix](https://nippleflix.com/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [NOVERA](https://novera.tv/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Nxsha](https://web.nxsha.app/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Overlook](https://overlook.cx/) | stream-aggregators | embeds: player.videasy.net, vidlink.pro, vidrock.ru, vidsrc.wtf, vidup.to, www.videasy.net, www.vidsrc.wtf |
| [PopcornTime](https://popwatch.to/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [ReelZone](https://reelzone.icu/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Screenscape](https://screenscape.me/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Smashystream](https://smashystream.xyz/) | stream-aggregators | embeds: anime.smashystream.com, auth.smashystream.com, embed.smashystream.com, player.smashystream.com, smashy.stream, smashystream.com |
| [Stellar (rip)](https://stellar.rip/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Stigstream](https://stigstream.ru/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [StreamVaults or ReelStream](https://streamvaults.ru/) | stream-aggregators | embeds: player.videasy.net, vidsrc.icu, www.2embed.cc |
| [SvStream, 2, 3](https://svstream.cc/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Toflix](https://toflix.co/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [TonkaCine, 2](https://tonkacine.watch/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [VaultPlayer](https://vaultplayer.co.uk/) | stream-aggregators | embeds: vaplayer.ru |
| [Vegeta TV](http://vegetatv.duckdns.org/) | stream-aggregators | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [VidPlay](https://vidplay.to/) | stream-aggregators | embeds: player.videasy.net |
| [Vuflix](https://vuflix.co/) | stream-aggregators | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [Watchott or EmnexMovies](https://watchott.org/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |
| [Willow](https://willow.arlen.icu/) | stream-aggregators | no known upstream seen in its bundles; needs its own look |

## Rejected (53)

| Site | Section | Note |
|---|---|---|
| [AZMovies](https://azmovies.to/) | dedicated-server | dead/gated: redirects to a /verify gate |
| [CinemaCity](https://cinemacity.cc/) | dedicated-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [EE3 or RIPS](https://ee3.me/) | dedicated-server | requires sign-up / invite code (account creation is off-limits) |
| [HollyMovieHD, 2, 3, 4](https://hollymoviehd.cc/) | dedicated-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [M4uHD](https://m4uhd.vip) | dedicated-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [NEPU, 2, 3, 4](https://nepu.io/) | dedicated-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [OnionPlay](https://onionplay.st/) | dedicated-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [UniqueStream](https://uniquestream.net/) | dedicated-server | dead/gated: no connection |
| [DuaFile, 2](https://download.duafile.com/) | multi-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [FilmCave or Flixway](https://filmcave.ru/) | multi-server | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [KiraStreams](https://kirastreams.pages.dev/) | multi-server | dead/gated: 404 |
| [Moviepire, 2](https://moviepire.org/) | multi-server | dead/gated: empty 136-byte page |
| [ONOFLIX, 2 or GGFlix](https://onoflix.live/) | multi-server | dead/gated: HTTP 523 (origin down) |
| [Pawflix](https://pawflix.foo.ng/) | multi-server | dead/gated: invite only (/forbidden) |
| [Streaming CSE, 2, 3, 4](https://cse.google.com/cse?cx=006516753008110874046:cfdhwy9o57g##gsc.tab=0) | multi-server | dead/gated: Google custom search, not a source |
| [Aether](https://aether.ist/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [Basement](https://basementx.lol/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [Cinecat](https://cinecat.eu/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [Cinefork](https://cinefork.net/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [FMFAU](https://fmfau.com/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [IceFY](https://icefy.top/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [kstream](https://kdesa.stream/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [NovaShow](https://novashow.live/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [P-Stream Fork](https://pstream.cfd/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [peestream](https://peestream.in/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [Rizz Stream](https://rizzking.org/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [StreamWatch](https://streamwatch.online/) | p-stream-forks | P-Stream fork: a front-end for the shared `@p-stream/providers` library, which runs in the browser with the extension/userscript injecting headers. No backend of its own to scrape; the library repo (`p-stream/providers`) is blocked on GitHub for a DMCA takedown, so it is not used. Revisit only if a fork exposes its own API. |
| [67Movies or PhantomFlix](https://67movies.st/) | stream-aggregators | checked earlier, no usable stream (now a parked-style page) |
| [Cinetaro](https://cinetaro.to/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [Flixtrz](https://flixtrz.com/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [FlyStream](https://flystream.net/) | stream-aggregators | not Cloudflare -- a proof-of-work gate ("Anubis"), retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver; our Cloudflare-shaped marker set doesn't recognize it and a "cleared" result here can be premature (title still read "Making sure you're not a bot!" on a slower repeat run) -- not solved, not a candidate yet |
| [Kofi](https://kofi.mov/) | stream-aggregators | dead/gated: 404 |
| [MeowTV or FlickyStream](https://meowtv.ru/) | stream-aggregators | encrypted responses; WASM key gated by headless detection (bot detection, not bypassed) |
| [Moovie or StreamAggregator](https://moovie.fun/) | stream-aggregators | DASH only (resolveKind cannot carry it) |
| [Movie Night](https://movienig.ht/) | stream-aggregators | checked earlier, no usable stream |
| [NOVA](https://novahd.cc/) | stream-aggregators | 2026-09-27: no Cloudflare gate, and its API is plain HTTP -- `GET https://novahd.cc/api/sources?type=movie&tmdbId=<tmdb>` (no browser step, no cookie) returns `{"sources":[{"url":"https://novahd.cc/api/hls/index.m3u8?e=<token>","provider":"Falcon",...}]}`. But the playlist it returns is a decoy: every one of its 100 segments is the literal relative path `s.ts` (not per-segment URLs), and fetching `api/hls/s.ts` -- with or without the `e=` token, with or without `Referer` -- always returns the exact same 104KB clip (byte-identical, confirmed with `cmp`) of a generic placeholder (ffprobe: H.264 1280x720 + AAC, ~6s). The real per-title content is evidently gated behind something the plain API call doesn't supply (likely a `cf_clearance`/session cookie tied to the Turnstile widget that loads on-page but wasn't solved here) -- not a Cloudflare-challenge problem, a decoy-stream problem. Not implementable as-is. |
| [PopcornMovies or BingeBox](https://popcornmovies.ac/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [Reelix or Coreflix](https://reelix.ac/) | stream-aggregators | vidcore backend answers 403 |
| [Spacedom](https://spacedom.live/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [SpenFlix](https://watch.spencerdevs.xyz/) | stream-aggregators | CDN 403s non-browser TLS |
| [Streamo](https://streamo.pro/) | stream-aggregators | captcha, no stream reachable |
| [Surface Stream](https://watchsurface.stream/) | stream-aggregators | dead/gated: no connection |
| [Vivarium](https://viv.st/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [Way2Movies, 2](https://beta.way2movies.live/) | stream-aggregators | real Cloudflare managed challenge/Turnstile -- retried 2026-09-27 with `src/flaresolverr.mts`'s in-process solver (plain playwright-core Chromium), does not clear within 30s (real FlareSolverr needs a patched browser to get past this, out of scope here) |
| [ZXCSTREAM](https://zxcprime.icu/) | stream-aggregators | DASH only |
| [Downloads-Anymovies](https://www.downloads-anymovies.co/) | dedicated-server | dead: search answers 410 Gone, movie pages 500 (2026-09-27) |
| [FshareTV](https://fsharetv.co/) | dedicated-server | 2026-09-27: `/api/file/<id>/source` only ever returns the YouTube trailer without an account; Inception's page is a 404 |
| [Levidia, 2, 3](https://www.levidia.ch/) | dedicated-server | 2026-09-27: a link directory (goojara family); every `go.php?url=` outlink answered 404, with or without its session cookie (login-gated) |
| [MovieBox, 2, 3, 4, 5](https://movieboxonline.net) | dedicated-server | aoneroom/moviebox h5 backend (`h5.aoneroom.com/wefeed-h5-bff`) -- the same moviebox catalogue already rejected as MP4/DASH-only |
| [ShowBox](https://www.showbox.media/) | dedicated-server | 2026-09-27: links go to FebBox shares, which need a FebBox account cookie to stream (xpass exposes the same FebBox files at 360p as its `FEB` servers) |
| [SoapGo](https://soapgo.to/) | dedicated-server | 2026-09-27: `/embed/resolve/<token>` returns only `{"type":"mp4"}` sources (proxy.youwantsee.shop); no HLS |
| [SubSL](https://subsl.top/) | dedicated-server | 2026-09-27: Sinhala-subtitled catalogue; plays plain MP4 files from Facebook's CDN (fbcdn.net); no HLS |
| [YesMovie](https://ww1.yesmovies.ag/) | dedicated-server | Cloudflare Turnstile on search and pages (2026-09-27, headless Chromium looped on it) -- retriage: FlareSolverr |
