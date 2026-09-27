# Working on stremio-tv-plugin-web-scraper

## dist/ is built by CI, never locally

stremio-tv-plugin-web-links reads the compiled dist/ (e.g. `dist/streaming-sites.cjs`) from this repo's main branch. There is no build step on the consuming side, so `dist/` has to be committed -- but **only by CI**.

- **Do not run `npm run build` to produce a commit, and do not hand-edit or commit `dist/`.** Commit source only.
- `.github/workflows/ci.yml` typechecks, builds, and on a push to `main` commits any change in `dist/` back as `github-actions[bot]` with `[skip ci]` (`contents: write`). Pull requests only prove the build works.
- So after pushing, `git pull` before your next commit; the bot's commit will be ahead of you.
- `npm run build` locally is fine for trying something out; leave the resulting `dist/` changes uncommitted (`git checkout dist`).
- A change is not live for stremio-tv until that bot commit exists **and** someone presses "Check for updates" on stremio-tv's plugins page. Nothing pulls on its own. Bump the version in `plugin.json` -- the importer only installs a real increase.

## One package, several scrapers

`dist/` is one package (`scraper.json`, one version), but its entry may export several scrapers -- web-links registers each under its own `id`. The bundle entry is `src/index.mts`, whose default export is an array; **to add a scraper, write it as a `WebLinkScraper` in its own module and append it to that array.** `scripts/build.mjs` bundles `src/index.mts` into `dist/streaming-sites.cjs`; the manifest `id` (`streaming-sites`) names the install directory and stays fixed so existing installs are replaced in place. (It was `cinejoy` until 1.11.0, when the package held six scrapers; the host can't update across an id change, so that install has to be removed and this one imported afresh.) Scraper ids must be unique across everything the host has loaded (first one wins, the duplicate is skipped and logged). Needs web-links >= 0.6.0; an older host reads the default export as a single scraper and would reject the array, loading nothing. Vixsrc needs >= 0.8.3 (separate audio playlist) and Vidrock, Atlantic and Rivestream >= 0.9.0 (`WebLink.headers`); on an older host those four produce silent video / 403s while the rest keep working.

**Never type a version into a scraper.** The version shown on the plugins page comes from `package.json`: `scripts/build.mjs` writes it to `dist/scraper.json` and injects it into `src/index.mts` (`__PACKAGE_VERSION__`), which stamps every scraper it exports. A `version:` literal in a scraper module is overwritten, and used to be what the page showed -- so a bump never appeared.

## Always bump the version

Every change to a scraper's behaviour (or the shared code under `src/`) needs a `package.json` version bump in the same commit -- patch for fixes, minor for new scrapers or renames. All scrapers share that one version (`src/index.mts` stamps it), and stremio-tv's importer only installs a real increase, so an unbumped change never reaches anyone.

## Keep SOURCES.md current

[SOURCES.md](SOURCES.md) tracks every site considered (implemented / candidate / possible / untriaged / rejected) and the upstream players behind them. Before hunting for new sites, read it -- don't retry a rejected one. Update it in the same commit whenever a source changes status, and record the reason for a rejection. [STRATEGIES.md](STRATEGIES.md) holds the worked-out request recipes (endpoints, keys, required headers, what was verified) for every candidate: **build from it, don't redo the research**, and add a recipe there whenever you solve a new source.

## Check a source against the host before building it

A source that plays in ffmpeg can still be unplayable through stremio-tv. The web-links relay (in the `stremio-tv-plugin-web-links` repo, `src/plugin.mts`; `vendor/web-links` is a pinned copy) sends the link's `Referer` plus any `WebLink.headers` (only `Origin`, `Accept`, `Accept-Language`, `User-Agent`, `X-*` -- no `Cookie` yet, see the FlareSolverr section below for what a Cloudflare-gated source needs), and relays `#EXT-X-MEDIA` playlists as playlists. So before writing a scraper, confirm with the headers you would declare that the master, a leaf and a segment all fetch, and that the video rendition has its own audio or the audio group is a proper `#EXT-X-MEDIA` playlist. Best: drive the real relay routes from a local HTTP server and let ffmpeg play them (see STRATEGIES.md). A source that needs something the relay can't send is recorded as `blocked` in SOURCES.md with the host change it needs. That repo is yours to change (the pin in `vendor/web-links` follows it: `git -C vendor/web-links fetch && git -C vendor/web-links checkout origin/main`, commit the pointer).

## Handling the streams these scrapers return

Read this if you are the app playing a returned `WebLink` (stremio-tv's web-links host, or anything else). Measured against real playback (ffmpeg decoding 8s of each link), not assumed.

**What every link is.** `resolveKind` is always `"hls"`. A link is either a master playlist with several renditions (returned whole so the viewer can pick; `quality` lists them, e.g. `1920x1080/1280x720 · ShuttleTV`) or, when only one rendition exists, that single media playlist (`quality` is `1080p · Movy` or just the site name when nothing states a resolution). Nothing is a bare file.

**Send the link's `referrer` as `Referer` on every request** -- the playlist, variant playlists and segments. Without it the CDNs answer 403 (Cinezo's proxy returns a Cloudflare page). Some links also declare `headers` (Vidrock: `Origin`) -- send those too, on every request; those CDNs 403 a Referer alone. Use a browser-like `User-Agent`. Don't reuse a link's referrer or headers for another site.

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

**Excluded on purpose.** Sites whose CDN rejects non-browser TLS clients (watch.spencerdevs.xyz) or encrypt streams behind bot detection (meowtv.ru) are not scraped; DASH-only sources (moviebox/zxcstream, Cinezo's `zendaya`) can't be carried by `resolveKind`. A Turnstile/Cloudflare challenge on its own is no longer an automatic reject -- see "Getting past Cloudflare/Turnstile with FlareSolverr" below.

## Getting past Cloudflare/Turnstile with FlareSolverr

[FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) runs a real (patched) browser behind a small HTTP API and solves the challenge for you, handing back the cleared cookies (`cf_clearance` etc.), the User-Agent it solved with, and (on a `request.get`) the page body. Use it as a scraping-time tool, not a scraper dependency shipped to the host:

- Run it once (`docker run -p 8191:8191 ghcr.io/flaresolverr/flaresolverr`) and hit `POST http://localhost:8191/v1` with `{"cmd":"request.get","url":"...","maxTimeout":60000}` (or `request.get` against the specific API endpoint if the challenge sits on the API host, not just the HTML page). Response includes `solution.cookies`, `solution.userAgent`, `solution.response`.
- Use the returned cookies + User-Agent for your own research fetches (finding the stream endpoint, checking whether the master/leaf/segments are reachable) exactly as you would a captured browser session. Record the working recipe in STRATEGIES.md as usual.
- **The relay must send the cookie back, or the returned `WebLink` is useless.** The relay allowlist (`Referer` plus `WebLink.headers`: `Origin`, `Accept`, `Accept-Language`, `User-Agent`, `X-*`) has no `Cookie` today. A site that needs `cf_clearance` (or any other cookie) to reach its playlist/segments requires adding `Cookie` to that allowlist in `stremio-tv-plugin-web-links` (`src/plugin.mts`, and the `vendor/web-links` pin here) *and* bumping its minimum version, the same way Vidrock/Atlantic/Rivestream required `WebLink.headers` at >= 0.9.0. Until that host change ships, a Cloudflare-gated source whose stream itself needs the cookie is `blocked` in SOURCES.md, not `implemented`.
- `cf_clearance` is short-lived and tied to the solving IP/UA pair -- it does not survive being resolved on a laptop and played from the server's datacentre IP (see "The same site can serve a different player depending on the caller's IP" below). If the site needs FlareSolverr for every playback, not just to find the API recipe, resolving would mean running FlareSolverr server-side per request, which is slow (real browser + challenge solve, seconds to tens of seconds) -- weigh that against `fetchMethod: "slow"` already covering Chromium-driven sites.
- Still don't bypass Turnstile/Cloudflare to reach a site whose *content itself* is gated for reasons beyond bot detection (paywalls, sign-in-walled catalogues) -- FlareSolverr is for the challenge page, not for getting around access controls the site owner put up for other reasons.
- `src/flaresolverr.mts` gives you both paths behind one call (`solve`): `solveInProcess` drives this repo's own Playwright/Chromium (no real container needed, but it's an unpatched browser -- see its doc comment on what that does and doesn't get past), `solveViaContainer` talks to a real FlareSolverr's `/v1` API when `FLARESOLVERR_URL` is set. If solving here starts silently failing, check FlareSolverr's GitHub for how their detection changed.
- **In-process is not a substitute for real FlareSolverr against a hardened challenge.** Measured 2026-09-27 against the 19 `retriage: FlareSolverr` rows: a simple/legacy JS challenge or a site that only *looks* Cloudflare-branded clears in ~1-2s with `solveInProcess` (RidoMovies, Bingr, NOVA, Stellar, vidsrc.to -- none of these actually held a live challenge open long enough to test the solver's polling loop). A real Cloudflare **managed challenge or Turnstile** does not clear with plain `playwright-core` Chromium no matter the timeout (CinemaCity, HollyMovieHD, M4uHD, NEPU, OnionPlay, DuaFile, FilmCave, Cinetaro, Flixtrz, PopcornMovies, Spacedom, Vivarium, Way2Movies all timed out at 30s) -- Cloudflare's managed challenge fingerprints headless Chromium (CDP, navigator.webdriver, etc.) and real FlareSolverr only gets through it with a patched browser build, which is out of scope here (no new browser downloads). FlyStream runs an unrelated proof-of-work gate ("Anubis", not Cloudflare) that our marker set doesn't recognize and which can look transiently cleared before it actually finishes -- treat any "cleared" result from a non-Cloudflare gate with suspicion until you've confirmed the real page loaded.

## Reverse-engineering WASM-gated sources instead of accepting BrowserSite

A source that needs a WebAssembly module to run (minting an id, deriving a key, decrypting a payload) is not automatically stuck as a `BrowserSite`. Chromium-driven capture works but costs 3-45s per resolve and a running browser server-side; the same WASM module usually runs standalone in plain Node, which turns the source into an `HttpSite` (1-4s, no browser). Before settling for `BrowserSite` on a WASM-gated source, spend real effort trying to run the module out-of-browser:

- **Load the `.wasm` directly in Node** with `WebAssembly.instantiate` and the site's own JS glue (its `wasm_exec.js`-style shim, if it's Go; a Rust/AssemblyScript module usually has a thinner loader). Stub whatever globals the shim expects (`window`, `document`, timers, `crypto.subtle`, `TextEncoder`) rather than assuming it needs a real DOM -- most of these modules only touch two or three browser APIs and the rest is dead weight from the shim's generic template.
- **Read the module's exports and calling convention with a WASM disassembler** (`wasm2wat`, `wabt`, or Chrome DevTools' own WASM debugger) when the glue JS doesn't make the entry point obvious. Compare against the JS-side wrapper function (`window.getAdv`-style) to see exactly which export it calls and with what argument encoding (pointer+length into linear memory is common).
- **Try calling the module cold with captured inputs/outputs** from a real browser session (devtools breakpoint on the wrapper, or `console.log` patched into the page bundle) before reverse-engineering the internals -- confirm you can reproduce a known output for a known input running the same module in Node, then treat the internal logic as a black box you invoke rather than something you need to fully understand.
- **Isolate missing dependencies one at a time.** If the module or its glue calls into `libsodium`/`crypto.subtle`/a specific hash function, install the equivalent Node package (`libsodium-wrappers`, Node's built-in `crypto`) rather than trying to polyfill browser globals generically.
- **When it truly can't run standalone** (it fingerprints its environment, needs a real event loop tied to page lifecycle, or the output is checked against something only the live page can supply), fall back to `BrowserSite` and record in STRATEGIES.md exactly what was tried and why it didn't work, so the next attempt doesn't repeat it.

Record whichever recipe works (or the dead end) in STRATEGIES.md's per-source section, and update SOURCES.md's status. A source that used to be `possible`/`blocked` because it "needs a browser for WASM" is worth periodically retrying if a JS bundle changes or a new technique becomes available -- note the last attempt date so retriage knows when it's stale.

## The same site can serve a different player depending on the caller's IP

A scraper that resolves on a laptop and returns `null` on the server is not necessarily broken: sites such as 7movies pick a provider by address. From the server's datacentre IP its player streams a pre-warmed `relay.vidrift.net/proxy?url=...&exp=...` playlist and never requests a `.m3u8` at all, so a network-listening capture sees nothing. Always test a resolve **inside the server container** (`docker exec -w <package dir> stremio-tv node ...` with `CHROMIUM_PATH` set) before calling it fixed, and prefer a site's JSON API (`api/boot/...` `warmStreams`) over waiting for the browser. Playlist matchers also have to allow `.m3u8` followed by `&` (a relay's next parameter), and extension-less proxies (Flixer's `serve.dragonballzfans.xyz/proxy?data=`, bCine's CDN `index.m3u8`) need a per-site `isPlaylist`. Sites change these without notice; the symptom is always a bare `null`.

## Every scraper carries maxQuality and fetchMethod

`createScraper` (src/shared.mts) sets `WebLinkScraper.maxQuality` from the site's own `maxQuality` field, and `fetchMethod` from which `SiteAdapter` shape it is: a `BrowserSite` (has `captures`) is `"slow"`, an `HttpSite` (has `httpCaptures`) is `"fast"`. Both are set automatically -- a site module never sets them itself. Needs web-links >= 0.10.0 to show on the settings page; an older host just ignores the fields.
