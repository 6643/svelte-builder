import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveAssetPath } from "../packages/bun-svelte-builder/src/assets";

test("resolveAssetPath dev assets keeps asset subpaths inside the configured assets root", () => {
    const assetsRoot = join(process.cwd(), "tmp-assets-root");
    const result = resolveAssetPath(assetsRoot, "images/banner.txt");

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.value).toBe(join(assetsRoot, "images", "banner.txt"));
});

test("resolveAssetPath rejects traversal attempts outside the assets root", () => {
    const assetsRoot = join(process.cwd(), "tmp-assets-root");

    const parentEscape = resolveAssetPath(assetsRoot, "../package.json");
    const nestedEscape = resolveAssetPath(assetsRoot, "icons/../../package.json");

    expect(parentEscape.ok).toBe(false);
    expect(nestedEscape.ok).toBe(false);

    if (parentEscape.ok || nestedEscape.ok) {
        throw new Error("Expected traversal attempts to be rejected");
    }

    expect(parentEscape.error).toContain("escapes assets root");
    expect(nestedEscape.error).toContain("escapes assets root");
});
