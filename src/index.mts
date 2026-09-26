/**
 * The package entry stremio-tv-plugin-web-links loads. It may export several
 * scrapers; list each one here and the host registers them all, every one
 * under its own `id`. `scripts/build.mjs` bundles this file, not a scraper
 * directly.
 */
import type { WebLinkScraper } from "../vendor/web-links/src/scraper.mts";
import sevenMoviesScraper from "./sites/7movies.mts";
import bcineyScraper from "./sites/bciney.mts";
import cinejoyScraper from "./sites/cinejoy.mts";
import flixerScraper from "./sites/flixer.mts";
import movyScraper from "./sites/movy.mts";
import shuttletvScraper from "./sites/shuttletv.mts";

/** Replaced at build time (esbuild `--define`) with package.json's version,
 *  the one place it is written -- a version typed into a scraper's own source
 *  drifts from the manifest and the plugins page then shows a stale one. */
declare const __PACKAGE_VERSION__: string;

const scrapers: WebLinkScraper[] = [cinejoyScraper, flixerScraper, bcineyScraper, movyScraper, shuttletvScraper, sevenMoviesScraper].map((scraper) => ({ ...scraper, version: __PACKAGE_VERSION__ }));

export default scrapers;
