export type MediaType = "movie" | "tv";

export interface SearchResult {
    tmdbId: number;
    mediaType: MediaType;
    title: string;
    year: number | null;
    posterUrl: string | null;
}

export interface QualityVariant {
    /** e.g. "1920x1080", or null when the playlist didn't advertise a resolution */
    resolution: string | null;
    /** bits per second, as advertised by the HLS master playlist */
    bandwidth: number | null;
    /** direct, playable URL for this specific quality */
    url: string;
}

export interface ServerResult {
    server: string;
    /** the master playlist URL as resolved from the page, before variant expansion */
    masterUrl: string;
    qualities: QualityVariant[];
}

export interface ResolveOptions {
    tmdbId: number;
    mediaType: MediaType;
    season?: number;
    episode?: number;
    /** how long to wait for each server to produce a media URL, in ms */
    perServerTimeoutMs?: number;
    /** show the browser window instead of running headless (debugging) */
    headed?: boolean;
}

export interface ResolveResult {
    tmdbId: number;
    mediaType: MediaType;
    servers: ServerResult[];
    /** servers that were tried but never produced a media URL within the timeout */
    failedServers: string[];
}
