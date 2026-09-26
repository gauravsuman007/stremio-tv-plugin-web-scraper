/**
 * The package entry stremio-tv-plugin-web-links loads. It may export several
 * scrapers; list each one here and the host registers them all, every one
 * under its own `id`. `scripts/build.mjs` bundles this file, not a scraper
 * directly.
 */
import type { WebLinkScraper } from "../vendor/web-links/src/scraper.mts";
import cinejoyScraper from "./scraper.mts";

const scrapers: WebLinkScraper[] = [cinejoyScraper];

export default scrapers;
