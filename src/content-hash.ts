import { createHash } from "node:crypto";

/**
 * sha256 hex of the canonical JSON of a value. Stable: object keys sorted,
 * no whitespace. Used as the `content_hash` on a snapshot so the reader can
 * idempotently detect "same content" across publishes.
 */
export function computeContentHash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
        "{" +
        keys
            .map(
                (k) =>
                    JSON.stringify(k) +
                    ":" +
                    canonicalJson((value as Record<string, unknown>)[k]),
            )
            .join(",") +
        "}"
    );
}
