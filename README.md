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
```

`search` takes a free-text query and returns TMDB ids + media type for each
match. `resolve` takes a TMDB id (and season/episode for TV) and returns,
per available server, the resolved master playlist plus every quality
variant it advertises:

```json
{
  "tmdbId": 1492640,
  "mediaType": "movie",
  "servers": [
    {
      "server": "Lisbon",
      "masterUrl": "https://.../playlist/xxx.m3u8",
      "qualities": [
        { "resolution": "1920x1080", "bandwidth": 4500000, "url": "https://.../1080p.m3u8" },
        { "resolution": "1280x720", "bandwidth": 2500000, "url": "https://.../720p.m3u8" }
      ]
    }
  ],
  "failedServers": ["Nebula", "Solara", "Athens"]
}
```

`failedServers` is normal, not a bug -- see below.

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
refreshed its pointer and when this ran. `resolve` reflects all of this
as-is: check `servers` for whichever ones actually came back with a fetchable
playlist, and don't treat `failedServers` (or a single-quality fallback
entry, meaning the playlist itself couldn't be fetched/parsed) as a bug to
fix here. If every server fails, retry later -- it's mirror availability on
their end, not this tool.

## Notes

- `perServerTimeoutMs` (default 25s) on `resolveStreams()` controls how long
  it waits per server before giving up and moving to the next one.
- Pass `headed: true` to `resolveStreams()` to watch the browser while
  debugging.
- TMDB ids, not IMDB ids -- `search()` gives you the right id to pass into
  `resolve`.
