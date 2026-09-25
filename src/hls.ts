import type { QualityVariant } from "./types.js";

/**
 * Fetches an HLS master playlist and expands it into one direct URL per
 * quality variant it advertises. Done as a plain server-side fetch, not
 * inside the browser -- the browser player hits these mirror domains
 * without CORS headers (they're only ever meant to be read by <video>/hls.js,
 * not fetch()'d cross-origin), but a Node-side request has no such
 * restriction since it isn't subject to the browser's same-origin policy.
 */
export async function expandMasterPlaylist(masterUrl: string): Promise<QualityVariant[]> {
    const res = await fetch(masterUrl, {
        headers: { Referer: "https://cinejoy.pk/" },
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch master playlist: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();

    if (!text.includes("#EXT-X-STREAM-INF")) {
        // Not a master playlist (either already a media playlist, or a direct
        // file) -- treat the URL itself as the only quality.
        return [{ resolution: null, bandwidth: null, url: masterUrl }];
    }

    const lines = text.split(/\r?\n/);
    const variants: QualityVariant[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.startsWith("#EXT-X-STREAM-INF")) continue;
        const uriLine = lines[i + 1]?.trim();
        if (!uriLine || uriLine.startsWith("#")) continue;

        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);

        variants.push({
            resolution: resolutionMatch?.[1] ?? null,
            bandwidth: bandwidthMatch?.[1] ? Number.parseInt(bandwidthMatch[1], 10) : null,
            url: new URL(uriLine, masterUrl).toString(),
        });
    }

    if (variants.length === 0) {
        return [{ resolution: null, bandwidth: null, url: masterUrl }];
    }

    variants.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
    return variants;
}
