import { search } from "./src/tmdb.js";
import { resolveStreams } from "./src/cinejoy.js";
import { testPlayback } from "./src/playback.js";
import type { MediaType } from "./src/types.js";

async function main() {
    const [command, ...args] = process.argv.slice(2);

    if (command === "search") {
        const query = args.join(" ");
        if (!query) {
            console.error("Usage: npm run search -- <title>");
            process.exit(1);
        }
        const results = await search(query);
        console.log(JSON.stringify(results, null, 2));
        return;
    }

    if (command === "resolve") {
        // npm run resolve -- movie 1492640
        // npm run resolve -- tv 1413 1 1
        // npm run resolve -- movie 1492640 --all   (probe every server, don't stop at the first hit)
        const probeAll = args.includes("--all");
        const [mediaType, tmdbIdStr, seasonStr, episodeStr] = args.filter((a) => a !== "--all");
        if (
            (mediaType !== "movie" && mediaType !== "tv") ||
            !tmdbIdStr ||
            (mediaType === "tv" && (!seasonStr || !episodeStr))
        ) {
            console.error(
                "Usage:\n  npm run resolve -- movie <tmdbId> [--all]\n  npm run resolve -- tv <tmdbId> <season> <episode> [--all]",
            );
            process.exit(1);
        }
        const result = await resolveStreams({
            mediaType: mediaType as MediaType,
            tmdbId: Number.parseInt(tmdbIdStr, 10),
            season: seasonStr ? Number.parseInt(seasonStr, 10) : undefined,
            episode: episodeStr ? Number.parseInt(episodeStr, 10) : undefined,
            probeAll,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (command === "playback-test") {
        // npm run playback-test -- "<title>"
        const [title] = args;
        if (!title) {
            console.error('Usage: npm run playback-test -- "<title>"');
            process.exit(1);
        }
        const result = await testPlayback({ title });
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.error(
        "Usage:\n  npm run search -- <title>\n  npm run resolve -- movie <tmdbId> [--all]\n  npm run resolve -- tv <tmdbId> <season> <episode> [--all]\n  npm run playback-test -- \"<title>\"",
    );
    process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
