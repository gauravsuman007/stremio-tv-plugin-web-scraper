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
    /**
     * Keep probing every remaining server even after one plays, and return
     * all playable ones. Default false: stop at the first server whose
     * stream actually fetches successfully.
     */
    probeAll?: boolean;
    /** show the browser window instead of running headless (debugging) */
    headed?: boolean;
}

export interface ResolveResult {
    tmdbId: number;
    mediaType: MediaType;
    servers: ServerResult[];
    /**
     * Servers that were tried and ruled out, in order: either the player
     * never produced a media URL for them within the timeout, or it did but
     * the resulting playlist/file wasn't actually fetchable (dead mirror).
     */
    failedServers: string[];
}

export interface ResumeVerification {
    requestedSeconds: number;
    /** currentTime actually read back from the <video> element after seeking */
    actualSeconds: number | null;
    /** whether actualSeconds landed within tolerance of requestedSeconds */
    verified: boolean;
}

export interface PlaybackTestOptions {
    title: string;
    /** restrict the search match to this media type; defaults to the first movie or tv hit */
    mediaType?: MediaType;
    season?: number;
    episode?: number;
    /** if set, seeks the page's <video> element to this offset (seconds) once playback starts, and verifies it stuck */
    resumeSeconds?: number;
    perServerTimeoutMs?: number;
    headed?: boolean;
}

export interface PlaybackTestResult {
    title: string;
    tmdbId: number | null;
    mediaType: MediaType | null;
    /** the server that actually produced real, playing video -- null if none did */
    server: string | null;
    /** wall-clock ms from the search() call to the first observed video frame */
    waitMs: number | null;
    resume: ResumeVerification | null;
    error?: string;
}
