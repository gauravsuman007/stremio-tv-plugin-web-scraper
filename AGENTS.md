# Working on stremio-tv-plugin-web-scraper

## dist/ is built by CI, never locally

stremio-tv-plugin-web-links reads the compiled dist/ (e.g. `dist/streaming-sites.cjs`) from this repo's main branch. There is no build step on the consuming side, so `dist/` has to be committed -- but **only by CI**.

- **Do not run `npm run build` to produce a commit, and do not hand-edit or commit `dist/`.** Commit source only.
- `.github/workflows/ci.yml` typechecks, builds, and on a push to `main` commits any change in `dist/` back as `github-actions[bot]` with `[skip ci]` (`contents: write`). Pull requests only prove the build works.
- So after pushing, `git pull` before your next commit; the bot's commit will be ahead of you.
- `npm run build` locally is fine for trying something out; leave the resulting `dist/` changes uncommitted (`git checkout dist`).
- A change is not live for stremio-tv until that bot commit exists **and** someone presses "Check for updates" on stremio-tv's plugins page. Nothing pulls on its own. Bump the version in `plugin.json` -- the importer only installs a real increase.

## One package, several scrapers

`dist/` is one package (`scraper.json`, one version), but its entry may export several scrapers -- web-links registers each under its own `id`. The bundle entry is `src/index.mts`, whose default export is an array; **to add a scraper, write it as a `WebLinkScraper` in its own module and append it to that array.** `scripts/build.mjs` bundles `src/index.mts` into `dist/streaming-sites.cjs`; the manifest `id` (`streaming-sites`) names the install directory and stays fixed so existing installs are replaced in place. (It was `cinejoy` until 1.11.0, when the package held six scrapers; the host can't update across an id change, so that install has to be removed and this one imported afresh.) Scraper ids must be unique across everything the host has loaded (first one wins, the duplicate is skipped and logged). Needs web-links >= 0.6.0; an older host reads the default export as a single scraper and would reject the array, loading nothing.

**Never type a version into a scraper.** The version shown on the plugins page comes from `package.json`: `scripts/build.mjs` writes it to `dist/scraper.json` and injects it into `src/index.mts` (`__PACKAGE_VERSION__`), which stamps every scraper it exports. A `version:` literal in a scraper module is overwritten, and used to be what the page showed -- so a bump never appeared.

## Always bump the version

Every change to a scraper's behaviour (or the shared code under `src/`) needs a `package.json` version bump in the same commit -- patch for fixes, minor for new scrapers or renames. All scrapers share that one version (`src/index.mts` stamps it), and stremio-tv's importer only installs a real increase, so an unbumped change never reaches anyone.

## Handling the streams these scrapers return

Read this if you are the app playing a returned `WebLink` (stremio-tv's web-links host, or anything else). Measured against real playback (ffmpeg decoding 8s of each link), not assumed.

**What every link is.** `resolveKind` is always `"hls"`. A link is either a master playlist with several renditions (returned whole so the viewer can pick; `quality` lists them, e.g. `1920x1080/1280x720 · ShuttleTV`) or, when only one rendition exists, that single media playlist (`quality` is `1080p · Movy` or just the site name when nothing states a resolution). Nothing is a bare file.

**Send the link's `referrer` as `Referer` on every request** -- the playlist, variant playlists and segments. Without it the CDNs answer 403 (Cinezo's proxy returns a Cloudflare page). No other headers were needed; use a browser-like `User-Agent`. Don't reuse a link's referrer for another site.

**Resolve at play time, don't cache links.** Search rows are placeholders (`url: ""`, `resolveId` set); `resolve()` does the work (3-45s for browser-driven sites, 1-4s for Cinezo). Resolved URLs carry short-lived tokens (Cinezo's lapse after ~6h), so re-resolve rather than storing them.

**Don't trust file names or content types.** A conforming HLS client copes; a strict one (ffmpeg) needs `-f hls -allowed_extensions ALL -extension_picky 0`.
- Playlists often have no `.m3u8`: bCine's master is `v.bciney.to/v?url=...`, ShuttleTV's is `cinesrc.st/api/playlist/<token>`.
- Cinezo's master is served as `application/json`, and its segment URLs have no extension.
- ShuttleTV's segments are named `.jpg` (they are real video).
- Flixer's segments start with a PNG signature; treat a Flixer playlist as valid only if it plays.

**Renditions and codecs.**
- A master's first variant is not always the best; sort by `BANDWIDTH`/`RESOLUTION`. bCine and Cinezo list the 640-wide variant first.
- Widescreen titles report e.g. `1920x800` or `1920x872`, not 1080 high.
- Movy's playlist is single-rendition; its resolution only appears in the URL (`index-s1080p-...`).
- 7Movies serves HEVC (1080p): the player needs HEVC support. The others are H.264.
- Flixer and Movy hand back a single playlist without a stated resolution on some titles.

**Failure is normal, and empty.** `resolve()` returns `null` when no server on the site plays. Reasons seen: title missing on the site, upstream 5xx (Cinezo's proxy for some titles), a decoy stub. The scrapers reject any finished playlist under 5 minutes and any playlist that fails to fetch, so a returned link has passed a real fetch, but check again when playing. Try the other scrapers' rows instead of retrying.

**Excluded on purpose.** Sites whose CDN rejects non-browser TLS clients (watch.spencerdevs.xyz), sit behind Turnstile/Cloudflare challenges, or encrypt streams behind bot detection (meowtv.ru) are not scraped; DASH-only sources (moviebox/zxcstream, Cinezo's `zendaya`) can't be carried by `resolveKind`.
