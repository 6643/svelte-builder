import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const fail = (error: string): Result<never> => ({ ok: false, error });

const getErrorCode = (error: unknown): string | undefined =>
    error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
    const relativePath = relative(rootPath, candidatePath);

    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const resolvePathWithinRoot = (rootPath: string, requestedPath: string): Result<string> => {
    const resolvedPath = resolve(rootPath, requestedPath);

    if (!isPathWithinRoot(rootPath, resolvedPath)) {
        return fail(`Requested asset path escapes assets root: ${requestedPath}`);
    }

    return ok(resolvedPath);
};

const resolvePhysicalPath = async (path: string): Promise<Result<string>> =>
    realpath(path).then(
        (value) => ok(value),
        (error: unknown) =>
            fail(
                `Failed to resolve physical path ${path}: ${error instanceof Error ? error.message : String(error)}`,
            ),
    );

const resolvePhysicalChildPath = async (path: string): Promise<Result<string>> => {
    const physicalParent = await resolvePhysicalPath(dirname(path));
    if (!physicalParent.ok) {
        return physicalParent;
    }

    return ok(join(physicalParent.value, basename(path)));
};

export const resolveConfiguredAssetsDir = async (rootDir: string, assetsDir?: string): Promise<Result<string | undefined>> => {
    if (assetsDir === undefined) {
        return ok(undefined);
    }

    const resolvedDir = isAbsolute(assetsDir) ? assetsDir : resolve(rootDir, assetsDir);

    const info = await stat(resolvedDir).then(
        (value) => ok(value),
        (error: unknown) => {
            const code = getErrorCode(error);
            if (code === "ENOENT" || code === "ENOTDIR") {
                return fail(`Missing configured assets directory: ${assetsDir} (resolved to ${resolvedDir})`);
            }

            return fail(
                `Failed to inspect configured assets directory ${assetsDir} (resolved to ${resolvedDir}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        },
    );
    if (!info.ok) {
        return info;
    }

    if (!info.value.isDirectory()) {
        return fail(`Configured assetsDir is not a directory: ${assetsDir} (resolved to ${resolvedDir})`);
    }

    const physicalDir = await resolvePhysicalPath(resolvedDir);
    if (!physicalDir.ok) {
        return physicalDir;
    }

    return ok(physicalDir.value);
};

const copyDirectoryContents = async (sourceDir: string, destinationDir: string): Promise<Result<void>> => {
    const entries = await readdir(sourceDir, { withFileTypes: true }).then(
        (value) => ok(value),
        (error) => fail(`Failed to read assets directory ${sourceDir}: ${error instanceof Error ? error.message : String(error)}`),
    );
    if (!entries.ok) {
        return entries;
    }

    const created = await mkdir(destinationDir, { recursive: true }).then(
        () => ok(destinationDir),
        (error) => fail(`Failed to create assets output directory ${destinationDir}: ${error instanceof Error ? error.message : String(error)}`),
    );
    if (!created.ok) {
        return created;
    }

    for (const entry of entries.value) {
        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);

        if (entry.isDirectory()) {
            const copied = await copyDirectoryContents(sourcePath, destinationPath);
            if (!copied.ok) {
                return copied;
            }
            continue;
        }

        if (entry.isSymbolicLink()) {
            return fail(`Symbolic links are not supported in assets directory: ${sourcePath}`);
        }

        if (!entry.isFile()) {
            return fail(`Unsupported assets entry: ${sourcePath}`);
        }

        const copied = await copyFile(sourcePath, destinationPath).then(
            () => ok(destinationPath),
            (error) => fail(`Failed to copy asset ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`),
        );
        if (!copied.ok) {
            return copied;
        }
    }

    return ok(undefined);
};

export const resolveAssetPath = (assetsRoot: string, requestedPath: string): Result<string> =>
    resolvePathWithinRoot(assetsRoot, requestedPath);

export const resolvePhysicalAssetPath = async (
    assetsRoot: string,
    requestedPath: string,
): Promise<Result<string>> => {
    const lexicalPath = resolveAssetPath(assetsRoot, requestedPath);
    if (!lexicalPath.ok) {
        return lexicalPath;
    }

    const physicalPath = await resolvePhysicalPath(lexicalPath.value);
    if (!physicalPath.ok) {
        return physicalPath;
    }

    if (!isPathWithinRoot(assetsRoot, physicalPath.value)) {
        return fail(`Requested asset path resolves outside assets root: ${requestedPath}`);
    }

    return ok(physicalPath.value);
};

const validateAssetCopyRoots = (assetsRoot: string, assetsOutDir: string): Result<void> => {
    if (isPathWithinRoot(assetsRoot, assetsOutDir)) {
        return fail(`Configured assets directory overlaps the build output tree: ${assetsOutDir}`);
    }

    if (isPathWithinRoot(assetsOutDir, assetsRoot)) {
        return fail(`Configured assets directory overlaps the build output tree: ${assetsRoot}`);
    }

    return ok(undefined);
};

export const copyConfiguredAssets = async (assetsRoot: string, assetsOutDir: string): Promise<Result<string>> => {
    const physicalAssetsRoot = await resolvePhysicalPath(assetsRoot);
    if (!physicalAssetsRoot.ok) {
        return physicalAssetsRoot;
    }

    const physicalAssetsOutDir = await resolvePhysicalChildPath(assetsOutDir);
    if (!physicalAssetsOutDir.ok) {
        return physicalAssetsOutDir;
    }

    const roots = validateAssetCopyRoots(physicalAssetsRoot.value, physicalAssetsOutDir.value);
    if (!roots.ok) {
        return roots;
    }

    const copied = await copyDirectoryContents(physicalAssetsRoot.value, physicalAssetsOutDir.value);
    if (!copied.ok) {
        return copied;
    }

    return ok(assetsOutDir);
};
