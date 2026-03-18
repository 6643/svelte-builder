import { randomInt } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { compile } from "svelte/compiler";
import { createHtmlShell, type BuildSvelteOptions, type Result, loadSvelteConfig } from "./build";
import { createBootstrapSource, createImportPath, resolveConfiguredPath } from "./bootstrap";
import { resolveConfiguredAssetsDir, resolvePhysicalAssetPath } from "./assets";
import { formatAssetReport } from "./report";

export type DevServerHandle = {
    port: number;
    stop: () => Promise<void>;
};

const EXCLUDED_DIRS = ["node_modules", ".git", "dist"];
const DEV_WATCH_DEBOUNCE_MS = 100;
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const fail = (error: string): Result<never> => ({ ok: false, error });

const DEV_PORT_RETRY_LIMIT = 8;
const DEV_PORT_RANGE_MAX = 65535;
const DEV_PORT_RANGE_MIN = 49152;
const getErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
};

const getErrorCode = (error: unknown): string | undefined =>
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const escapeHtml = (value: string): string =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

const createNotFoundResponse = (): Response => new Response("Not Found", { status: 404 });

const createDevHtmlShell = (importMapScript: string, mountId: string, appTitle: string): string =>
    [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '    <meta charset="UTF-8">',
        `    <title>${escapeHtml(appTitle)}</title>`,
        `    ${importMapScript}`,
        "</head>",
        "<body>",
        `    ${createHtmlShell(mountId, appTitle).appHtml}`,
        '    <script type="module" src="/main.ts"></script>',
        "</body>",
        "</html>",
    ].join("\n");

const createRecompiledAssetReport = (modulePath: string, contents: string): string =>
    formatAssetReport(
        "Recompiled assets",
        [
            {
                file: modulePath,
                gzip: gzipSync(contents).byteLength,
                size: Buffer.byteLength(contents),
                time: new Date().toISOString().replace("T", " ").slice(0, 19),
            },
        ],
        { includeTime: true },
    );

const logRecompiledAsset = (modulePath: string, contents: string): void => {
    console.log(createRecompiledAssetReport(modulePath, contents));
};

const isCompilableDevModule = (filePath: string): boolean =>
    filePath.endsWith(".svelte") || filePath.endsWith(".ts") || filePath.endsWith(".js");

const isExcludedWatchDirectory = (dirName: string): boolean => EXCLUDED_DIRS.includes(dirName);

const getWatcherErrorCode = (error: unknown): string | undefined =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

const isIgnorableDevWatcherError = (error: unknown): boolean => {
    const errorCode = getWatcherErrorCode(error);
    return errorCode === "ENOENT" || errorCode === "ENOTDIR";
};

export const formatDevWatcherIssue = (context: string, error: unknown): string | undefined => {
    if (isIgnorableDevWatcherError(error)) {
        return undefined;
    }

    return `[bun-svelte-builder] ${context}: ${getErrorMessage(error)}`;
};

const reportDevWatcherIssue = (context: string, error: unknown): void => {
    const issue = formatDevWatcherIssue(context, error);
    if (issue !== undefined) {
        console.warn(issue);
    }
};

export const attachDevWatcherErrorHandler = (
    watcher: { on: (event: string, handler: (error: unknown) => void) => unknown },
    context: string,
): void => {
    watcher.on("error", (error) => {
        reportDevWatcherIssue(context, error);
    });
};

export const shouldProcessDevWatchEvent = (
    recentEvents: Map<string, number>,
    modulePath: string,
    now = Date.now(),
): boolean => {
    const previous = recentEvents.get(modulePath);
    recentEvents.set(modulePath, now);

    if (previous !== undefined && now - previous < DEV_WATCH_DEBOUNCE_MS) {
        return false;
    }

    for (const [path, timestamp] of recentEvents) {
        if (now - timestamp >= DEV_WATCH_DEBOUNCE_MS) {
            recentEvents.delete(path);
        }
    }

    return true;
};

