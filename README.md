# stremio-tv-plugin-web-scraper

Web-link scrapers for several streaming sites (CineJoy, Flixer, bCine, Movy,
ShuttleTV, 7Movies, Cinezo, MoviesAPI, Vidrock, VixSrc, Atlantic, Vidlove, Vidnest, Rivestream, LookMovie, Aether, XPass, arc018, Filmo, MovieNestBD): each searches its site for a title and returns
the best direct, per-quality video link, ready to be handed to a player.
They ship as one package, `streaming-sites`, for `stremio-tv-plugin-web-links`.

No site needs a browser any more (since 1.19.0). CineJoy, ShuttleTV, Flixer
and Movy speak their players' encrypted APIs directly (the crypto rebuilt in
Node, or a zero-import WASM run standalone), bCine's stream is in its embed
page's HTML, 7Movies' player API is plain JSON, and Cinezo, MoviesAPI, Vidrock,
VixSrc, Atlantic, Vidlove, Vidnest, Rivestream, LookMovie and Aether have open
APIs. XPass, arc018 and Filmo decrypt their players' answers (XPass) or speak
the Byse, VOE and Vidmoly file hosts (`src/byse.mts`, `src/voe.mts`). All
nineteen are plain HTTP.

## Sites

`dist/` is one package (`streaming-sites`) that exports nineteen scrapers, each registered by the
host under its own id. Every one asks its player's API directly (an
`HttpSite`, no Chromium involved). The browser-driven versions (`BrowserSite`s
that opened the player in Chromium and read the media URL it requested) are
kept, unexported, in `src/sites/archive/`: CineJoy and ShuttleTV until 1.18.0,
Flixer, bCine, Movy and 7Movies until 1.19.0. Since 1.20.0 the browser code
lives only in `src/browser.mts` (research and the archive; never bundled), so
`dist/` no longer ships playwright-core and the host needs no Chromium for it.
All share `src/shared.mts` (TMDB lookup, playlist verification, best-stream
picking) and each site is one small module in `src/sites/`.

`search()` resolves for real within the host's search budget (web-links'
"Search timeout" setting, 5s by default) and returns
one row per working server, best first (at most three per site), each stating
the resolution its playlist actually carries, e.g. `1920x1080/1280x720 ·
Nebula`, plus `height` so web-links >= 0.11.0 lists every scraper's rows
best resolution first. A site with nothing playable returns no row; one that doesn't finish
in time returns a placeholder row and keeps resolving in the background, so
pressing play picks up that same run instead of starting over. Servers are checked
concurrently. Every row keeps a `resolveId` (`<site>` or `<site>~<server>`):
`resolve()` hands back the link search found once a quick fetch shows it still
works, and otherwise resolves afresh, preferring that row's server (stopping
early on 2160p, or after 10s once something plays). To add a site, write an
`HttpSite`, wrap it with `createScraper`, and append it to the array in
`src/index.mts`.

The scraper's name on the plugins page carries its max quality ("Movy · up to
1080p"); it is the `maxQuality` on each adapter, set from testing across ten
titles (older and recent movies, three TV episodes) and worth re-checking now
and then.

