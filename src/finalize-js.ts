import { basename } from "node:path";
import type { Result } from "./build";

export type StagedJavaScriptAsset = {
    kind: "chunk" | "entry-point";
    oldFile: string;
    originalContent: string;
};

export type FinalJavaScriptAsset = {
    content: string;
    finalFile: string;
    kind: "chunk" | "entry-point";
    oldFile: string;
};

const createReferenceRewritePattern = (nameMap: Map<string, string>): RegExp | null => {
    const stagedFiles = Array.from(nameMap.keys()).sort((left, right) => right.length - left.length);
    if (stagedFiles.length === 0) {
        return null;
    }

    return new RegExp(stagedFiles.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
};

const rewriteJavaScriptAssetReferences = (content: string, nameMap: Map<string, string>): string => {
    const pattern = createReferenceRewritePattern(nameMap);
    if (!pattern) {
        return content;
    }

    return content.replace(pattern, (match) => nameMap.get(match) ?? match);
};

const validateUniqueAssetNames = (
    assets: Array<{ content: string; finalFile: string; oldFile: string }>,
): Result<void> => {
    const contentsByFinalFile = new Map<string, string>();

    for (const asset of assets) {
        const existing = contentsByFinalFile.get(asset.finalFile);
        if (existing === undefined) {
            contentsByFinalFile.set(asset.finalFile, asset.content);
            continue;
        }

        if (existing !== asset.content) {
            return { ok: false, error: `Hash collision detected for ${asset.oldFile}: ${asset.finalFile}` };
        }
    }

    return { ok: true, value: undefined };
};

const createInitialJavaScriptNameMap = (
    assets: StagedJavaScriptAsset[],
    createFinalAssetFile: (content: string, extension: ".js") => string,
): Map<string, string> => new Map(assets.map((asset) => [asset.oldFile, createFinalAssetFile(asset.originalContent, ".js")]));

const createFinalJavaScriptAssets = (
    assets: StagedJavaScriptAsset[],
    nameMap: Map<string, string>,
    createFinalAssetFile: (content: string, extension: ".js") => string,
): FinalJavaScriptAsset[] =>
    assets.map((asset) => {
        const content = rewriteJavaScriptAssetReferences(asset.originalContent, nameMap);

        return {
            content,
            finalFile: createFinalAssetFile(content, ".js"),
            kind: asset.kind,
            oldFile: asset.oldFile,
        };
    });

const areNameMapsEqual = (left: Map<string, string>, right: Map<string, string>): boolean =>
    left.size === right.size && Array.from(left.entries()).every(([key, value]) => right.get(key) === value);

const readStagedJavaScriptAssets = async (
    outputs: Bun.BuildArtifact[],
): Promise<Result<StagedJavaScriptAsset[]>> => {
    const jsOutputs = outputs.filter(
        (output): output is Bun.BuildArtifact & { kind: "chunk" | "entry-point" } =>
            (output.kind === "chunk" || output.kind === "entry-point") && output.path.endsWith(".js"),
    );

    return Promise.all(
        jsOutputs.map(async (output) => ({
            kind: output.kind,
            oldFile: basename(output.path),
            originalContent: await output.text(),
        })),
    ).then(
        (assets) => ({ ok: true, value: assets }),
        (error) => ({ ok: false, error: `Failed to read staged JavaScript assets: ${error instanceof Error ? error.message : String(error)}` }),
    );
};

export const finalizeJavaScriptAssets = async (
    outputs: Bun.BuildArtifact[],
    createFinalAssetFile: (content: string, extension: ".js") => string,
    maxPasses: number,
): Promise<Result<FinalJavaScriptAsset[]>> => {
    const stagedAssets = await readStagedJavaScriptAssets(outputs);
    if (!stagedAssets.ok) {
        return stagedAssets;
    }

    let nameMap = createInitialJavaScriptNameMap(stagedAssets.value, createFinalAssetFile);

    for (let pass = 0; pass < maxPasses; pass += 1) {
        const rewrittenAssets = createFinalJavaScriptAssets(stagedAssets.value, nameMap, createFinalAssetFile);
        const uniqueAssets = validateUniqueAssetNames(rewrittenAssets);
        if (!uniqueAssets.ok) {
            return uniqueAssets;
        }

        const nextNameMap = new Map(rewrittenAssets.map((asset) => [asset.oldFile, asset.finalFile]));
        if (areNameMapsEqual(nameMap, nextNameMap)) {
            return { ok: true, value: rewrittenAssets };
        }

        nameMap = nextNameMap;
    }

    return { ok: false, error: `Failed to stabilize JavaScript asset names after ${maxPasses} passes.` };
};
