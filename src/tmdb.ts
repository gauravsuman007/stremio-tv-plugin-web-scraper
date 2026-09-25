import type { MediaType, SearchResult } from "./types.js";

/**
 * cinejoy.pk's own frontend calls TMDB's public search API directly from the
 * browser with this key embedded in its client bundle -- there is no
 * cinejoy-specific search endpoint. Reusing it here reproduces exactly what
 * cinejoy's own search box does, nothing more.
 */
const TMDB_API_KEY = "8476a7ab80ad76f0936744df0430e67c";
const TMDB_BASE = "https://api.themoviedb.org/3";

interface TmdbMultiResult {
    id: number;
    media_type: string;
    title?: string;
    name?: string;
    release_date?: string;
    first_air_date?: string;
    poster_path?: string | null;
}

interface TmdbMultiResponse {
    results: TmdbMultiResult[];
}

export async function search(query: string): Promise<SearchResult[]> {
    const url = new URL(`${TMDB_BASE}/search/multi`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("language", "en-US");
    url.searchParams.set("query", query);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("page", "1");

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`TMDB search failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as TmdbMultiResponse;

    const results: SearchResult[] = [];
    for (const r of data.results) {
        if (r.media_type !== "movie" && r.media_type !== "tv") continue;
        const mediaType: MediaType = r.media_type;
        const title = mediaType === "movie" ? r.title : r.name;
        if (!title) continue;
        const dateStr = mediaType === "movie" ? r.release_date : r.first_air_date;
        const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) : null;
        results.push({
            tmdbId: r.id,
            mediaType,
            title,
            year: Number.isFinite(year) ? year : null,
            posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
        });
    }
    return results;
}
