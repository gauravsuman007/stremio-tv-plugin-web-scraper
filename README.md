# stremio-tv-plugin-web-scraper

Web-link scrapers for several streaming sites (CineJoy, Flixer, bCine, Movy,
ShuttleTV, 7Movies, Cinezo): each searches its site for a title and returns
the best direct, per-quality video link, ready to be handed to a player.
They ship as one package, `streaming-sites`, for `stremio-tv-plugin-web-links`.

Most sites need a real browser (see "Why browser automation" below); Cinezo
has an open JSON API and is plain HTTP.

## Sites

`dist/` is one package (`streaming-sites`) that exports seven scrapers, each registered by the
host under its own id. Six sites work the same way (open a player URL keyed
by TMDB id in a real browser, read the media URL the player requests); the
seventh, Cinezo, asks its player's JSON API directly (an `HttpSite` instead of
a `BrowserSite`, no Chromium involved). All share `src/shared.mts` (TMDB lookup, capture, playlist verification,
best-stream picking) and each site is one small module in `src/sites/`.
Every scraper's `search()` returns one row; `resolve()` tries all of that
site's servers and returns the best resolution (stopping early on 2160p, or
after 10s once something plays). To add a site, write a `SiteAdapter`, wrap it
with `createScraper`, and append it to the array in `src/index.mts`.

The scraper's name on the plugins page carries its max quality ("Movy · up to
1080p"); it is the `maxQuality` on each adapter, set from testing across ten
titles (older and recent movies, three TV episodes) and worth re-checking now
and then.

| Scraper | Player | Max quality seen | Notes |
|---|---|---|---|
| CineJoy | cinejoy.pk | 4K | Clicks through its server list; 4K on some titles (Oppenheimer, Superman 2025, GoT), 1080p on others. |
| Flixer | flixer.gd | 1080p | Autoplays; WASM-derived stream. Often a single playlist with no stated resolution, 720p on TV. Some catalog gaps. Injects popunders. |
| bCine | player.bciney.to | 1080p | 1080/720/360 masters; widescreen titles report e.g. 1920x800. |
| Movy | movy.sx | 1080p | Needs Play clicks; popunder ads hijack the first ones. Playlist named for its resolution. |
| ShuttleTV | cinesrc.st (shuttletv.su's player) | 4K | 4K only on Superman 2025; otherwise 1080p. Proof-of-work WASM. |
| 7Movies | embed.vidrift.net (7movies.ac's player) | 1080p | Slow or missing for some titles (Interstellar, Breaking Bad returned nothing). |
| Cinezo | player.cinezo.live (arrowtv.net's player) | 1080p | No browser: `proxy1.flikhub.net` answers plain HTTP given the player's Referer/Origin. Only its `berlin` source (HLS) is used; 1-4s. Missing for some titles (The Godfather, Superman 2025 returned an upstream 502). |

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

## Why browser automation

cinejoy's search box is just a client-side call to TMDB's public API
(`src/tmdb.ts` reproduces it directly, same embedded key their own frontend
ships). Resolving an actual stream is a different story: cinejoy's backend
(`api.wing.st`) returns the source data as ~176 bytes of encrypted binary
from a `POST /g` call, decrypted client-side by a compiled WASM module
(`crush.wasm`) before the player ever gets a URL. That pipeline is not
practical to reimplement with plain HTTP requests -- it would mean reverse
engineering a compiled cipher that can change without notice.

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
