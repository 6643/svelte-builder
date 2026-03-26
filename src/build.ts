import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compile } from "svelte/compiler";
import { createBootstrapSource, createImportPath } from "./bootstrap";
import { copyConfiguredAssets, resolveConfiguredAssetsDir } from "./assets";
import { finalizeJavaScriptAssets, type FinalJavaScriptAsset } from "./finalize-js";
import { stripSvelteDiagnosticsModule } from "./strip-svelte-diagnostics";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type HtmlShell = {
    appHtml: string;
    lang: string;
    title: string;
};

export type BuildArtifacts = {
    cssFile: string;
    htmlFile: string;
    jsFile: string;
    outDir: string;
};

export type BuildSvelteOptions = {
    appTitle?: string;
    appComponent?: string;
    assetsDir?: string;
    mountId?: string;
    outDir?: string;
    port?: number;
    rootDir?: string;
    stripSvelteDiagnostics?: boolean;
    sourcemap?: boolean;
};

export const DEFAULT_HTML_SHELL: HtmlShell = {
    appHtml: '<main id="app"></main>',
    lang: "en",
    title: "Svelte Builder",
};
const FINAL_HASH_HEX_LENGTH = 16;
const MAX_JS_HASH_STABILIZATION_PASSES = 32;
const STAGE_OUTDIR_NAME = ".bsp-stage";
const TEMP_OUTDIR_NAME = "bsp-out";
const RELEASES_DIR_NAME = ".bsp-releases";
const CONFIG_FILE_NAME = "svelte-builder.config.json";
const SUPPORTED_CONFIG_FIELDS = [
    "appComponent",
    "appTitle",
    "assetsDir",
    "mountId",
    "outDir",
    "port",
    "rootDir",
    "sourcemap",
    "stripSvelteDiagnostics",
] as const;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const fail = (error: string): Result<never> => ({ ok: false, error });

const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
};

const escapeHtml = (value: string): string =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const hasOwnProperty = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isPathWithinRoot = (rootPath: string, candidatePath: string): boolean => {
    const relativePath = relative(rootPath, candidatePath);

    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const resolveConfiguredPath = (rootDir: string, value: string | undefined, fallback: string): string => {
    const target = value ?? fallback;
    return isAbsolute(target) ? target : join(rootDir, target);
};

const readOptionalStringField = (config: Record<string, unknown>, field: string): Result<string | undefined> => {
    if (!hasOwnProperty(config, field) || config[field] === undefined) {
        return ok(undefined);
    }

    if (typeof config[field] === "string") {
        return ok(config[field]);
    }

    return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected string.`);
};

const readOptionalAssetsDirField = (config: Record<string, unknown>, field: string): Result<string | undefined> => {
    const assetsDir = readOptionalStringField(config, field);
    if (!assetsDir.ok) {
        return assetsDir;
    }

    return ok(assetsDir.value ?? "assets");
};

const readOptionalAppComponentField = (config: Record<string, unknown>, field: string): Result<string | undefined> => {
    const appComponent = readOptionalStringField(config, field);
    if (!appComponent.ok) {
        return appComponent;
    }

    return ok(appComponent.value ?? "src/App.svelte");
};

const readOptionalNumberField = (config: Record<string, unknown>, field: string): Result<number | undefined> => {
    if (!hasOwnProperty(config, field) || config[field] === undefined) {
        return ok(undefined);
    }

    if (typeof config[field] === "number" && Number.isInteger(config[field]) && config[field] >= 0) {
        return ok(config[field]);
    }

    return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected non-negative integer.`);
};