const compileChangedDevAsset = async (rootDir: string, modulePath: string): Promise<void> => {
    if (modulePath.endsWith(".svelte")) {
        const compiled = await compileSvelteForDev(rootDir, modulePath, true);
        if (!compiled.ok) {
            console.error(compiled.error);
        }

        return;
    }

    if (modulePath.endsWith(".js")) {
        const compiled = await loadRequiredText(join(rootDir, modulePath));
        if (!compiled.ok) {
            console.error(compiled.error);
            return;
        }

        logRecompiledAsset(modulePath, compiled.value);
        return;
    }

    if (modulePath.endsWith(".ts")) {
        const transpiled = await transpileTypeScriptForDev(rootDir, modulePath, true);
        if (!transpiled.ok) {
            console.error(transpiled.error);
        }
    }
};

type DevReloadHub = {
    stop: () => void;
    subscribe: (listener: (data: string) => void) => () => void;
};

const createDevReloadHub = (watchDir: string): DevReloadHub => {
    const watchers: { close: () => void }[] = [];
    const listeners = new Set<(data: string) => void>();
    const recentEvents = new Map<string, number>();
    const watchedDirs = new Set<string>();

    const stop = (): void => {
        watchers.forEach((watcher) => watcher.close());
        watchers.length = 0;
        listeners.clear();
    };

    const notify = (data: string): void => {
        for (const listener of listeners) {
            listener(data);
        }
    };

    const watchRecursive = (dir: string) => {
        if (watchedDirs.has(dir)) {
            return;
        }

        try {
            watchedDirs.add(dir);
            const watcher = watch(dir, (_eventType, filename) => {
                    if (typeof filename !== "string" || filename.length === 0) {
                        notify("reload");
                        return;
                    }

                    try {
                        const modulePath = join(dir, filename);
                        const entry = lstatSync(modulePath);
                        if (entry.isDirectory()) {
                            if (!isExcludedWatchDirectory(filename) && !filename.startsWith(".")) {
                                watchRecursive(modulePath);
                            }
                            return;
                        }

                        if (!entry.isFile()) {
                            return;
                        }

                        const relativePath = relative(watchDir, modulePath);
                        if (relativePath.startsWith("..") || relativePath.length === 0 || !isCompilableDevModule(relativePath)) {
                            return;
                        }

                        if (!shouldProcessDevWatchEvent(recentEvents, relativePath)) {
                            return;
                        }

                        notify("reload");
                        void compileChangedDevAsset(watchDir, relativePath);
                    } catch (error) {
                        reportDevWatcherIssue(`watch event for ${join(dir, filename)}`, error);
                    }
                });
            attachDevWatcherErrorHandler(watcher, `watch runtime for ${dir}`);
            watchers.push(watcher);
            readdirSync(dir).forEach((file) => {
                const fullPath = join(dir, file);
                if (statSync(fullPath).isDirectory() && !isExcludedWatchDirectory(file) && !file.startsWith(".")) {
                    watchRecursive(fullPath);
                }
            });
        } catch (error) {
            watchedDirs.delete(dir);
            reportDevWatcherIssue(`watch setup for ${dir}`, error);
        }
    };

    watchRecursive(watchDir);

    return {
        stop,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};

const createSSEResponse = (hub: DevReloadHub, signal: AbortSignal) => {
    const listeners: Array<() => void> = [];

    const stream = new ReadableStream({
        start: (controller) => {
            const send = (data: string) => controller.enqueue(`data: ${data}\n\n`);
            const timer = setInterval(() => controller.enqueue(":heartbeat\n\n"), 15000);

            const cleanup = () => {
                clearInterval(timer);
                listeners.forEach((unsubscribe) => unsubscribe());
                try {
                    if (controller.desiredSize !== null) {
                        controller.close();
                    }
                } catch {}
            };

            signal.addEventListener("abort", cleanup);
            listeners.push(hub.subscribe((data) => send(data)));
        },
    });

    return new Response(stream, {
        headers: {
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
        },
    });
};

const getRawRequestPathname = (requestUrl: string): string => {
    const schemeIndex = requestUrl.indexOf("://");
    const pathnameStart = schemeIndex === -1 ? requestUrl.indexOf("/") : requestUrl.indexOf("/", schemeIndex + 3);
    const pathnameWithQuery = pathnameStart === -1 ? "/" : requestUrl.slice(pathnameStart);
    const queryStart = pathnameWithQuery.search(/[?#]/);

    return queryStart === -1 ? pathnameWithQuery : pathnameWithQuery.slice(0, queryStart);
};

const isPathInsideRoot = (rootDir: string, targetPath: string): boolean => {
    const relativePath = relative(rootDir, targetPath);

    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
};

const resolveDevRequestPath = async (
    rootDir: string,
    rawPathname: string,
    prefix: string,
): Promise<Result<{ filePath: string; modulePath: string }>> => {
    const encodedPath = prefix === "/" ? rawPathname.slice(1) : rawPathname.slice(prefix.length);
    let decodedPath: string;

    try {
        decodedPath = decodeURIComponent(encodedPath);
    } catch {
        return fail("Rejected path");
    }

    const segments: string[] = [];
    for (const segment of decodedPath.replaceAll("\\", "/").split("/")) {
        if (segment.length === 0 || segment === ".") {
            continue;
        }

        if (segment === "..") {
            return fail("Rejected path");
        }

        segments.push(segment);
    }

    if (segments.length === 0) {
        return fail("Rejected path");
    }

    const modulePath = segments.join("/");
    const filePath = join(rootDir, modulePath);
    const pathStatus = (() => {
        try {
            return lstatSync(filePath);
        } catch {
            return undefined;
        }
    })();

    if (pathStatus?.isSymbolicLink()) {
        try {
            const realRootDir = realpathSync(rootDir);
            const realFilePath = realpathSync(filePath);
            if (!isPathInsideRoot(realRootDir, realFilePath)) {
                return fail("Rejected path");
            }

            return ok({ filePath, modulePath });
        } catch {
            return fail("Rejected path");
        }
    }

    if (!(await Bun.file(filePath).exists())) {
        return ok({ filePath, modulePath });
    }

    const realRootDir = realpathSync(rootDir);
    const realFilePath = realpathSync(filePath);
    if (!isPathInsideRoot(realRootDir, realFilePath)) {
        return fail("Rejected path");
    }

    return ok({ filePath, modulePath });
};

const findNodeModulesRoot = async (startDir: string): Promise<Result<string>> => {
    let current = startDir;

    while (true) {
        const candidate = join(current, "node_modules", "svelte", "package.json");
        if (await Bun.file(candidate).exists()) {
            return ok(join(current, "node_modules"));
        }

        const parent = dirname(current);
        if (parent === current) {
            return fail(`Unable to locate node_modules from ${startDir}`);
        }

        current = parent;
    }
};

const createImportMap = () => ({
    imports: {
        "esm-env": "/_virtual/esm-env.js",
        "svelte": "/_node_modules/svelte/src/index-client.js",
        "svelte/internal": "/_node_modules/svelte/src/internal/index.js",
        "svelte/internal/client": "/_node_modules/svelte/src/internal/client/index.js",
        "svelte/internal/disclose-version": "/_node_modules/svelte/src/internal/disclose-version.js",
    },
});

const loadRequiredText = async (path: string): Promise<Result<string>> => {
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

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

const createCssInjection = (modulePath: string, cssCode: string | undefined): string => {
    if (!cssCode) {
        return "";
    }

    return `
(() => {
    const id = "${modulePath}";
    if (!document.querySelector(\`style[data-svelte-id="\${id}"]\`)) {
        const style = document.createElement("style");
        style.setAttribute("data-svelte-id", id);
        style.textContent = \`${cssCode}\`;
        document.head.appendChild(style);
    }
})();`;
};

const compileSvelteForDev = async (rootDir: string, modulePath: string, shouldLog = false): Promise<Result<string>> => {
    const source = await loadRequiredText(join(rootDir, modulePath));
    if (!source.ok) {
        return source;
    }

    return Promise.resolve()
        .then(() =>
            compile(source.value, {
                dev: true,
                filename: modulePath,
                generate: "client",
            }),
        )
        .then(
            ({ css, js }) => {
                const contents = js.code + createCssInjection(modulePath, css?.code);
                if (shouldLog) {
                    logRecompiledAsset(modulePath, contents);
                }

                return ok(contents);
            },
            (error) => fail(`Failed to compile ${modulePath}: ${getErrorMessage(error)}`),
        );
};

const transpileTypeScriptForDev = async (rootDir: string, modulePath: string, shouldLog = false): Promise<Result<string>> => {
    const source = await loadRequiredText(join(rootDir, modulePath));
    if (!source.ok) {
        return source;
    }

    return Promise.resolve()
        .then(() => ok(tsTranspiler.transformSync(source.value)))
        .then((result) => {
            if (shouldLog) {
                logRecompiledAsset(modulePath, result.value);
            }

            return result;
        })
        .catch((error) => fail(`Failed to transpile ${modulePath}: ${getErrorMessage(error)}`));
};

const createServerHandle = (server: Bun.Server): DevServerHandle => ({
    port: server.port,
    stop: async () => {
        server.stop(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
    },
});

const resolveDevPort = (config: BuildSvelteOptions): number => config.port ?? 3000;

const createEphemeralPortCandidate = (): number => randomInt(DEV_PORT_RANGE_MIN, DEV_PORT_RANGE_MAX + 1);

const startServer = async (
    config: BuildSvelteOptions,
    fetch: Bun.Serve.Options["fetch"],
    error: Bun.Serve.Options["error"],
): Promise<Result<DevServerHandle>> => {
    const requestedPort = resolveDevPort(config);
    let attemptsRemaining = requestedPort === 0 ? DEV_PORT_RETRY_LIMIT : 1;

    while (attemptsRemaining > 0) {
        const nextPort = requestedPort === 0 ? createEphemeralPortCandidate() : requestedPort;

        const started = await Promise.resolve()
            .then(() =>
                ok(
                    createServerHandle(
                        Bun.serve({
                            error,
                            fetch,
                            port: nextPort,
                        }),
                    ),
                ),
            )
            .catch((startError: unknown) => {
                const errorCode = getErrorCode(startError);
                const errorMessage = getErrorMessage(startError);
                return fail(
                    errorCode === undefined
                        ? `Failed to start dev server: ${errorMessage}`
                        : `Failed to start dev server: ${errorCode}: ${errorMessage}`,
                );
            });
        if (started.ok) {
            return started;
        }

        attemptsRemaining -= 1;
        if (requestedPort !== 0 || !started.error.includes("EADDRINUSE") || attemptsRemaining === 0) {
            return started;
        }
    }

    return fail("Failed to start dev server.");
};

export const runConfiguredDevServer = async (cwd = process.cwd()): Promise<Result<DevServerHandle>> => {
    const config = await loadSvelteConfig(cwd);
    if (!config.ok) {
        return config;
    }

    const rootDir = config.value.rootDir ?? cwd;
    const mountId = config.value.mountId ?? "app";
    const appTitle = config.value.appTitle ?? "Bun Svelte Builder";
    const appComponentPath = resolveConfiguredPath(rootDir, config.value.appComponent, "src/App.svelte");
    const appComponentRelativeToRoot = relative(rootDir, appComponentPath);
    if (appComponentRelativeToRoot.startsWith("..") || isAbsolute(appComponentRelativeToRoot)) {
        return fail(`Invalid appComponent in bun-svelte-builder.config.ts: expected a path inside the project root.`);
    }
    const assetsDir = await resolveConfiguredAssetsDir(rootDir, config.value.assetsDir);
    if (!assetsDir.ok) {
        return assetsDir;
    }

    const nodeModulesRoot = await findNodeModulesRoot(rootDir);
    if (!nodeModulesRoot.ok) {
        return nodeModulesRoot;
    }

    const importMap = createImportMap();
    const reloadHub = createDevReloadHub(rootDir);

    const started = await startServer(
        config.value,
        async (req) => {
            const url = new URL(req.url);
            const rawPathname = getRawRequestPathname(req.url);

            if (url.pathname === "/") {
                const importMapScript = `<script type="importmap">${JSON.stringify(importMap)}</script>`;
                return new Response(createDevHtmlShell(importMapScript, mountId, appTitle), {
                    headers: { "Content-Type": "text/html" },
                });
            }

            if (url.pathname === "/main.ts") {
                return new Response(createBootstrapSource(createImportPath(rootDir, appComponentPath), mountId), {
                    headers: { "Content-Type": "application/javascript" },
                });
            }

            if (url.pathname === "/___live_reload") {
                return createSSEResponse(reloadHub, req.signal);
            }

            if (url.pathname === "/_virtual/esm-env.js") {
                return new Response("export const BROWSER = true; export const DEV = true; export const NODE = false;", {
                    headers: { "Content-Type": "application/javascript" },
                });
            }

            if (url.pathname.startsWith("/assets/")) {
                if (assetsDir.value === undefined) {
                    return new Response("Not Found", { status: 404 });
                }

                const requestedPath = url.pathname.slice("/assets/".length);
                if (requestedPath.length === 0) {
                    return new Response("Not Found", { status: 404 });
                }

                const resolvedAssetPath = await resolvePhysicalAssetPath(assetsDir.value, requestedPath);
                if (!resolvedAssetPath.ok) {
                    return new Response("Not Found", { status: 404 });
                }

                const assetFile = Bun.file(resolvedAssetPath.value);
                if (!statSync(resolvedAssetPath.value).isFile()) {
                    return new Response("Not Found", { status: 404 });
                }

                return new Response(assetFile);
            }

            if (rawPathname.startsWith("/_node_modules/")) {
                const resolvedNodeModulePath = await resolveDevRequestPath(nodeModulesRoot.value, rawPathname, "/_node_modules/");
                if (!resolvedNodeModulePath.ok) {
                    return new Response("Not Found", { status: 404 });
                }

                const nodeModuleFile = Bun.file(resolvedNodeModulePath.value.filePath);
                if (!(await nodeModuleFile.exists())) {
                    return new Response("Not Found", { status: 404 });
                }

                return new Response(nodeModuleFile);
            }

            if (rawPathname.endsWith(".ts")) {
                const resolvedSourcePath = await resolveDevRequestPath(rootDir, rawPathname, "/");
                if (!resolvedSourcePath.ok) {
                    return new Response("Not Found", { status: 404 });
                }

                const transpiled = await transpileTypeScriptForDev(rootDir, resolvedSourcePath.value.modulePath);
                if (!transpiled.ok) {
                    return transpiled.error.startsWith("Missing file:")
                        ? createNotFoundResponse()
                        : new Response(transpiled.error, { status: 500 });
                }

                return new Response(transpiled.value, {
                    headers: { "Content-Type": "application/javascript" },
                });
            }

            if (rawPathname.endsWith(".js")) {
                const resolvedSourcePath = await resolveDevRequestPath(rootDir, rawPathname, "/");
                if (!resolvedSourcePath.ok) {
                    return new Response("Not Found", { status: 404 });
                }

                const source = await loadRequiredText(resolvedSourcePath.value.filePath);
                if (!source.ok) {
                    return source.error.startsWith("Missing file:") ? createNotFoundResponse() : new Response(source.error, { status: 500 });
                }

                return new Response(source.value, {
                    headers: { "Content-Type": "application/javascript" },
                });
            }

            if (rawPathname.endsWith(".svelte")) {
                const resolvedSourcePath = await resolveDevRequestPath(rootDir, rawPathname, "/");
                if (!resolvedSourcePath.ok) {
                    return new Response("Not Found", { status: 404 });
                }

                const compiled = await compileSvelteForDev(rootDir, resolvedSourcePath.value.modulePath);
                if (!compiled.ok) {
                    return compiled.error.startsWith("Missing file:") ? createNotFoundResponse() : new Response(compiled.error, { status: 500 });
                }

                return new Response(compiled.value, {
                    headers: { "Content-Type": "application/javascript" },
                });
            }

            return new Response("Not Found", { status: 404 });
        },
        (error) => {
            console.error(error);
            return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
        },
    );

    if (!started.ok) {
        reloadHub.stop();
        return started;
    }

    return ok({
        port: started.value.port,
        stop: async () => {
            reloadHub.stop();
            await started.value.stop();
        },
    });
};
