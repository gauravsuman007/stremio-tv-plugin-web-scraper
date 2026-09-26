/**
 * The package entry stremio-tv-plugin-web-links loads. It may export several
 * scrapers; list each one here and the host registers them all, every one
 * under its own `id`. `scripts/build.mjs` bundles this file, not a scraper
 * directly.
 */
import type { WebLinkScraper } from "../vendor/web-links/src/scraper.mts";
import cinejoyScraper from "./scraper.mts";

/** Replaced at build time (esbuild `--define`) with package.json's version,
 *  the one place it is written -- a version typed into a scraper's own source
 *  drifts from the manifest and the plugins page then shows a stale one. */
declare const __PACKAGE_VERSION__: string;

const scrapers: WebLinkScraper[] = [cinejoyScraper].map((scraper) => ({ ...scraper, version: __PACKAGE_VERSION__ }));

export default scrapers;
