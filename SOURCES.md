# Source tracker

Every source considered for this bundle, so the list can be worked through. Update it in the same commit whenever a source changes status. Statuses:

- **implemented** -- shipped in `src/index.mts`.
- **candidate** -- verified by hand to give a playable HLS link (ffmpeg decode) with plain HTTP or a simple browser step; ready to build.
- **possible** -- a real lead, but needs work (decryption, a gate to understand) before it is a candidate.
- **untriaged** -- reachable, no blocker seen, not yet examined. `embeds:` lists upstream players its bundles reference; if one of those becomes a scraper, this site is covered too.
- **rejected** -- blocked (Cloudflare/Turnstile/captcha, sign-up, bot detection), dead, or DASH-only. Reasons are recorded so nobody retries them blindly. The rules in AGENTS.md still apply: challenges and bot detection are not bypassed.

Sources: the *Stream Aggregators*, *Dedicated-Server* and *Multi-Server* sections of <https://fmhy.net/video> (checked 2026-09-27), plus atlantic.st, nepu.io, ee3.me and pressplayz.to supplied directly. Triage was a single homepage fetch per site (status, Cloudflare/Turnstile markers, sign-in redirect) plus a scan of its JS bundles for the upstream players it references.

Totals: implemented 7, candidate 1, possible 2, untriaged 104, rejected 37 (151 sites).

## Upstream players (where the leverage is)

Most aggregators are front-ends over a handful of upstream players, so a scraper for the upstream covers many sites. Probed with movie 27205 (Inception) and, where noted, TV.

| Upstream | Status | Notes |
|---|---|---|
| player.cinezo.live / proxy1.flikhub.net | implemented | Cinezo scraper. HTTP only. |
| vixsrc.to | candidate | Pure HTTP, no browser. `GET /api/movie/{tmdb}` or `/api/tv/{tmdb}/{s}/{e}` returns `{src:"/embed/ID?token=…"}`; the embed page holds `window.masterPlaylist` (`url` + `params.token/expires`). Master URL = `url` + `&token=…&expires=…` (add `&h=1` for FHD). HLS master on vixsrc.to itself, needs `Referer: https://vixsrc.to/`; played in ffmpeg. Renditions seen 480p/720p (1080p not confirmed in the master head; check `canPlayFHD`/`h=1`), audio eng + ita, many subtitle tracks. Works for movie and TV, several titles. Backend of Streaming Unity. Note it is the StreamingCommunity/AnimeUnity catalogue: Italian-first, title coverage differs from the others. |
| api.vidlove.cc (player.vidlove.cc, 111movies.net) | candidate | Pure HTTP, same API family as Cinezo: `GET https://api.vidlove.cc/{movie?id=TMDB | tv?id=TMDB&season=S&episode=E}&mode=json&sources=vidapi` with `Referer`/`Origin` `https://player.vidlove.cc`. Returns `source.url` (a master, `application/vnd.apple.mpegurl`) and an inline `source.manifest` with 640x266 / 1280x534 / 1920x800 variants; ffmpeg decodes it. Movie and TV worked on 4 titles. Other sources (`moviebox2`, `megaknight`, `warden`, `cinefreak`, `berlin`) returned null here. JSON has raw control characters: parse leniently. Segment host is `*.whysosigmabro.cfd` (rotating), so follow the playlist rather than assuming it. |
| vidzee (player.vidzee.wtf / core.vidzee.wtf) | possible | Browser run reached an HLS master on `cdn1.ngcorp.dad`. The API `core.vidzee.wtf/streams/movie/{id}?s=dcloud&e=1` answered 502 to a plain curl; probably needs headers or a decrypt step. Same CDN as vidrock. |
| vidrock.net | possible | `GET /api/movie/{id}` works over HTTP but the per-server `url` values are encrypted (base64url blob); the key/decrypt lives in the client JS. Ends at `cdn1.ngcorp.dad` HLS. |
| vidnest.fun | possible | `new.vidnest.fun/yflix/movie/{id}` returns an encrypted `data` blob; browser run reached an HLS host (`pwcloud.animanga.fun`). Needs decrypt. |
| vidlink.pro | possible | `/api/b/movie/{encrypted id}`; the id is produced client-side (WASM/obfuscated). Streams seen are MP4 files from `noon.mooncase.online` (moviebox CDN) -- would be `resolveKind: "file"`, and moviebox is DASH/MP4 elsewhere. |
| videasy.net / videasy.to | untriaged | Browser run captured no stream in 24s (no click target found). Widely embedded (15+ sites) so worth a proper look. |
| vidfast.pro / .vc | untriaged | No stream captured in 24s; heavy page. Widely embedded. |
| vidup.to | untriaged | No stream captured in 24s. |
| 2embed (2embed.skin) | untriaged | No stream captured in 24s. |
| peachify.top | rejected | Cloudflare challenge on the embed; its API host (`x.eat-peach.sbs`) answered 522. |
| vidking.net | rejected | Cloudflare challenge / no connection. |
| vidsrc.to | rejected | Cloudflare challenge. |
| vidcore.net / vidcore.io | rejected | 403 (checked earlier). |
| cinesrc.st | implemented | This is ShuttleTV's backend (shuttletv scraper). |

