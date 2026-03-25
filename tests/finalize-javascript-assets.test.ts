import { expect, test } from "bun:test";
import { finalizeJavaScriptAssets } from "../src/finalize-js";

type FakeOutput = Bun.BuildArtifact & {
    kind: "chunk" | "entry-point" | "asset";
    path: string;
    text: () => Promise<string>;
};

const createJsOutput = (path: string, kind: "chunk" | "entry-point", source: string): FakeOutput =>
    ({
        kind,
        path,
        text: async () => source,
    }) as FakeOutput;

const createHashedJsFileName = (content: string, extension: ".js"): string => {
    if (extension !== ".js") {
        throw new Error(`Unexpected extension: ${extension}`);
    }

    return `${new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16)}${extension}`;
};

test("finalizeJavaScriptAssets returns a hashed file for a single entry asset", async () => {
    const source = 'console.log("entry");';
    const result = await finalizeJavaScriptAssets(
        [createJsOutput("entry.js", "entry-point", source)],
        createHashedJsFileName,
        32,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toEqual({
        content: source,
        finalFile: createHashedJsFileName(source, ".js"),
        kind: "entry-point",
        oldFile: "entry.js",
    });
});

test("finalizeJavaScriptAssets rewrites staged chunk references to final hashed names", async () => {
    const chunkSource = 'export const value = "chunk";';
    const chunkFinalFile = createHashedJsFileName(chunkSource, ".js");
    const entrySource = 'await import("chunk-old.js");';
    const entryFinalSource = `await import("${chunkFinalFile}");`;

    const result = await finalizeJavaScriptAssets(
        [
            createJsOutput("entry.js", "entry-point", entrySource),
            createJsOutput("chunk-old.js", "chunk", chunkSource),
        ],
        createHashedJsFileName,
        32,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(result.error);
    }

    const entryAsset = result.value.find((asset) => asset.kind === "entry-point");
    const chunkAsset = result.value.find((asset) => asset.oldFile === "chunk-old.js");

    expect(entryAsset).toBeDefined();
    expect(chunkAsset).toBeDefined();
    expect(entryAsset?.content).toBe(entryFinalSource);
    expect(entryAsset?.content).not.toContain("chunk-old.js");
    expect(entryAsset?.finalFile).toBe(createHashedJsFileName(entryFinalSource, ".js"));
    expect(chunkAsset?.finalFile).toBe(chunkFinalFile);
});

test("finalizeJavaScriptAssets stabilizes transitive chunk references across multiple passes", async () => {
    const createControlledFileName = (content: string, extension: ".js"): string => {
        if (extension !== ".js") {
            throw new Error(`Unexpected extension: ${extension}`);
        }

        if (content === 'export const leaf = "ready";') {
            return "leaf-final.js";
        }

        if (content === 'export const mid = () => import("leaf-final.js");') {
            return "mid-final.js";
        }

        if (content === 'export const mid = () => import("leaf.js");') {
            return "mid-seed.js";
        }

        if (content === 'export const entry = () => import("mid-final.js");') {
            return "entry-final.js";
        }

        if (content === 'export const entry = () => import("mid.js");') {
            return "entry-seed.js";
        }

        if (content === 'export const entry = () => import("mid-seed.js");') {
            return "entry-mid.js";
        }

        throw new Error(`Unexpected content: ${content}`);
    };

    const result = await finalizeJavaScriptAssets(
        [
            createJsOutput("entry.js", "entry-point", 'export const entry = () => import("mid.js");'),
            createJsOutput("mid.js", "chunk", 'export const mid = () => import("leaf.js");'),
            createJsOutput("leaf.js", "chunk", 'export const leaf = "ready";'),
        ],
        createControlledFileName,
        32,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(result.error);
    }

    const filesByOldName = new Map(result.value.map((asset) => [asset.oldFile, asset]));

    expect(filesByOldName.get("leaf.js")?.finalFile).toBe("leaf-final.js");
    expect(filesByOldName.get("mid.js")?.content).toBe('export const mid = () => import("leaf-final.js");');
    expect(filesByOldName.get("mid.js")?.finalFile).toBe("mid-final.js");
    expect(filesByOldName.get("entry.js")?.content).toBe('export const entry = () => import("mid-final.js");');
    expect(filesByOldName.get("entry.js")?.finalFile).toBe("entry-final.js");
});

test("finalizeJavaScriptAssets returns an empty result when no JavaScript outputs exist", async () => {
    const assetOutput = {
        kind: "asset",
        path: "style.css",
        text: async () => "body { color: teal; }",
    } as FakeOutput;

    const result = await finalizeJavaScriptAssets([assetOutput], createHashedJsFileName, 32);

    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.value).toEqual([]);
});

test("finalizeJavaScriptAssets fails when names do not stabilize within the pass limit", async () => {
    const createOscillatingFileName = (content: string, extension: ".js"): string => {
        if (extension !== ".js") {
            throw new Error(`Unexpected extension: ${extension}`);
        }

        return content.includes('import("flip.js")') ? "flop.js" : "flip.js";
    };

    const result = await finalizeJavaScriptAssets(
        [createJsOutput("entry.js", "entry-point", 'await import("entry.js");')],
        createOscillatingFileName,
        1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
        throw new Error("Expected finalizeJavaScriptAssets to fail when names do not stabilize");
    }

    expect(result.error).toContain("Failed to stabilize JavaScript asset names");
});
