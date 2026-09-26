# Working on stremio-tv-plugin-web-scraper

## dist/ is built by CI, never locally

stremio-tv-plugin-web-links reads the compiled dist/ (e.g. `dist/cinejoy.mjs`) from this repo's main branch. There is no build step on the consuming side, so `dist/` has to be committed -- but **only by CI**.

- **Do not run `npm run build` to produce a commit, and do not hand-edit or commit `dist/`.** Commit source only.
- `.github/workflows/ci.yml` typechecks, builds, and on a push to `main` commits any change in `dist/` back as `github-actions[bot]` with `[skip ci]` (`contents: write`). Pull requests only prove the build works.
- So after pushing, `git pull` before your next commit; the bot's commit will be ahead of you.
- `npm run build` locally is fine for trying something out; leave the resulting `dist/` changes uncommitted (`git checkout dist`).
- A change is not live for stremio-tv until that bot commit exists **and** someone presses "Check for updates" on stremio-tv's plugins page. Nothing pulls on its own. Bump the version in `plugin.json` -- the importer only installs a real increase.

## One package, several scrapers

`dist/` is one package (`scraper.json`, one version), but its entry may export several scrapers -- web-links registers each under its own `id`. The bundle entry is `src/index.mts`, whose default export is an array; **to add a scraper, write it as a `WebLinkScraper` in its own module and append it to that array.** `scripts/build.mjs` bundles `src/index.mts` into `dist/cinejoy.cjs`; the manifest `id` (`cinejoy`) names the install directory and stays fixed so existing installs are replaced in place. Scraper ids must be unique across everything the host has loaded (first one wins, the duplicate is skipped and logged). Needs web-links >= 0.6.0; an older host reads the default export as a single scraper and would reject the array, loading nothing.