## Implemented (7)

| Site | Section | Note |
|---|---|---|
| [7Movies](https://7movies.ac/) | stream-aggregators | sevenMovies |
| [ArrowTV, 2 or Cinezo, 2](https://arrowtv.net/) | stream-aggregators | cinezo (Cinezo) |
| [bCine](https://bcine.ru/) | stream-aggregators | bciney |
| [Cinejoy](https://cinejoy.pk/) | stream-aggregators | cinejoy |
| [Flixer, 2, 3 or Hexa](https://flixer.gd) | stream-aggregators | flixer |
| [Movy](https://www.movy.sx/) | stream-aggregators | movy |
| [ShuttleTV, 2, 3](https://shuttletv.su/) | stream-aggregators | shuttletv |

## Candidates (verified, ready to build) (1)

| Site | Section | Note |
|---|---|---|
| [Streaming Unity](https://streamingunity.vip/) | dedicated-server | Front-end for **vixsrc.to** (see upstream table). |

## Possible (leads) (2)

| Site | Section | Note |
|---|---|---|
| [Atlantic](https://atlantic.st/) | dedicated-server | Own API: `cdn.hls.lol/content/{movie/tv}/…` (needs a header from a client-side helper) and `stream.hls.lol/helios?tmdbId=…` (AES-GCM payload, key ships in the bundle). No challenge seen. Worth a proper look. |
| [PressPlay](https://pressplayz.to/) | dedicated-server | Astro site, no challenge on the homepage. Not investigated further. |

## Untriaged (104)

| Site | Section | Note |
|---|---|---|
| [Abibli](https://abibli.com/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [arc018](https://arc018.stream/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [BFLIX](https://bbflix.one/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [Downloads-Anymovies](https://www.downloads-anymovies.co/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [Filmo](https://filmo.to/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [FshareTV](https://fsharetv.co/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [Levidia, 2, 3](https://www.levidia.ch/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [LookMovie, 2](https://lookmovie2.to/) | dedicated-server | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [MovieBox, 2, 3, 4, 5](https://movieboxonline.net) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [MovieNestBD](https://movienestbd.best/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [PrimeWire, 2, 3](https://www.primewire.mov/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [ShowBox](https://www.showbox.media/) | dedicated-server | homepage mentions Turnstile/captcha; may only gate the site UI, not the embed. Low priority |
| [SoapGo](https://soapgo.to/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [SubSL](https://subsl.top/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [YesMovie](https://ww1.yesmovies.ag/) | dedicated-server | no known upstream seen in its bundles; needs its own look |
| [1Shows, 1Flex or 1Tube](http://1shows.bz) | multi-server | no known upstream seen in its bundles; needs its own look |
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

## Rejected (37)

| Site | Section | Note |
|---|---|---|
| [AZMovies](https://azmovies.to/) | dedicated-server | dead/gated: redirects to a /verify gate |
| [CinemaCity](https://cinemacity.cc/) | dedicated-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [EE3 or RIPS](https://ee3.me/) | dedicated-server | requires sign-up / invite code (account creation is off-limits) |
| [HollyMovieHD, 2, 3, 4](https://hollymoviehd.cc/) | dedicated-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [M4uHD](https://m4uhd.vip) | dedicated-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [NEPU, 2, 3, 4](https://nepu.io/) | dedicated-server | Cloudflare challenge on the homepage |
| [OnionPlay](https://onionplay.st/) | dedicated-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [RidoMovies](https://ridomovies.is/) | dedicated-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [UniqueStream](https://uniquestream.net/) | dedicated-server | dead/gated: no connection |
| [DuaFile, 2](https://download.duafile.com/) | multi-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [FilmCave or Flixway](https://filmcave.ru/) | multi-server | Cloudflare challenge / 403 on the homepage (fetch test) |
| [KiraStreams](https://kirastreams.pages.dev/) | multi-server | dead/gated: 404 |
| [Moviepire, 2](https://moviepire.org/) | multi-server | dead/gated: empty 136-byte page |
| [ONOFLIX, 2 or GGFlix](https://onoflix.live/) | multi-server | dead/gated: HTTP 523 (origin down) |
| [Pawflix](https://pawflix.foo.ng/) | multi-server | dead/gated: invite only (/forbidden) |
| [Streaming CSE, 2, 3, 4](https://cse.google.com/cse?cx=006516753008110874046:cfdhwy9o57g##gsc.tab=0) | multi-server | dead/gated: Google custom search, not a source |
| [67Movies or PhantomFlix](https://67movies.st/) | stream-aggregators | checked earlier, no usable stream (now a parked-style page) |
| [Bingr](https://bingr.one/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [Cinetaro](https://cinetaro.to/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [Flixtrz](https://flixtrz.com/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [FlyStream](https://flystream.net/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [Kofi](https://kofi.mov/) | stream-aggregators | dead/gated: 404 |
| [MeowTV or FlickyStream](https://meowtv.ru/) | stream-aggregators | encrypted responses; WASM key gated by headless detection (bot detection, not bypassed) |
| [Moovie or StreamAggregator](https://moovie.fun/) | stream-aggregators | DASH only (resolveKind cannot carry it) |
| [Movie Night](https://movienig.ht/) | stream-aggregators | checked earlier, no usable stream |
| [NOVA](https://novahd.cc/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [PopcornMovies or BingeBox](https://popcornmovies.ac/) | stream-aggregators | Cloudflare challenge |
| [Reelix or Coreflix](https://reelix.ac/) | stream-aggregators | vidcore backend answers 403 |
| [Rive, 2, 3 or CorsFlix, 2, 3](https://www.rivestream.app/) | stream-aggregators | Turnstile challenge |
| [Spacedom](https://spacedom.live/) | stream-aggregators | Cloudflare challenge / 403 on the homepage (fetch test) |
| [SpenFlix](https://watch.spencerdevs.xyz/) | stream-aggregators | CDN 403s non-browser TLS |
| [Stellar](https://stellar.gdn/) | stream-aggregators | Turnstile |
| [Streamo](https://streamo.pro/) | stream-aggregators | captcha, no stream reachable |
| [Surface Stream](https://watchsurface.stream/) | stream-aggregators | dead/gated: no connection |
| [Vivarium](https://viv.st/) | stream-aggregators | Turnstile |
| [Way2Movies, 2](https://beta.way2movies.live/) | stream-aggregators | Cloudflare challenge |
| [ZXCSTREAM](https://zxcprime.icu/) | stream-aggregators | DASH only |
