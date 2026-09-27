// Builds `dist/`: every scraper bundled into one file. Since 1.20.0 nothing
// shipped drives a browser, so playwright-core is no longer copied alongside
// (it stays a dev dependency for research, see src/browser.mts). The build
// fails if the bundle ever imports it again.
//
// `scraper.json` is this scraper's own tiny manifest -- `{ id, entry,
// version }` -- read by stremio-tv-plugin-web-links's GitHub importer the
// same way stremio-tv's own plugin importer reads a plugin's `plugin.json`:
// it's what makes "sync this whole dist/ tree, then load <entry>" possible
// for a scraper that needs more than one file.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync("package.json", "utf8")));

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

execSync(
    "npx esbuild src/index.mts --bundle --platform=node --format=cjs --outfile=dist/streaming-sites.cjs " +
        `--define:__PACKAGE_VERSION__='"${pkg.version}"'`,
    { stdio: "inherit" }
);

if (/playwright/.test(readFileSync("dist/streaming-sites.cjs", "utf8"))) throw new Error("the bundle pulls in playwright: a shipped scraper imports ./browser.mts");

writeFileSync(
    "dist/scraper.json",
    JSON.stringify({ id: "streaming-sites", entry: "streaming-sites.cjs", version: pkg.version }, null, 4) + "\n"
);

console.log("built dist/ (streaming-sites.cjs + scraper.json)");
