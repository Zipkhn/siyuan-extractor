// Kept in sync with siyuan-plugin-publish/src/slug.ts. If the regex evolves,
// update both repos in the same change.

const SLUG_REGEX = /^[a-z0-9-]+$/;

export function isValidSlug(value: string): boolean {
    return (
        SLUG_REGEX.test(value) &&
        !value.startsWith("-") &&
        !value.endsWith("-") &&
        !value.includes("--")
    );
}

export function slugify(input: string): string {
    return input
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
}
