# stremio-tv-plugin-web-scraper

Searches [cinejoy.pk](https://cinejoy.pk) for a title and returns direct,
per-quality video links, ready to be handed to a player.

Standalone tool for now -- not wired into the private `stremio-tv` host's
plugin loader. See "Why browser automation" below for why it can't be a
plain HTTP scraper.

## Usage

```bash
npm install   # also downloads a Playwright Chromium build
npm run search -- "unabomber"
npm run resolve -- movie 1492640
npm run resolve -- tv 1413 1 1
npm run resolve -- movie 1492640 --all   # don't stop at the first playable server
npm run playback-test -- "Inception"           # end-to-end: search -> real playback, timed
npm run playback-test -- "Inception" 300       # ...then seek to 300s and verify it stuck
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

## Playback timing and resume seeking

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
this run, but that's not something to hardcode -- rerunning Inception minutes
later during resume testing hit a dead server first and only worked on
retry. **Treat any single run's numbers as a sample from a flaky population,
not a stable benchmark** -- the honest summary is "usually a few seconds
once you land on a working mirror, occasionally 20-30s while several dead
ones are tried and timed out first, and occasionally nothing at all."

If `resumeSeconds` is passed, once real playback is confirmed it sets
`video.currentTime` on the page directly and reads it back after a couple of
seconds to confirm the seek actually stuck (`resume.verified`). Verified on:

| Title | Requested | Actual after seek | Verified |
|---|---|---|---|
| Inception | 300s | 300.6s | yes |
| The Matrix | 600s | 601.7s | yes |

Both landed within ~1-2s of the request (HLS seeks snap to a segment
boundary, so exact-second precision isn't expected). This is seeking the
actual `<video>` element already loaded in cinejoy's own player page, not
something baked into the returned URL -- there's no URL parameter that
encodes a start offset for these streams. A caller that only wants the
resolved links (via `resolveStreams()`, no browser session kept open) and
plays them in its own player should instead set `currentTime` the same way
once its own player has loaded the stream.

## Notes

- `perServerTimeoutMs` (default 25s) on `resolveStreams()`/`testPlayback()`
  controls how long it waits per server before giving up and moving to the
  next one.
- Pass `headed: true` to watch the browser while debugging.
- TMDB ids, not IMDB ids -- `search()` gives you the right id to pass into
  `resolve`.