const readOptionalBooleanField = (config: Record<string, unknown>, field: string): Result<boolean | undefined> => {
    if (!hasOwnProperty(config, field) || config[field] === undefined) {
        return ok(undefined);
    }

    if (typeof config[field] === "boolean") {
        return ok(config[field]);
    }

    return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected boolean.`);
};

const isPlainMountId = (mountId: string): boolean => /^[A-Za-z0-9_-]+$/.test(mountId);

const validateMountId = (value: unknown, field: string): Result<string> => {
    if (value !== undefined && typeof value !== "string") {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected string.`);
    }

    const mountId = value ?? "app";
    const normalizedMountId = mountId.trim();

    if (normalizedMountId.length === 0) {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected a non-empty id token.`);
    }

    if (normalizedMountId !== mountId) {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected a plain id token, not a selector-shaped value.`);
    }

    if (!isPlainMountId(normalizedMountId)) {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected a plain id token, not a selector-shaped value.`);
    }

    return ok(normalizedMountId);
};

const validateAppComponent = (value: unknown, field: string): Result<string> => {
    if (value !== undefined && typeof value !== "string") {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected string.`);
    }

    const appComponent = value ?? "src/App.svelte";
    const normalizedAppComponent = appComponent.trim();

    if (normalizedAppComponent.length === 0) {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected a non-empty component path.`);
    }

    if (normalizedAppComponent !== appComponent) {
        return fail(`Invalid ${field} in ${CONFIG_FILE_NAME}: expected a plain component path, not a whitespace-padded value.`);
    }

    return ok(normalizedAppComponent);
};

const validateOutDir = (
    rootDir: string,
    outDir: string,
    appComponentPath: string,
): Result<string> => {
    if (!isPathWithinRoot(rootDir, outDir) || outDir === rootDir) {
        return fail(
            `Invalid outDir in ${CONFIG_FILE_NAME}: expected a dedicated build output directory inside the project root.`,
        );
    }

    if (isPathWithinRoot(outDir, appComponentPath)) {
        return fail(`Invalid outDir in ${CONFIG_FILE_NAME}: outDir must not overlap the appComponent source tree.`);
    }

    return ok(outDir);
};

const parseBuildConfig = (value: unknown, configFileName = CONFIG_FILE_NAME): Result<BuildSvelteOptions> => {
    if (!isRecord(value)) {
        return fail(`Invalid ${configFileName}: expected a default-exported object config.`);
    }

    if (hasOwnProperty(value, "htmlTemplate")) {
        return fail(`Invalid htmlTemplate in ${configFileName}: htmlTemplate is no longer supported.`);
    }

    const unknownField = Object.keys(value).find((field) => !SUPPORTED_CONFIG_FIELDS.includes(field as (typeof SUPPORTED_CONFIG_FIELDS)[number]));
    if (unknownField !== undefined) {
        return fail(`Unknown field in ${configFileName}: ${unknownField}.`);
    }

    const appTitle = readOptionalStringField(value, "appTitle");
    if (!appTitle.ok) {
        return appTitle;
    }

    const appComponent = readOptionalAppComponentField(value, "appComponent");
    if (!appComponent.ok) {
        return appComponent;
    }

    const assetsDir = readOptionalAssetsDirField(value, "assetsDir");
    if (!assetsDir.ok) {
        return assetsDir;
    }

    const outDir = readOptionalStringField(value, "outDir");
    if (!outDir.ok) {
        return outDir;
    }

    const mountId = readOptionalStringField(value, "mountId");
    if (!mountId.ok) {
        return mountId;
    }

    const normalizedMountId = validateMountId(mountId.value, "mountId");
    if (!normalizedMountId.ok) {
        return normalizedMountId;
    }

    const port = readOptionalNumberField(value, "port");
    if (!port.ok) {
        return port;
    }

    const sourcemap = readOptionalBooleanField(value, "sourcemap");
    if (!sourcemap.ok) {
        return sourcemap;
    }

    const stripSvelteDiagnostics = readOptionalBooleanField(value, "stripSvelteDiagnostics");
    if (!stripSvelteDiagnostics.ok) {
        return stripSvelteDiagnostics;
    }

    return ok({
        appTitle: appTitle.value,
        appComponent: appComponent.value,
        assetsDir: assetsDir.value,
        mountId: normalizedMountId.value,
        outDir: outDir.value,
        port: port.value,
        stripSvelteDiagnostics: stripSvelteDiagnostics.value,
        sourcemap: sourcemap.value,
    });
};

export const createHtmlShell = (mountId: string, appTitle = DEFAULT_HTML_SHELL.title): HtmlShell => ({
    appHtml: `<main id="${escapeHtml(mountId)}"></main>`,
    lang: "en",
    title: appTitle,
});

const createHex16Hash = (content: string): string =>
    new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, FINAL_HASH_HEX_LENGTH);

const createFinalAssetFile = (content: string, extension: ".css" | ".js"): string =>
    `${createHex16Hash(content)}${extension}`;

const createScopedCssClassName = (css: string, hash: (input: string) => string): string => `_${hash(css)}`;

const formatBuildLogs = (logs: Array<{ message?: string; name?: string }>): string => {
    if (logs.length === 0) {
        return "Bun.build failed without diagnostic logs.";
    }

    return logs.map((log) => log.message ?? log.name ?? "Unknown build error").join("\n");
};

const createMergedCssAsset = (cssByPath: Map<string, string>): { content: string; finalFile: string } => {
    const content = Array.from(cssByPath.values()).join("\n");

    return {
        content,
        finalFile: createFinalAssetFile(content, ".css"),
    };
};

const prepareDir = async (path: string): Promise<Result<string>> => {
    const cleared = await rm(path, { force: true, recursive: true }).then(
        () => ok(path),
        (error) => fail(`Failed to clear ${path}: ${getErrorMessage(error)}`),
    );
    if (!cleared.ok) {
        return cleared;
    }

    return mkdir(path, { recursive: true }).then(
        () => ok(path),
        (error) => fail(`Failed to create ${path}: ${getErrorMessage(error)}`),
    );
};

const createBuildNonce = (): string => randomUUID().replaceAll("-", "");

const createStageDirPrefix = (rootDir: string, outDir: string): string =>
    `${STAGE_OUTDIR_NAME}-${createHex16Hash(relative(rootDir, outDir).replaceAll("\\", "/"))}`;

const createStageDir = (rootDir: string, outDir: string, nonce: string): string =>
    join(rootDir, `${createStageDirPrefix(rootDir, outDir)}-${nonce}`);

const createTempOutDir = (outDir: string, nonce: string): string =>
    join(dirname(outDir), `.${basename(outDir)}.${TEMP_OUTDIR_NAME}-${nonce}`);

const createPublishLockPath = (outDir: string): string => `${outDir}.lock`;

const createPendingPublishLockPath = (outDir: string, nonce: string): string =>
    join(dirname(outDir), `.${basename(outDir)}.lock-${nonce}`);

const createPublishLockOwnerPath = (lockPath: string): string => join(lockPath, "owner.json");

const isPidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false;
        }

        return true;
    }
};

const resolveLegacyReleaseTarget = (rootDir: string, outDir: string): string | undefined => {
    const releasesDir = join(rootDir, RELEASES_DIR_NAME);

    try {
        if (!lstatSync(outDir).isSymbolicLink()) {
            return undefined;
        }

        const resolvedOutDir = realpathSync(outDir);
        if (!isPathWithinRoot(releasesDir, resolvedOutDir) || resolvedOutDir === releasesDir) {
            return undefined;
        }

        return resolvedOutDir;
    } catch {
        return undefined;
    }
};

const cleanupLegacyReleaseTarget = async (rootDir: string, releaseTarget: string | undefined): Promise<void> => {
    if (releaseTarget === undefined) {
        return;
    }

    await rm(releaseTarget, { force: true, recursive: true }).catch(() => undefined);

    const releasesDir = join(rootDir, RELEASES_DIR_NAME);
    await readdir(releasesDir)
        .then(async (entries) => {
            if (entries.length === 0) {
                await rm(releasesDir, { force: true, recursive: true }).catch(() => undefined);
            }
        })
        .catch(() => undefined);
};

const cleanupRecoveredBuildState = async (rootDir: string, outDir: string): Promise<void> => {
    await cleanupLegacyReleaseTarget(rootDir, resolveLegacyReleaseTarget(rootDir, outDir));

    await readdir(rootDir)
        .then((entries) =>
            Promise.all(
                entries
                    .filter((entry) => entry.startsWith(`${createStageDirPrefix(rootDir, outDir)}-`))
                    .map((entry) => rm(join(rootDir, entry), { force: true, recursive: true }).catch(() => undefined)),
            ),
        )
        .catch(() => undefined);

    await readdir(dirname(outDir))
        .then((entries) =>
            Promise.all(
                entries
                    .filter((entry) => entry.startsWith(`.${basename(outDir)}.${TEMP_OUTDIR_NAME}-`))
                    .map((entry) => rm(join(dirname(outDir), entry), { force: true, recursive: true }).catch(() => undefined)),
            ),
        )
        .catch(() => undefined);

    await readdir(dirname(outDir))
        .then((entries) =>
            Promise.all(
                entries
                    .filter((entry) => entry.startsWith(`.${basename(outDir)}.lock-`))
                    .map((entry) => rm(join(dirname(outDir), entry), { force: true, recursive: true }).catch(() => undefined)),
            ),
        )
        .catch(() => undefined);
};

const acquirePublishLock = async (rootDir: string, outDir: string, allowRetry = true): Promise<Result<string>> => {
    const lockPath = createPublishLockPath(outDir);
    const pendingLockPath = createPendingPublishLockPath(outDir, createBuildNonce());
    const ownerPath = createPublishLockOwnerPath(lockPath);
    const pendingOwnerPath = createPublishLockOwnerPath(pendingLockPath);

    const pendingLockReady = await mkdir(pendingLockPath).then(
        () => ok(pendingLockPath),
        (error) => fail(`Failed to create pending build lock ${pendingLockPath}: ${getErrorMessage(error)}`),
    );
    if (!pendingLockReady.ok) {
        return pendingLockReady;
    }

    const pendingOwnerWritten = await writeFile(pendingOwnerPath, JSON.stringify({ pid: process.pid }), "utf8").then(
        () => ok(pendingOwnerPath),
        (error) => fail(`Failed to write build lock owner ${pendingOwnerPath}: ${getErrorMessage(error)}`),
    );
    if (!pendingOwnerWritten.ok) {
        await rm(pendingLockPath, { force: true, recursive: true }).catch(() => undefined);
        return pendingOwnerWritten;
    }

    return rename(pendingLockPath, lockPath).then(
        () => ok(lockPath),
        async (error: unknown) => {
            await rm(pendingLockPath, { force: true, recursive: true }).catch(() => undefined);

            if (!(error instanceof Error) || !("code" in error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) {
                return fail(`Failed to acquire build lock ${lockPath}: ${getErrorMessage(error)}`);
            }

            const owner = await readFile(ownerPath, "utf8").then(
                (value) =>
                    Promise.resolve(value)
                        .then((text) => JSON.parse(text) as { pid?: unknown })
                        .then(
                            (parsed) => (typeof parsed.pid === "number" ? ok<number | null>(parsed.pid) : ok<number | null>(null)),
                            () => ok<number | null>(null),
                        ),
                () => ok<number | null>(null),
            );
            if (!owner.ok) {
                return owner;
            }

            if (owner.value !== null && isPidAlive(owner.value)) {
                return fail(`Another build is already running for ${outDir} (pid ${owner.value}).`);
            }

            if (!allowRetry) {
                return fail(`Failed to recover stale build lock ${lockPath}.`);
            }

            await rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
            await cleanupRecoveredBuildState(rootDir, outDir);
            return acquirePublishLock(rootDir, outDir, false);
        },
    );
};

const publishBuildOutput = async (rootDir: string, tempOutDir: string, outDir: string): Promise<Result<string>> => {
    const legacyReleaseTarget = resolveLegacyReleaseTarget(rootDir, outDir);
    const cleared = await rm(outDir, { force: true, recursive: true }).then(
        () => ok(outDir),
        (error) => fail(`Failed to clear ${outDir}: ${getErrorMessage(error)}`),
    );
    if (!cleared.ok) {
        return cleared;
    }

    const published = await rename(tempOutDir, outDir).then(
        () => ok(outDir),
        (error) => fail(`Failed to publish ${outDir}: ${getErrorMessage(error)}`),
    );
    if (!published.ok) {
        return published;
    }

    await cleanupLegacyReleaseTarget(rootDir, legacyReleaseTarget);
    return published;
};

const readRequiredText = async (path: string): Promise<Result<string>> => {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
        return fail(`Missing file: ${path}`);
    }

    return file.text().then(
        (value) => ok(value),
        (error) => fail(`Failed to read ${path}: ${getErrorMessage(error)}`),
    );
};

const compileSvelteModule = async (path: string): Promise<Result<{ css: string; js: string }>> => {
    const source = await readRequiredText(path);
    if (!source.ok) {
        return source;
    }

    return Promise.resolve()
        .then(() =>
            compile(source.value, {
                css: "external",
                cssHash: ({ css, hash }) => createScopedCssClassName(css, hash),
                dev: false,
                filename: path,
                generate: "client",
            }),
        )
        .then(
            ({ css, js }) =>
                ok({
                    css: css?.code ?? "",
                    js: js.code,
                }),
            (error) => fail(`Failed to compile ${path}: ${getErrorMessage(error)}`),
        );
};

const createProductionEsmEnvPlugin = (): Bun.BunPlugin => ({
    name: "production-esm-env-plugin",
    target: "browser",
    setup: (builder) => {
        builder.onResolve({ filter: /^esm-env\/development$/ }, () => ({
            namespace: "svelte-builder-virtual",
            path: "esm-env/development",
        }));

        builder.onLoad(
            { filter: /^esm-env\/development$/, namespace: "svelte-builder-virtual" },
            () => ({
                contents: "export default false;",
                loader: "js",
            }),
        );

        builder.onLoad({ filter: /internal\/client\/errors\.js$/ }, async ({ path }) => ({
            contents: stripSvelteDiagnosticsModule(await Bun.file(path).text(), "errors"),
            loader: "js",
        }));

        builder.onLoad({ filter: /internal\/client\/warnings\.js$/ }, async ({ path }) => ({
            contents: stripSvelteDiagnosticsModule(await Bun.file(path).text(), "warnings"),
            loader: "js",
        }));
    },
});

export const createSveltePlugin = (cssByPath: Map<string, string>): Bun.BunPlugin => ({
    name: "svelte-prod-plugin",
    target: "browser",
    setup: (builder) => {
        builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
            const compiled = await compileSvelteModule(path);
            if (!compiled.ok) {
                return Promise.reject(new Error(compiled.error));
            }

            if (compiled.value.css.length > 0) {
                cssByPath.set(path, compiled.value.css);
            }

            return {
                contents: compiled.value.js,
                loader: "js",
            };
        });
    },
});

export const defineSvelteConfig = (config: BuildSvelteOptions): BuildSvelteOptions => config;

const resolveSourcemapMode = (sourcemap: boolean | undefined): Bun.BuildConfig["sourcemap"] => (sourcemap ? "inline" : "none");

const loadJsonConfigFile = async (configPath: string): Promise<Result<unknown>> => {
    const configFile = Bun.file(configPath);
    const exists = await configFile.exists();
    if (!exists) {
        return fail(`Missing config: ${configPath}`);
    }

    return configFile.text().then(
        (contents) => {
            try {
                return ok(JSON.parse(contents));
            } catch (error) {
                return fail(`Failed to parse ${configPath}: ${getErrorMessage(error)}`);
            }
        },
        (error) => fail(`Failed to read ${configPath}: ${getErrorMessage(error)}`),
    );
};

export const loadSvelteConfig = async (cwd = process.cwd()): Promise<Result<BuildSvelteOptions>> => {
    const configRoot = resolve(cwd);
    const configPath = join(configRoot, CONFIG_FILE_NAME);
    const configExists = await Bun.file(configPath).exists();
    if (!configExists) {
        const legacyConfigPath = join(configRoot, "svelte-builder.config.ts");
        if (await Bun.file(legacyConfigPath).exists()) {
            return fail(`Legacy config is no longer supported: ${legacyConfigPath}. Rename it to ${configPath}.`);
        }

        return fail(`Missing config: ${configPath}`);
    }

    const loaded = await loadJsonConfigFile(configPath);
    if (!loaded.ok) {
        return loaded;
    }

    const parsed = parseBuildConfig(loaded.value, CONFIG_FILE_NAME);
    if (!parsed.ok) {
        return parsed;
    }

    return ok({
        ...parsed.value,
        rootDir: configRoot,
    });
};

const writeJavaScriptAssets = async (outDir: string, assets: FinalJavaScriptAsset[]): Promise<Result<void>> => {
    const writes = Array.from(
        new Map(assets.map((asset) => [asset.finalFile, asset.content])).entries(),
        ([finalFile, content]) => writeFile(join(outDir, finalFile), content, "utf8"),
    );

    return Promise.all(writes).then(
        () => ok(undefined),
        (error) => fail(`Failed to write JavaScript assets: ${getErrorMessage(error)}`),
    );
};

const writeCssAsset = async (
    outDir: string,
    asset: { content: string; finalFile: string },
): Promise<Result<string>> =>
    writeFile(join(outDir, asset.finalFile), asset.content, "utf8").then(
        () => ok(asset.finalFile),
        (error) => fail(`Failed to write ${asset.finalFile}: ${getErrorMessage(error)}`),
    );

const writeIndexHtml = async (
    outDir: string,
    shell: HtmlShell,
    jsFile: string,
    cssFile: string,
): Promise<Result<string>> => {
    const html = [
        "<!DOCTYPE html>",
        `<html lang="${escapeHtml(shell.lang)}">`,
        "<head>",
        '    <meta charset="UTF-8">',
        `    <title>${escapeHtml(shell.title)}</title>`,
        `    <link rel="stylesheet" href="/${cssFile}">`,
        "</head>",
        "<body>",
        `    ${shell.appHtml}`,
        `    <script type="module" src="/${jsFile}"></script>`,
        "</body>",
        "</html>",
    ].join("\n");

    return writeFile(join(outDir, "index.html"), html, "utf8").then(
        () => ok("index.html"),
        (error) => fail(`Failed to write index.html: ${getErrorMessage(error)}`),
    );
};

export const buildSvelte = async (options: BuildSvelteOptions = {}): Promise<Result<BuildArtifacts>> => {
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const outDir = resolveConfiguredPath(rootDir, options.outDir, "dist");
    const mountId = validateMountId(options.mountId, "mountId");
    if (!mountId.ok) {
        return mountId;
    }
    const appComponent = validateAppComponent(options.appComponent, "appComponent");
    if (!appComponent.ok) {
        return appComponent;
    }
    const appComponentPath = resolveConfiguredPath(rootDir, appComponent.value, "src/App.svelte");
    const appComponentRelativeToRoot = relative(rootDir, appComponentPath);
    if (appComponentRelativeToRoot.startsWith("..") || isAbsolute(appComponentRelativeToRoot)) {
        return fail(`Invalid appComponent in ${CONFIG_FILE_NAME}: expected a path inside the project root.`);
    }
    const appTitle = options.appTitle ?? DEFAULT_HTML_SHELL.title;
    const buildNonce = createBuildNonce();
    const assetsDir = await resolveConfiguredAssetsDir(rootDir, options.assetsDir ?? "assets");
    const stripSvelteDiagnostics = options.stripSvelteDiagnostics ?? true;
    let lockPath: string | null = null;
    let published = false;

    if (!assetsDir.ok) {
        return fail(assetsDir.error);
    }

    const validatedOutDir = validateOutDir(rootDir, outDir, appComponentPath);
    if (!validatedOutDir.ok) {
        return validatedOutDir;
    }

    const stageDir = createStageDir(rootDir, validatedOutDir.value, buildNonce);
    const tempOutDir = createTempOutDir(validatedOutDir.value, buildNonce);

    const entryExists = await Bun.file(appComponentPath).exists();
    if (!entryExists) {
        return fail(`Missing SPA app component: ${appComponentPath}`);
    }

    const lock = await acquirePublishLock(rootDir, validatedOutDir.value);
    if (!lock.ok) {
        return lock;
    }
    lockPath = lock.value;

    const outDirReady = await prepareDir(tempOutDir);
    if (!outDirReady.ok) {
        return outDirReady;
    }

    const stageDirReady = await prepareDir(stageDir);
    if (!stageDirReady.ok) {
        return stageDirReady;
    }
    const cssByPath = new Map<string, string>();
    const bootstrapPath = join(stageDir, "bootstrap.ts");
    const bootstrapSource = createBootstrapSource(createImportPath(stageDir, appComponentPath), mountId.value);
    const bootstrapWritten = await writeFile(bootstrapPath, bootstrapSource, "utf8").then(
        () => ok(undefined),
        (error) => fail(`Failed to write bootstrap: ${getErrorMessage(error)}`),
    );
    if (!bootstrapWritten.ok) {
        return bootstrapWritten;
    }

    try {
        const bundle = await Bun.build({
            entrypoints: [bootstrapPath],
            format: "esm",
            minify: true,
            naming: {
                asset: "[hash].[ext]",
                chunk: "[hash].[ext]",
                entry: "[hash].[ext]",
            },
            outdir: stageDir,
            plugins: [stripSvelteDiagnostics ? createProductionEsmEnvPlugin() : null, createSveltePlugin(cssByPath)].filter(
                (plugin): plugin is Bun.BunPlugin => plugin !== null,
            ),
            sourcemap: resolveSourcemapMode(options.sourcemap),
            splitting: true,
            target: "browser",
        });
        if (!bundle.success) {
            return fail(formatBuildLogs(bundle.logs));
        }

        const rewrittenAssets = await finalizeJavaScriptAssets(
            bundle.outputs,
            createFinalAssetFile,
            MAX_JS_HASH_STABILIZATION_PASSES,
        );
        if (!rewrittenAssets.ok) {
            return rewrittenAssets;
        }

        const entryAsset = rewrittenAssets.value.find((asset) => asset.kind === "entry-point");
        if (!entryAsset) {
            return fail("Bun.build succeeded but emitted no JavaScript entry artifact.");
        }

        const cssAsset = createMergedCssAsset(cssByPath);
        const jsWrite = await writeJavaScriptAssets(tempOutDir, rewrittenAssets.value);
        if (!jsWrite.ok) {
            return jsWrite;
        }

        const cssFile = await writeCssAsset(tempOutDir, cssAsset);
        if (!cssFile.ok) {
            return cssFile;
        }

        const htmlFile = await writeIndexHtml(
            tempOutDir,
            createHtmlShell(mountId.value, appTitle),
            entryAsset.finalFile,
            cssFile.value,
        );
        if (!htmlFile.ok) {
            return htmlFile;
        }

        if (assetsDir.value !== undefined) {
            const assetsOutDir = join(tempOutDir, "assets");
            const copiedAssets = await copyConfiguredAssets(assetsDir.value, assetsOutDir);
            if (!copiedAssets.ok) {
                return fail(copiedAssets.error);
            }
        }

        const publishedOutDir = await publishBuildOutput(rootDir, tempOutDir, validatedOutDir.value);
        if (!publishedOutDir.ok) {
            return publishedOutDir;
        }
        published = true;

        return ok({
            cssFile: cssFile.value,
            htmlFile: htmlFile.value,
            jsFile: entryAsset.finalFile,
            outDir: validatedOutDir.value,
        });
    } finally {
        await rm(stageDir, { force: true, recursive: true }).catch(() => undefined);
        if (!published) {
            await rm(tempOutDir, { force: true, recursive: true }).catch(() => undefined);
        }
        if (lockPath) {
            await rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
        }
    }
};

export const runConfiguredBuild = async (cwd = process.cwd()): Promise<Result<BuildArtifacts>> => {
    const config = await loadSvelteConfig(cwd);
    if (!config.ok) {
        return config;
    }

    return buildSvelte(config.value);
};

export const buildProduction = buildSvelte;
