// Builds `dist/`: this scraper's own code, transpiled but NOT bundled with
// `playwright-core` (see `src/scraper.mts`'s module doc for why bundling it
// broke -- its own registry code resolves a few files, like `browsers.json`,
// relative to itself at import time, which stops working once that code is
// relocated inside a bundle). Instead `playwright-core` -- a genuinely
// dependency-free package, 13MB, nothing else to pull in -- ships as a real
// `node_modules/playwright-core` directory alongside the compiled code, so
// its own `require()`s keep resolving exactly as they do today.
//
// `scraper.json` is this scraper's own tiny manifest -- `{ id, entry,
// version }` -- read by stremio-tv-plugin-web-links's GitHub importer the
// same way stremio-tv's own plugin importer reads a plugin's `plugin.json`:
// it's what makes "sync this whole dist/ tree, then load <entry>" possible
// for a scraper that needs more than one file.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync("package.json", "utf8")));

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

execSync(
    "npx esbuild src/index.mts --bundle --platform=node --format=cjs --outfile=dist/cinejoy.cjs " +
        "--external:playwright-core --external:chromium-bidi --external:bufferutil --external:utf-8-validate",
    { stdio: "inherit" }
);

mkdirSync("dist/node_modules", { recursive: true });
cpSync("node_modules/playwright-core", "dist/node_modules/playwright-core", { recursive: true });

writeFileSync(
    "dist/scraper.json",
    JSON.stringify({ id: "cinejoy", entry: "cinejoy.cjs", version: pkg.version }, null, 4) + "\n"
);

console.log("built dist/ (cinejoy.cjs + node_modules/playwright-core + scraper.json)");