| Scraper | Player | Max quality seen | Notes |
|---|---|---|---|
| CineJoy | cinejoy.pk | 4K | No browser: seals each server request with the site's own `crush.wasm` (zero-import, run in Node) and AES-GCM-decrypts the answer. Lisbon is 4K on some titles (Superman 2025, Breaking Bad), Nebula 1080p. Referer alone. 0.5-4s. |
| Flixer | flixer.gd | 1080p | No browser: signs each request with an HMAC under a random key and AES-256-GCM-decrypts the answer, with the key schedule its `img_data_bg.wasm` uses (rebuilt in Node; that module has imports, so it is not run). Eight NATO-named servers asked in parallel; some give a single playlist, `delta` a 1080/720/360 master. 720p on TV. 6-9s. |
| bCine | player.bciney.to | 1080p | No browser: the embed page's Next.js flight data lists its servers (`initialServers`). 1080/720/360 masters; widescreen titles report e.g. 1920x800. ~10s (the proxied playlists are slow to verify). |
| Movy | movy.sx | 1080p | No browser: `api.wecollege.net/<city>/sources?enc=2&seed=`, XORed with a keystream the page's JS derives from the seed and tmdb id (ported). miami/boise give single playlists named for their resolution, paris a master. 2-15s; its CDN is sometimes slow. |
| ShuttleTV | cinesrc.st (shuttletv.su's player) | 4K | No browser: rebuilds the page's two-part RSA/AES challenge (with its `pow-v3.wasm` proof and a fingerprint hash recovered from its JS VM) and ECDH-decrypts the answer (`src/cinesrc.mts`). Nebula 1080p, Lisbon up to 4K. 2-6s. |
| 7Movies | embed.vidrift.net (7movies.ac's player) | 1080p | No browser: `api/boot` gives a playback token and pre-resolved streams, `api/source?provider=` the rest (moviebox HEVC 1080p, vaplayer, vidlove, vidrock), plus Evion when the boot names it. Needs HEVC for moviebox. Not every title (Breaking Bad: "not available"). 10-15s. |
| Cinezo | player.cinezo.live (arrowtv.net's player) | 1080p | No browser: `proxy1.flikhub.net` answers plain HTTP given the player's Referer/Origin. Only its `berlin` source (HLS) is used; 1-4s. Missing for some titles (The Godfather, Superman 2025 returned an upstream 502). |
| MoviesAPI | moviesapi.to (PressPlay's backend) | 1080p | No browser: a plain JSON API with a static player key from its bundle; ~1s. Muxed 1080p, playlist and segments play with the Referer alone. Missing for some titles (Casablanca, Breaking Bad S1E2, The Last of Us: upstream 502/404). |
| Vidrock | vidrock.net | 1080p | No browser: its API returns AES-GCM-encrypted server URLs (key in its bundle). Uses the Orion and Luna servers; both need an `Origin` header, sent via `WebLink.headers` (needs web-links >= 0.9.0). 2-4s. |
| VixSrc | vixsrc.to (Streaming Unity's backend) | 720p | No browser: API -> embed page -> tokenised master. English and Italian audio are separate playlists (needs web-links >= 0.8.3 to relay them); 480p/720p only; Italian-first catalogue. 0-1s. |
| Atlantic | atlantic.st (stream.hls.lol) | 1080p | No browser: JSON API, AES-GCM-encrypted server URLs (key from the player bundle). Needs `Origin` (web-links >= 0.9.0). 2-9s. |
| Vidlove | api.vidlove.cc | 1080p | No browser: JSON API (`sources=vidapi`), Referer alone. 0-3s. |
| Vidnest | new.vidnest.fun (`nextgencloudfabric`) | 1080p | No browser: JSON in a custom-alphabet base64 (no key). Same catalogue as Atlantic/Vidlove. 3-7s. |
| Rivestream | scrapper.rivestream.app (`vanguard`) | 4K | No browser: JSON API, unwraps its proxy URL; needs `Origin` (web-links >= 0.9.0). 4K HEVC master on the cinejoy CDN. <1s. Found by watching P-Stream. |
| LookMovie | lookmovie2.to | 480p (some 720/1080) | No browser: search -> play page -> access API. Movies and TV. Mostly 480p; some AES-128. 3-5s. Found by watching P-Stream. |
| Aether | lul.aether.cx | 1080p | No browser: JSON API, no headers anywhere. Backend of the Aether P-Stream fork. 1-3s. Found by watching P-Stream. |
| XPass | play.xpass.top (1Shows' "Premium embeds") | 1080p | No browser: the server list is AES-256-GCM with a key hashed from the request's own path and token. VIP (1x2.space) and LUL servers. 2s. |
| arc018 | arc018.stream (also BFLIX's backend) | 1080p | No browser: page token -> `ajax.php` -> Byse (challenge, ECDSA attest, proof of work, AES-GCM playback; `src/byse.mts`) and Vidmoly. Movies and TV, mostly 720p. 2-5s. |
| Filmo | filmo.to | 1080p | No browser: German site, movies only; VOE (`src/voe.mts`) and Byse mirrors per language (English/German). 8-10s. |
| MovieNestBD | movienestbd.best | 1080p | No browser: Hindi-dub catalogue, movies only; one master with Hindi+English audio (`indbd.pages.dev/api/info`). ~6s. |

Checked and left out:
- watch.spencerdevs.xyz plays in a browser, but its CDN returns 403 to any
  non-browser client, so the host could never fetch or relay the stream.
- stellar.gdn / rivestream.app are behind a Turnstile challenge; popcornmovies.ac
  and beta.way2movies.live sit behind a Cloudflare interstitial; reelix.ac's
  player (vidcore.io) returns a Cloudflare 403.
- meowtv.ru returns its streams encrypted; the key comes from a WASM module
  that first checks for headless/webdriver browsers and otherwise hands back
  decoy URLs. That is bot detection, so it is not worked around.
- viv.st is behind a Turnstile challenge.
- moovie.fun (zxcstream) only serves DASH (moviebox), which the host's link
  kinds (`file`, `hls`) can't carry; the same goes for Cinezo's `zendaya`
  source, which is why only `berlin` is used there.
- 67movies.st (vidlove) only polls an obfuscated API and never produced a
  stream. movienig.ht and streamo.pro produced none (movienig.ht's API
  wants a login).

## Scraper contract

The types come from the upstream `stremio-tv-plugin-web-links` repo, vendored
as the `vendor/web-links` git submodule and imported type-only, so nothing
from it ships in `dist/`. Clone with `--recurse-submodules` (or
`git submodule update --init`). `npm run sync-contract` pulls upstream's
latest; CI typechecks against upstream `main` on every run, and Dependabot
opens PRs to bump the pin.

## Usage

```bash
npm install   # also downloads a Playwright Chromium build
npm run search -- "unabomber"
npm run resolve -- movie 1492640
npm run resolve -- tv 1413 1 1
npm run resolve -- movie 1492640 --all   # don't stop at the first playable server
npm run playback-test -- "Inception"           # end-to-end: search -> real playback, timed
```

`search` takes a free-text query and returns TMDB ids + media type for each
match. `resolve` takes a TMDB id (and season/episode for TV) and **probes
cinejoy's servers one at a time, in the order cinejoy itself lists them, until
one actually plays** -- each candidate media URL is fetched for real before
being accepted, so a dead mirror gets skipped rather than returned. It stops
at the first server that comes back playable:

```json
{
  "tmdbId": 1492640,
  "mediaType": "movie",
  "servers": [
    {
      "server": "Nebula",
      "masterUrl": "https://.../playlist/xxx.m3u8",
      "qualities": [
        { "resolution": "1920x1080", "bandwidth": 4500000, "url": "https://.../1080p.m3u8" },
        { "resolution": "1280x720", "bandwidth": 2500000, "url": "https://.../720p.m3u8" }
      ]
    }
  ],
  "failedServers": ["Lisbon"]
}
```

`failedServers` lists whatever was ruled out on the way to that hit (dead
mirror, timed out, or never produced a URL at all) -- normal, not a bug, see
below. Pass `--all` (or `probeAll: true` to `resolveStreams()`) to keep going
through every server instead of stopping at the first success, if you want
every currently-working mirror rather than just one.

## Why browser automation (the legacy CLI)

This section is about the standalone CLI below (`src/cinejoy.ts`). The
`cinejoy` scraper itself no longer uses a browser: since 1.18.0 it runs
`crush.wasm` in Node and talks to `api.wing.st/g` directly (STRATEGIES.md).

cinejoy's search box is just a client-side call to TMDB's public API
(`src/tmdb.ts` reproduces it directly, same embedded key their own frontend
ships). Resolving an actual stream is a different story: cinejoy's backend
(`api.wing.st`) returns the source data as ~176 bytes of encrypted binary
from a `POST /g` call, decrypted client-side by a compiled WASM module
(`crush.wasm`) before the player ever gets a URL. When the CLI was written
that looked impractical to reimplement; it turned out the module can be run
as a black box instead (see the scraper).

Instead, `src/cinejoy.ts` drives a real headless Chromium via Playwright:
it opens the watch page, selects each server in turn, and watches the
browser's own network traffic for the media URL the player ends up
requesting. Once a `.m3u8` master playlist URL is captured, `src/hls.ts`
fetches and parses it server-side (a plain Node fetch has no CORS
restriction, unlike the browser's own `fetch`/`hls.js`, which is why the
mirrors work for the player but not for a naive script) to expand it into
one direct link per quality.

## Expect some servers to fail

cinejoy proxies to a rotating set of third-party mirror domains
(`ok.solarpanelcleaning.cc`-style throwaway hosts). In testing, more than one
of the four listed servers (Lisbon/Nebula/Solara/Athens) regularly never
produced a working stream at all -- the player just spins indefinitely until
you pick a different one. One capture during development returned a real
master-playlist URL that turned out to be already Cloudflare-blocked
("Website Access Blocked ... Terms of Service violations", HTTP 403) by the
time it was fetched -- the mirror had died between when the site last
refreshed its pointer and when this ran -- which is exactly why `resolve`
verifies each candidate by fetching it for real instead of trusting the URL
the player picked. If `servers` comes back empty and `failedServers` lists
all of them, every mirror was down at the time; retry later, it's mirror
availability on their end, not this tool.

## Playback timing

`testPlayback()` (`src/playback.ts`) is the end-to-end path: it calls
`search()`, opens the top match's watch page, probes servers exactly like
`resolveStreams()`, and additionally polls the page's own `<video>` element
until it's actually advancing (`currentTime > 0` and `readyState >= 3`) --
a manifest fetching successfully doesn't guarantee the browser can actually
decode and play it, so this is a stronger check than `resolveStreams()`
alone. `waitMs` is measured from the `search()` call to that first real
frame, which is the number that matters for "how long until playback
starts" -- it includes the TMDB search round-trip, every failed server tried
along the way, and the real HLS startup buffering, not just manifest
resolution.

Measured against 5 mainstream titles (default 20-25s per-server timeout, one
run, single data point each -- see caveat below):

| Title | Result | Server | Wait to first frame |
|---|---|---|---|
| Inception | played | Nebula | 3.7s |
| The Dark Knight | played | Nebula | 3.2s |
| Interstellar | **no playable server** | -- | -- (all servers exhausted, ~33s) |
| Avengers: Endgame | played | Nebula | 24.7s (first server it tried was slow/dead before Nebula came through) |
| The Matrix | played | Nebula | 4.8s |

4 of 5 played. Nebula was the server that ended up working every time in
this run, but that's not something to hardcode -- rerunning Inception a few
minutes later hit a dead server first and only worked on retry. **Treat any
single run's numbers as a sample from a flaky population,
not a stable benchmark** -- the honest summary is "usually a few seconds
once you land on a working mirror, occasionally 20-30s while several dead
ones are tried and timed out first, and occasionally nothing at all."

## Notes

- `perServerTimeoutMs` (default 25s) on `resolveStreams()`/`testPlayback()`
  controls how long it waits per server before giving up and moving to the
  next one.
- Pass `headed: true` to watch the browser while debugging.
- TMDB ids, not IMDB ids -- `search()` gives you the right id to pass into
  `resolve`.
