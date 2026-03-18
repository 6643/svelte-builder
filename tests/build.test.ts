import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { createServer } from "node:net";
import { request } from "node:http";
import type { BuildSvelteOptions } from "../packages/bun-svelte-builder/src/build";

const createdDirs: string[] = [];
const EXAMPLE_ROOT = join(process.cwd(), "examples");
const EXAMPLE_SRC = join(EXAMPLE_ROOT, "src");
const EXAMPLE_ASSETS = join(EXAMPLE_ROOT, "assets");
let devTestChain: Promise<void> = Promise.resolve();

const importRootBuildModule = () => import("../build");
const importRootServerModule = () => import("../server");
const buildProduction = async (options?: BuildSvelteOptions) => (await importRootBuildModule()).buildProduction(options);

afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const runSequentialDevTest = async <T>(run: () => Promise<T>): Promise<T> => {
    const previous = devTestChain;
    let release: (() => void) | undefined;
    devTestChain = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous;
    try {
        return await run();
    } finally {
        release?.();
    }
};

const allocateFreePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (typeof address !== "object" || address === null) {
                server.close(() => reject(new Error("Failed to resolve an ephemeral dev port.")));
                return;
            }

            const port = address.port;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(port);
            });
        });
    });

const requestDevServerPath = async (port: number, path: string): Promise<{ body: string; status: number }> =>
    new Promise((resolve, reject) => {
        const req = request(
            {
                host: "127.0.0.1",
                method: "GET",
                path,
                port,
            },
            (res) => {
                const chunks: Buffer[] = [];

                res.on("data", (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                res.on("end", () => {
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        status: res.statusCode ?? 0,
                    });
                });
            },
        );

        req.on("error", reject);
        req.end();
    });

const createExpectedShortHash = (content: string, length: number): string =>
    createHash("sha256").update(content).digest("hex").slice(0, length);

const formatExpectedBinarySize = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const writeConfiguredBuildFixture = (
    rootDir: string,
    options: { assetsDirLine: string; appColor: string; appTitle: string },
): void => {
    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            `<h1>${options.appTitle}</h1>`,
            "",
            "<style>",
            `  h1 { color: ${options.appColor}; }`,
            "</style>",
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    assetsDir: ${options.assetsDirLine},`,
            "});",
        ]
            .filter((line): line is string => line !== null)
            .join("\n"),
    );
};

const writeRuntimeAwareFixture = (
    rootDir: string,
    options: { mountIdLine?: string; appTitleLine?: string; outDirLine?: string } = {},
): void => {
    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>runtime</h1>", "", "<style>", "  h1 { color: teal; }", "</style>"].join("\n"),
    );

    if (options.mountIdLine !== undefined || options.appTitleLine !== undefined || options.outDirLine !== undefined) {
        writeFileSync(
            join(rootDir, "bun-svelte-builder.config.ts"),
            [
                'import { defineSvelteConfig } from "bun-svelte-builder";',
                "",
                "export default defineSvelteConfig({",
                options.mountIdLine === undefined ? null : `    mountId: ${options.mountIdLine},`,
                options.appTitleLine === undefined ? null : `    appTitle: ${options.appTitleLine},`,
                options.outDirLine === undefined ? null : `    outDir: ${options.outDirLine},`,
                "});",
            ]
                .filter((line): line is string => line !== null)
                .join("\n"),
        );
    }
};

const writeConfiguredDevFixture = (
    rootDir: string,
    options: { assetsDirLine?: string; portLine?: string },
): void => {
    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>dev</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            options.assetsDirLine === undefined ? null : `    assetsDir: ${options.assetsDirLine},`,
            options.portLine ?? "    port: 61113,",
            "});",
        ]
            .filter((line): line is string => line !== null)
            .join("\n"),
    );
};

const expectFileBytesEqual = (path: string, expected: Uint8Array): void => {
    expect(readFileSync(path)).toEqual(Buffer.from(expected));
};

test("buildProduction emits hashed js, hashed css, and index.html that references both", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-build-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "src", "lazy.ts"),
        ['export const lazyValue = "lazy";', "export default () => lazyValue;"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            "<script>",
            "  let count = $state(0);",
            '  const loadLazy = async () => {',
            '    globalThis.__loadLazy = () => import("./lazy.ts");',
            '    await import("./lazy.ts");',
            "  };",
            "</script>",
            "",
            '<button onclick={loadLazy}>load lazy</button>',
            "",
            "<button onclick={() => count++}>count {count}</button>",
            "",
            "<style>",
            "  button { color: tomato; }",
            "</style>",
        ].join("\n"),
    );

    const result = await buildProduction({ rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const outputFiles = readdirSync(result.value.outDir).sort();
    const entryJs = result.value.jsFile;
    const hashedJs = outputFiles.find((file) => file === entryJs);
    const hashedCss = outputFiles.find((file) => /^[a-f0-9]{16}\.css$/.test(file));
    const jsFiles = outputFiles.filter((file) => /^[a-f0-9]{16}\.js$/.test(file));
    const html = readFileSync(join(result.value.outDir, "index.html"), "utf8");

    expect(hashedJs).toBeDefined();
    expect(hashedCss).toBeDefined();
    expect(jsFiles.length).toBeGreaterThanOrEqual(2);

    const jsHashLength = hashedJs!.replace(/\.js$/, "").length;
    const cssHashLength = hashedCss!.replace(/\.css$/, "").length;
    const cssContents = readFileSync(join(result.value.outDir, hashedCss!), "utf8");
    const entryJsContents = readFileSync(join(result.value.outDir, entryJs), "utf8");
    const expectedCss = `${createExpectedShortHash(cssContents, jsHashLength)}.css`;
    const referencedJs = Array.from(
        entryJsContents.matchAll(/["'](?:\.\/)?([^"']+\.js)["']/g),
        (match) => match[1]?.split("/").pop()!,
    );

    expect(jsHashLength).toBe(16);
    expect(cssHashLength).toBe(jsHashLength);
    expect(hashedCss).toBe(expectedCss);
    expect(referencedJs.length).toBeGreaterThanOrEqual(1);
    for (const referencedFile of referencedJs) {
        expect(jsFiles).toContain(referencedFile);
    }
    expect(html).toContain(`<script type="module" src="/${entryJs}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="/${hashedCss}">`);
    expect(cssContents).toContain("color: tomato");
    expect(cssContents).not.toContain(".svelte-");
    expect(cssContents).toMatch(/\._[a-z0-9]+/);
    expect(entryJsContents).not.toContain("svelte-");
    expect(entryJsContents).toMatch(/class=\"_[a-z0-9]+\"/);
});

test("root build and server entrypoints are importable wrapper modules", async () => {
    const buildModule = await importRootBuildModule();

    expect(typeof buildModule.buildProduction).toBe("function");

    const serverModule = await importRootServerModule();

    expect(typeof serverModule.serveDevelopment).toBe("function");
});

test("real demo app emits multiple lazy-loaded js chunks", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-app-"));
    createdDirs.push(rootDir);

    cpSync(EXAMPLE_SRC, join(rootDir, "src"), { recursive: true });
    cpSync(EXAMPLE_ASSETS, join(rootDir, "assets"), { recursive: true });

    const result = await buildProduction({ rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const outputFiles = readdirSync(result.value.outDir).sort();
    const jsFiles = outputFiles.filter((file) => /^[a-f0-9]{16}\.js$/.test(file));
    const jsContents = jsFiles.map((file) => readFileSync(join(result.value.outDir, file), "utf8"));
    const bundledCode = jsContents.join("\n");

    expect(jsFiles.length).toBeGreaterThanOrEqual(3);
    expect(bundledCode).not.toContain("Intl.DateTimeFormat");
    expect(bundledCode).toContain("Svelte error");
    expect(bundledCode).toContain("A derived value cannot reference itself recursively");
});

test("example workspace package contains the canonical demo source tree", async () => {
    expect(await Bun.file(join(EXAMPLE_SRC, "App.svelte")).exists()).toBe(true);
    expect(await Bun.file(join(EXAMPLE_ROOT, "main.ts")).exists()).toBe(false);
    expect(await Bun.file(join(EXAMPLE_SRC, "index.html")).exists()).toBe(false);
    expect(await Bun.file(join(EXAMPLE_ASSETS, "panel-mark.svg")).exists()).toBe(true);
    expect(await Bun.file(join(EXAMPLE_ROOT, "build.ts")).exists()).toBe(false);
    expect(await Bun.file(join(EXAMPLE_ROOT, "server.ts")).exists()).toBe(false);

    const configSource = readFileSync(join(EXAMPLE_ROOT, "bun-svelte-builder.config.ts"), "utf8");
    const appSource = readFileSync(join(EXAMPLE_SRC, "App.svelte"), "utf8");

    expect(configSource).toContain('assetsDir: "assets"');
    expect(configSource).toContain('appComponent: "src/App.svelte"');
    expect(configSource).toContain('appTitle: "Bun Svelte Builder"');
    expect(configSource).toContain('mountId: "app"');
    expect(appSource).toContain('src="/assets/panel-mark.svg"');
});

test("bootstrap module source defaults appComponent and mounts to the configured id", async () => {
    const { createBootstrapModuleSource } = await import("../packages/bun-svelte-builder/src/bootstrap.ts");
    const defaultSource = createBootstrapModuleSource();
    const customSource = createBootstrapModuleSource("src/Custom.svelte", "root");

    expect(defaultSource).toContain('import App from "./src/App.svelte"');
    expect(defaultSource).toContain('document.getElementById("app")');
    expect(customSource).toContain('import App from "src/Custom.svelte"');
    expect(customSource).toContain('document.getElementById("root")');
});

test("dev watcher dedupes repeated events for the same file within the debounce window", async () => {
    const { shouldProcessDevWatchEvent } = await import("../packages/bun-svelte-builder/src/dev.ts");

    expect(shouldProcessDevWatchEvent(new Map(), "src/App.svelte", 1000)).toBe(true);

    const recentEvents = new Map<string, number>([["src/App.svelte", 1000]]);

    expect(shouldProcessDevWatchEvent(recentEvents, "src/App.svelte", 1005)).toBe(false);
    expect(shouldProcessDevWatchEvent(recentEvents, "src/helper.js", 1005)).toBe(true);
    expect(shouldProcessDevWatchEvent(recentEvents, "src/App.svelte", 1200)).toBe(true);
});

test("dev watcher surfaces non-trivial errors and ignores transient missing-file races", async () => {
    const { formatDevWatcherIssue } = await import("../packages/bun-svelte-builder/src/dev.ts");

    expect(formatDevWatcherIssue("compile", Object.assign(new Error("gone"), { code: "ENOENT" }))).toBeUndefined();
    expect(formatDevWatcherIssue("watch setup", new Error("permission denied"))).toContain("watch setup");
    expect(formatDevWatcherIssue("watch setup", new Error("permission denied"))).toContain("permission denied");
});

test("dev watcher runtime error handler reports non-trivial watcher failures", async () => {
    const { attachDevWatcherErrorHandler } = await import("../packages/bun-svelte-builder/src/dev.ts");
    const warnings: string[] = [];
    const handlers = new Map<string, (error: unknown) => void>();
    const watcher = {
        on(event: string, handler: (error: unknown) => void) {
            handlers.set(event, handler);
            return undefined;
        },
    };
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((value) => String(value)).join(" "));
    };

    try {
        attachDevWatcherErrorHandler(watcher, "watch runtime for src");
        handlers.get("error")?.(new Error("watch backend failed"));
    } finally {
        console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("watch runtime for src");
    expect(warnings[0]).toContain("watch backend failed");
});

test("runtime module source embeds the configured mount id and helper behavior", async () => {
    const { createRuntimeModuleSource, getMountTarget } = await import("../packages/bun-svelte-builder/src/runtime.ts");
    const runtimeTarget = { id: "app" };
    const scope = {
        getElementById: (id: string) => (id === "app" ? runtimeTarget : null),
    };

    const source = createRuntimeModuleSource("app");

    expect(source).toContain('const mountId = "app"');
    expect(source).toContain("getElementById(mountId)");
    expect(getMountTarget(scope, "app")).toBe(runtimeTarget);

    expect(() => getMountTarget(scope, "#app")).toThrow();
});

test("package entry exports buildSvelte for reusable builds", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-package-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>pkg</h1>", "", "<style>", "  h1 { color: seagreen; }", "</style>"].join("\n"),
    );

    const { buildSvelte, defineSvelteConfig, formatBuildReport, runConfiguredBuild, runConfiguredDevServer } =
        await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await buildSvelte({ rootDir });

    expect(result.ok).toBe(true);
    expect(typeof defineSvelteConfig).toBe("function");
    expect(typeof formatBuildReport).toBe("function");
    expect(typeof runConfiguredBuild).toBe("function");
    expect(typeof runConfiguredDevServer).toBe("function");

    if (!result.ok) {
        throw new Error(result.error);
    }

    const outputFiles = readdirSync(result.value.outDir).sort();

    expect(outputFiles.some((file) => /^[a-f0-9]{16}\.js$/.test(file))).toBe(true);
    expect(outputFiles.some((file) => /^[a-f0-9]{16}\.css$/.test(file))).toBe(true);
    expect(outputFiles).toContain("index.html");
});

test("buildSvelte generates the bootstrap module and respects mountId", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-mount-target-build-"));
    createdDirs.push(rootDir);

    writeRuntimeAwareFixture(rootDir);
    expect(existsSync(join(rootDir, "main.ts"))).toBe(false);

    const { buildSvelte } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await buildSvelte({ mountId: "app", rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const html = readFileSync(join(result.value.outDir, result.value.htmlFile), "utf8");
    const js = readFileSync(join(result.value.outDir, result.value.jsFile), "utf8");

    expect(html).toContain('<main id="app"></main>');
    expect(js).toContain('getElementById("app")');
    expect(js).toContain("runtime");
    expect(js).not.toContain("Missing mount id");
});

test("buildSvelte rejects invalid mountId values", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-mount-target-invalid-"));
    createdDirs.push(rootDir);

    writeRuntimeAwareFixture(rootDir);

    const { buildSvelte } = await import("../packages/bun-svelte-builder/src/index.ts");

    for (const mountId of ["", "   ", "#app", ".root"]) {
        const result = await buildSvelte({ mountId, rootDir });

        expect(result.ok).toBe(false);

        if (result.ok) {
            throw new Error(`Expected mountId ${JSON.stringify(mountId)} to be rejected`);
        }

        expect(result.error).toContain("mountId");
    }
});

test("buildSvelte rejects invalid appComponent values", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsp-app-component-invalid-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    writeFileSync(join(rootDir, "src", "App.svelte"), "<h1>app component</h1>");

    const { buildSvelte } = await import("../packages/bun-svelte-builder/src/index.ts");

    for (const appComponent of ["", "   ", 42] as const) {
        const result = await buildSvelte({ appComponent: appComponent as string, rootDir });

        expect(result.ok).toBe(false);

        if (result.ok) {
            throw new Error(`Expected appComponent ${JSON.stringify(appComponent)} to be rejected`);
        }

        expect(result.error).toContain("appComponent");
    }
});

test("formatBuildReport lists entry asset sizes and gzip sizes", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-report-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>report</h1>", "", "<style>", "  h1 { color: darkorange; }", "</style>"].join("\n"),
    );

    const result = await buildProduction({ rootDir });
    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const { formatBuildReport } = await import("../packages/bun-svelte-builder/src/index.ts");
    const assets = [result.value.jsFile, result.value.cssFile, result.value.htmlFile].map((file) => {
        const buffer = readFileSync(join(result.value.outDir, file));

        return {
            file,
            gzip: gzipSync(buffer).byteLength,
            size: buffer.byteLength,
        };
    });
    const report = formatBuildReport(result.value);
    const lines = report.split("\n");
    const listedFiles = lines.flatMap((line) => assets.filter((asset) => line.includes(asset.file)).map((asset) => asset.file));

    expect(report).toContain("Entry assets");
    expect(report).toContain("Size");
    expect(report).toContain("Gzip");
    expect(report).not.toContain("Size(bytes)");
    expect(report).not.toContain("Gzip(bytes)");
    expect(report).not.toContain("Time");
    expect(report).not.toContain("Total");
    expect(listedFiles).toEqual([result.value.jsFile, result.value.cssFile, result.value.htmlFile]);

    for (const asset of assets) {
        const line = lines.find((value) => value.includes(asset.file));
        expect(line).toBeDefined();
        expect(line).toContain(formatExpectedBinarySize(asset.size));
        expect(line).toContain(formatExpectedBinarySize(asset.gzip));
    }
});

test("runConfiguredBuild produces the same entry assets across invocation cwd", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-stable-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });
    mkdirSync(join(rootDir, "src", "lazy"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            "<script>",
            '  import { onMount } from "svelte";',
            "  let Lazy = $state(null);",
            "  onMount(async () => {",
            '    const mod = await import("./lazy/View.svelte");',
            "    Lazy = mod.default;",
            "  });",
            "</script>",
            "",
            "{#if Lazy}",
            "  <svelte:component this={Lazy} />",
            "{:else}",
            "  <p>loading</p>",
            "{/if}",
            "",
            "<style>",
            "  p { color: teal; }",
            "</style>",
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "lazy", "View.svelte"),
        ["<h2>lazy</h2>", "", "<style>", "  h2 { color: tomato; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            "});",
        ].join("\n"),
    );

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const first = await runConfiguredBuild(rootDir);
    expect(first.ok).toBe(true);

    if (!first.ok) {
        throw new Error(first.error);
    }

    const firstHtml = readFileSync(join(first.value.outDir, first.value.htmlFile), "utf8");
    const packageEntryUrl = pathToFileURL(join(process.cwd(), "packages", "bun-svelte-builder", "src", "index.ts")).href;
    const script = [
        `const mod = await import(${JSON.stringify(packageEntryUrl)});`,
        "const result = await mod.runConfiguredBuild(process.cwd());",
        "if (!result.ok) {",
        "  console.error(result.error);",
        "  process.exit(1);",
        "}",
        "console.log(JSON.stringify(result.value));",
    ].join("\n");
    const second = spawnSync(process.execPath, ["--eval", script], {
        cwd: rootDir,
        encoding: "utf8",
    });

    expect(second.status).toBe(0);

    const secondOutput = second.stdout.trim().split("\n").pop();
    expect(secondOutput).toBeDefined();

    const secondArtifacts = JSON.parse(secondOutput!) as { cssFile: string; htmlFile: string; jsFile: string; outDir: string };
    const secondHtml = readFileSync(join(secondArtifacts.outDir, secondArtifacts.htmlFile), "utf8");

    expect(secondArtifacts.jsFile).toBe(first.value.jsFile);
    expect(secondArtifacts.cssFile).toBe(first.value.cssFile);
    expect(secondArtifacts.htmlFile).toBe(first.value.htmlFile);
    expect(secondHtml).toBe(firstHtml);
});

test("runConfiguredBuild loads bun-svelte-builder.config.ts and custom outDir", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-config-"));
    createdDirs.push(rootDir);

    writeRuntimeAwareFixture(rootDir, {
        mountIdLine: '"app"',
        appTitleLine: '"Custom Build Title"',
        outDirLine: '"public"',
    });

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const outputFiles = readdirSync(result.value.outDir).sort();
    const html = readFileSync(join(result.value.outDir, "index.html"), "utf8");

    expect(result.value.outDir).toBe(join(rootDir, "public"));
    expect(outputFiles.some((file) => /^[a-f0-9]{16}\.js$/.test(file))).toBe(true);
    expect(outputFiles.some((file) => /^[a-f0-9]{16}\.css$/.test(file))).toBe(true);
    expect(html).toContain("<title>Custom Build Title</title>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<main id="app"></main>');
});

test("runConfiguredBuild ignores rootDir in bun-svelte-builder.config.ts", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-config-root-"));
    const ignoredRootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-config-ignored-root-"));
    createdDirs.push(rootDir, ignoredRootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>ignored rootDir</h1>", "", "<style>", "  h1 { color: seagreen; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            '    outDir: "public",',
            `    rootDir: ${JSON.stringify(ignoredRootDir)},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.value.outDir).toBe(join(rootDir, "public"));
});

test("runConfiguredBuild rejects selector-shaped mountId in config", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-config-mount-target-invalid-"));
    createdDirs.push(rootDir);

    writeRuntimeAwareFixture(rootDir, {
        mountIdLine: '"#app"',
        outDirLine: '"public"',
    });

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected runConfiguredBuild to reject selector-shaped mountId in config");
    }

    expect(result.error).toContain("mountId");
    expect(result.error).toMatch(/plain id token|selector-shaped/i);
});

test("runConfiguredBuild rejects htmlTemplate in config", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-html-template-config-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "static"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>Config Build</h1>", "", "<style>", "  h1 { color: plum; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            '    htmlTemplate: "static/index.html",',
            '    outDir: "public",',
            "});",
        ].join("\n"),
    );

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected runConfiguredBuild to reject htmlTemplate in config");
    }

    expect(result.error).toContain("htmlTemplate");
    expect(result.error).toMatch(/no longer supported/i);
});

test("buildProduction ignores src/index.html and uses the built-in html shell", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-built-file-template-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>file template</h1>", "", "<style>", "  h1 { color: seagreen; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "index.html"),
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN">',
            "<head>",
            '    <meta charset="UTF-8">',
            "    <title>Should Be Ignored</title>",
            "</head>",
            "<body>",
            '    <main id="ignored"></main>',
            "</body>",
            "</html>",
        ].join("\n"),
    );

    const result = await buildProduction({ rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const html = readFileSync(join(result.value.outDir, result.value.htmlFile), "utf8");

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Bun Svelte Builder</title>");
    expect(html).toContain('<main id="app"></main>');
    expect(html).not.toContain("Should Be Ignored");
    expect(html).not.toContain('id="ignored"');
});

test("buildProduction falls back to the built-in html shell when src/index.html is absent", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-built-in-shell-build-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>built-in shell</h1>", "", "<style>", "  h1 { color: seagreen; }", "</style>"].join("\n"),
    );

    const result = await buildProduction({ rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const html = readFileSync(join(result.value.outDir, result.value.htmlFile), "utf8");

    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Bun Svelte Builder</title>");
    expect(html).toContain('<main id="app"></main>');
});

test("runConfiguredBuild copies configured assets into dist/assets and keeps the hashed js entry in index.html", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-copy-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "assets", "icons"), { recursive: true });
    const logoBytes = Uint8Array.from([0x00, 0x13, 0x7f, 0x80, 0xff, 0x2f]);

    writeConfiguredBuildFixture(rootDir, {
        assetsDirLine: '"assets"',
        appColor: "forestgreen",
        appTitle: "assets",
    });

    writeFileSync(join(rootDir, "assets", "logo.svg"), logoBytes);
    writeFileSync(join(rootDir, "assets", "icons", "check.txt"), "checked");

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const html = readFileSync(join(result.value.outDir, result.value.htmlFile), "utf8");
    const distAssetsDir = join(rootDir, "dist", "assets");

    expect(result.value.outDir).toBe(join(rootDir, "dist"));
    expect(existsSync(join(distAssetsDir, "logo.svg"))).toBe(true);
    expect(existsSync(join(distAssetsDir, "icons", "check.txt"))).toBe(true);
    expectFileBytesEqual(join(distAssetsDir, "logo.svg"), logoBytes);
    expect(readFileSync(join(distAssetsDir, "icons", "check.txt"), "utf8")).toBe(
        readFileSync(join(rootDir, "assets", "icons", "check.txt"), "utf8"),
    );
    expect(html).toMatch(new RegExp(`<script[^>]*src="/${result.value.jsFile}"`));
});

test("buildSvelte copies assets from the default assets directory when assetsDir is omitted", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-default-assets-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets", "icons"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>default assets</h1>", "", "<style>", "  h1 { color: teal; }", "</style>"].join("\n"),
    );

    writeFileSync(join(rootDir, "assets", "logo.svg"), "logo-default");
    writeFileSync(join(rootDir, "assets", "icons", "check.txt"), "default-check");

    const { buildSvelte } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await buildSvelte({ rootDir });

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const distAssetsDir = join(rootDir, "dist", "assets");

    expect(existsSync(join(distAssetsDir, "logo.svg"))).toBe(true);
    expect(readFileSync(join(distAssetsDir, "logo.svg"), "utf8")).toBe("logo-default");
    expect(readFileSync(join(distAssetsDir, "icons", "check.txt"), "utf8")).toBe("default-check");
});

test("runConfiguredBuild copies assets from an absolute assetsDir path", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-absolute-root-"));
    const assetsRoot = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-absolute-dir-"));
    createdDirs.push(rootDir, assetsRoot);

    mkdirSync(join(assetsRoot, "nested"), { recursive: true });

    const logoBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

    writeConfiguredBuildFixture(rootDir, {
        assetsDirLine: JSON.stringify(assetsRoot),
        appColor: "steelblue",
        appTitle: "absolute assets",
    });

    writeFileSync(join(assetsRoot, "logo.svg"), logoBytes);
    writeFileSync(join(assetsRoot, "nested", "check.txt"), "absolute-check");

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const distAssetsDir = join(rootDir, "dist", "assets");

    expect(result.value.outDir).toBe(join(rootDir, "dist"));
    expectFileBytesEqual(join(distAssetsDir, "logo.svg"), logoBytes);
    expect(readFileSync(join(distAssetsDir, "nested", "check.txt"), "utf8")).toBe(
        readFileSync(join(assetsRoot, "nested", "check.txt"), "utf8"),
    );
});

test("runConfiguredBuild fails when the configured assetsDir is missing", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-missing-"));
    createdDirs.push(rootDir);

    writeConfiguredBuildFixture(rootDir, {
        assetsDirLine: '"missing-assets"',
        appColor: "chocolate",
        appTitle: "missing assets",
    });

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected build to fail when the configured assets directory is missing");
    }

    expect(result.error).toMatch(/missing configured assets directory/i);
    expect(result.error).toContain("missing-assets");
});

test("runConfiguredBuild rejects assetsDir that would recurse into the build output tree", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-recursive-"));
    createdDirs.push(rootDir);

    writeConfiguredBuildFixture(rootDir, {
        assetsDirLine: '"."',
        appColor: "slateblue",
        appTitle: "recursive assets",
    });

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected build to reject assetsDir that overlaps with the build output tree");
    }

    expect(result.error).toMatch(/configured assets directory overlaps the build output tree/i);
    expect(result.error).not.toContain("ENAMETOOLONG");
});

test("runConfiguredBuild rejects a symlinked assetsDir that resolves into the project tree", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-assets-symlink-"));
    createdDirs.push(rootDir);

    symlinkSync(rootDir, join(rootDir, "assets-link"), "dir");

    writeConfiguredBuildFixture(rootDir, {
        assetsDirLine: '"assets-link"',
        appColor: "darkcyan",
        appTitle: "symlink assets",
    });

    const { runConfiguredBuild } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredBuild(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected build to reject symlinked assetsDir that resolves into the project tree");
    }

    expect(result.error).toMatch(/configured assets directory overlaps the build output tree/i);
    expect(result.error).not.toContain("ENAMETOOLONG");
});

test("buildProduction fails when a live dist.lock owned by an active pid exists", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-live-lock-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });
    mkdirSync(join(rootDir, "dist"), { recursive: true });
    mkdirSync(join(rootDir, "dist.lock"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>locked</h1>", "", "<style>", "  h1 { color: firebrick; }", "</style>"].join("\n"),
    );

    writeFileSync(join(rootDir, "dist", "sentinel.txt"), "keep-me");
    writeFileSync(join(rootDir, "dist.lock", "owner.json"), JSON.stringify({ pid: process.pid }));

    const result = await buildProduction({ rootDir });

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected build to fail while a live lock is held");
    }

    expect(result.error).toContain("already running");
    expect(readFileSync(join(rootDir, "dist", "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(rootDir, "dist.lock", "owner.json"))).toBe(true);
});

test("buildProduction recovers a corrupted dist.lock owner.json and completes build", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-incomplete-lock-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });
    mkdirSync(join(rootDir, "dist"), { recursive: true });
    mkdirSync(join(rootDir, "dist.lock"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>partial-lock</h1>", "", "<style>", "  h1 { color: tomato; }", "</style>"].join("\n"),
    );

    writeFileSync(join(rootDir, "dist", "sentinel.txt"), "keep-me");
    writeFileSync(join(rootDir, "dist.lock", "owner.json"), "{");

    const run = buildProduction({ rootDir });
    const thrown = await run.then(
        () => null,
        (error) => error,
    );

    expect(thrown).toBe(null);

    const result = await run;
    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(existsSync(join(rootDir, "dist.lock"))).toBe(false);
    expect(readFileSync(join(rootDir, "dist", result.value.htmlFile), "utf8")).toContain(result.value.jsFile);
});

test("buildProduction recovers a stale lock and converts symlink dist back to a real directory", async () => {
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-stale-lock-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });
    mkdirSync(join(rootDir, ".bsp-releases", "old-release"), { recursive: true });
    mkdirSync(join(rootDir, "dist.lock"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>migrate</h1>", "", "<style>", "  h1 { color: rebeccapurple; }", "</style>"].join("\n"),
    );

    writeFileSync(join(rootDir, ".bsp-releases", "old-release", "sentinel.txt"), "legacy-dist");
    symlinkSync(".bsp-releases/old-release", join(rootDir, "dist"));
    writeFileSync(join(rootDir, "dist.lock", "owner.json"), JSON.stringify({ pid: 999999 }));

    const result = await buildProduction({ rootDir });
    expect(result.ok).toBe(true);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const distPath = join(rootDir, "dist");
    expect(lstatSync(distPath).isDirectory()).toBe(true);
    expect(lstatSync(distPath).isSymbolicLink()).toBe(false);
    expect(existsSync(join(rootDir, "dist.lock"))).toBe(false);
    expect(existsSync(join(rootDir, ".bsp-releases"))).toBe(false);
    expect(readFileSync(join(distPath, result.value.htmlFile), "utf8")).toContain(result.value.jsFile);
});

test("runConfiguredDevServer rejects htmlTemplate in config", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-html-template-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>dev htmlTemplate</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            '    htmlTemplate: "static/index.html",',
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected runConfiguredDevServer to reject htmlTemplate in config");
    }

    expect(result.error).toContain("htmlTemplate");
    expect(result.error).toMatch(/no longer supported/i);
    }));

test("runConfiguredDevServer ignores src/index.html and injects the import map", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-file-template-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>dev file template</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "index.html"),
        [
            "<!DOCTYPE html>",
            '<html lang="zh-CN">',
            "<head>",
            '    <meta charset="UTF-8">',
            "    <title>Should Be Ignored</title>",
            "</head>",
            "<body>",
            '    <main id="ignored"></main>',
            "</body>",
            "</html>",
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.ok).toBe(true);

    const response = await fetch(`http://127.0.0.1:${result.value.port}/`);
    const html = await response.text();

    await result.value.stop();

    expect(response.ok).toBe(true);
    expect(html).toContain("<title>Bun Svelte Builder</title>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<main id="app"></main>');
    expect(html).toContain('<script type="importmap">');
    expect(html).not.toContain("Should Be Ignored");
    expect(html).not.toContain('id="ignored"');
    }));

test("runConfiguredDevServer serves the built-in html shell and injects the import map", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-built-in-shell-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>dev built-in shell</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.ok).toBe(true);

    const response = await fetch(`http://127.0.0.1:${result.value.port}/`);
    const html = await response.text();

    await result.value.stop();

    expect(response.ok).toBe(true);
    expect(html).toContain("<title>Bun Svelte Builder</title>");
    expect(html).toContain('<main id="app"></main>');
    expect(html).toContain('<script type="importmap">');
    }));

test("runConfiguredDevServer escapes appTitle in the dev html shell", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-escaped-title-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>escaped title</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            '    appTitle: "<script>alert(1)</script> & demo",',
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const response = await fetch(`http://127.0.0.1:${result.value.port}/`);
    const html = await response.text();

    await result.value.stop();

    expect(response.ok).toBe(true);
    expect(html).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt; &amp; demo</title>");
    expect(html).not.toContain("<title><script>alert(1)</script> & demo</title>");
    expect(html).toContain('<main id="app"></main>');
    expect(html).toContain('<script type="importmap">');
    }));

test("runConfiguredDevServer serves a generated bootstrap module without main.ts", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-bootstrap-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(join(rootDir, "src", "App.svelte"), "<h1>app</h1>");
    writeFileSync(join(rootDir, "src", "Alt.svelte"), "<h1>alt</h1>");

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            '    appComponent: "src/Alt.svelte",',
            '    mountId: "root",',
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    expect(existsSync(join(rootDir, "main.ts"))).toBe(false);

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const response = await fetch(`http://127.0.0.1:${result.value.port}/main.ts`);
    const source = await response.text();

    await result.value.stop();

    expect(response.ok).toBe(true);
    expect(source).toContain('import App from "./src/Alt.svelte"');
    expect(source).toContain('document.getElementById("root")');
    }));

test("runConfiguredDevServer logs a recompiled asset report for changed components", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-compile-report-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "src", "lazy"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        ["<h1>dev compile report</h1>", "", "<style>", "  h1 { color: coral; }", "</style>"].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "lazy", "ButtonDemo.svelte"),
        [
            "<script>",
            "  const checks = [",
            '    "点击前不会进入首屏 bundle",',
            '    "触发时才请求独立 chunk",',
            '    "适合低频但交互明确的能力",',
            "  ];",
            "</script>",
            "",
            '<div class="card">',
            "  <h3>按钮懒加载成功!</h3>",
            "  <p>这个组件只会在用户主动点击后才下载。</p>",
            "",
            "  <ul>",
            "    {#each checks as item}",
            "      <li>{item}</li>",
            "    {/each}",
            "  </ul>",
            "</div>",
            "",
            "<style>",
            "  .card {",
            "    background: linear-gradient(180deg, #1f2430 0%, #343b4d 100%);",
            "    border-radius: 20px;",
            "    color: #f7f1e4;",
            "    padding: 18px;",
            "  }",
            "",
            "  h3 {",
            "    margin: 0 0 8px;",
            "    font-size: 22px;",
            "  }",
            "",
            "  p {",
            "    margin: 0 0 12px;",
            "    color: rgba(247, 241, 228, 0.8);",
            "  }",
            "",
            "  ul {",
            "    margin: 0;",
            "    padding-left: 18px;",
            "  }",
            "",
            "  li + li {",
            "    margin-top: 8px;",
            "  }",
            "</style>",
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
        writeFileSync(
            join(rootDir, "src", "lazy", "ButtonDemo.svelte"),
            [
                "<script>",
                "  const checks = [",
                '    "点击前不会进入首屏 bundle",',
                '    "触发时才请求独立 chunk",',
                '    "适合低频但交互明确的能力",',
                '    "watch triggered",',
                "  ];",
                "</script>",
                "",
                '<div class="card">',
                "  <h3>按钮懒加载成功!</h3>",
                "  <p>这个组件只会在用户主动点击后才下载。</p>",
                "",
                "  <ul>",
                "    {#each checks as item}",
                "      <li>{item}</li>",
                "    {/each}",
                "  </ul>",
                "</div>",
                "",
                "<style>",
                "  .card {",
                "    background: linear-gradient(180deg, #1f2430 0%, #343b4d 100%);",
                "    border-radius: 20px;",
                "    color: #f7f1e4;",
                "    padding: 18px;",
                "  }",
                "",
                "  h3 {",
                "    margin: 0 0 8px;",
                "    font-size: 22px;",
                "  }",
                "",
                "  p {",
                "    margin: 0 0 12px;",
                "    color: rgba(247, 241, 228, 0.8);",
                "  }",
                "",
                "  ul {",
                "    margin: 0;",
                "    padding-left: 18px;",
                "  }",
                "",
                "  li + li {",
                "    margin-top: 8px;",
                "  }",
                "</style>",
            ].join("\n"),
        );

        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 4000;
            const timer = setInterval(() => {
                const log = logs.join("\n");
                if (log.includes("Recompiled assets") && log.includes("src/lazy/ButtonDemo.svelte")) {
                    clearInterval(timer);
                    resolve();
                    return;
                }

                if (Date.now() > deadline) {
                    clearInterval(timer);
                    reject(new Error(`Timed out waiting for compile report. Logs:\n${log}`));
                }
            }, 25);
        });

        const log = logs.join("\n");
        expect(log).toContain("Recompiled assets");
        expect(log).toContain("src/lazy/ButtonDemo.svelte");
        expect(log).toContain("Time");
        expect(log).toContain("Size");
        expect(log).toContain("Gzip");
        expect(log).not.toContain("Total");
        expect(log).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    } finally {
        console.log = originalLog;
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer logs only the changed component and excludes untouched sibling files", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-single-file-report-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src", "lazy"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            "<script>",
            '  import ButtonDemo from "./lazy/ButtonDemo.svelte";',
            '  import CardDemo from "./lazy/CardDemo.svelte";',
            "</script>",
            "",
            "<ButtonDemo />",
            "<CardDemo />",
        ].join("\n"),
    );

    writeFileSync(join(rootDir, "src", "lazy", "ButtonDemo.svelte"), "<button>one</button>");
    writeFileSync(join(rootDir, "src", "lazy", "CardDemo.svelte"), "<section>two</section>");

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
        writeFileSync(join(rootDir, "src", "lazy", "ButtonDemo.svelte"), "<button>updated</button>");

        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 4000;
            const timer = setInterval(() => {
                const log = logs.join("\n");
                if (log.includes("Recompiled assets") && log.includes("src/lazy/ButtonDemo.svelte")) {
                    clearInterval(timer);
                    resolve();
                    return;
                }

                if (Date.now() > deadline) {
                    clearInterval(timer);
                    reject(new Error(`Timed out waiting for single-file compile report. Logs:\n${log}`));
                }
            }, 25);
        });

        const log = logs.join("\n");

        expect(log).toContain("src/lazy/ButtonDemo.svelte");
        expect(log).not.toContain("src/lazy/CardDemo.svelte");
        expect(log).not.toContain("src/App.svelte");
    } finally {
        console.log = originalLog;
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer logs a recompiled asset report for changed JavaScript helpers", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-js-helper-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "src", "helper.js"),
        ['export const label = "one";'].join("\n"),
    );

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            "<script>",
            '  import { label } from "./helper.js";',
            "</script>",
            "",
            "<h1>{label}</h1>",
            "",
            "<style>",
            "  h1 { color: coral; }",
            "</style>",
        ].join("\n"),
    );

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
        const firstResponse = await fetch(`http://127.0.0.1:${result.value.port}/src/helper.js`);
        const firstSource = await firstResponse.text();

        expect(firstResponse.ok).toBe(true);
        expect(firstSource).toContain('export const label = "one"');

        writeFileSync(join(rootDir, "src", "helper.js"), ['export const label = "two";'].join("\n"));

        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 4000;
            const timer = setInterval(() => {
                const log = logs.join("\n");
                if (log.includes("Recompiled assets") && log.includes("src/helper.js")) {
                    clearInterval(timer);
                    resolve();
                    return;
                }

                if (Date.now() > deadline) {
                    clearInterval(timer);
                    reject(new Error(`Timed out waiting for helper.js compile report. Logs:\n${log}`));
                }
            }, 25);
        });

        const secondResponse = await fetch(`http://127.0.0.1:${result.value.port}/src/helper.js`);
        const secondSource = await secondResponse.text();
        const log = logs.join("\n");

        expect(secondResponse.ok).toBe(true);
        expect(secondSource).toContain('export const label = "two"');
        expect(log).toContain("Recompiled assets");
        expect(log).toContain("src/helper.js");
        expect(log).toContain("Time");
        expect(log).toContain("Size");
        expect(log).toContain("Gzip");
        expect(log).not.toContain("Total");
    } finally {
        console.log = originalLog;
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer watches directories whose names only contain excluded directory substrings", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-dist-substring-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src", "distilled"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "src", "App.svelte"),
        [
            "<script>",
            '  import { label } from "./distilled/helper.js";',
            "</script>",
            "",
            "<h1>{label}</h1>",
        ].join("\n"),
    );
    writeFileSync(join(rootDir, "src", "distilled", "helper.js"), 'export const label = "before";');

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
        writeFileSync(join(rootDir, "src", "distilled", "helper.js"), 'export const label = "after";');

        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 4000;
            const timer = setInterval(() => {
                const log = logs.join("\n");
                if (log.includes("Recompiled assets") && log.includes("src/distilled/helper.js")) {
                    clearInterval(timer);
                    resolve();
                    return;
                }

                if (Date.now() > deadline) {
                    clearInterval(timer);
                    reject(new Error(`Timed out waiting for substring directory compile report. Logs:\n${log}`));
                }
            }, 25);
        });

        const response = await fetch(`http://127.0.0.1:${result.value.port}/src/distilled/helper.js`);
        const source = await response.text();
        const log = logs.join("\n");

        expect(response.ok).toBe(true);
        expect(source).toContain('export const label = "after"');
        expect(log).toContain("src/distilled/helper.js");
    } finally {
        console.log = originalLog;
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer watches directories created after startup", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-new-directory-"));
    createdDirs.push(rootDir);

    mkdirSync(join(rootDir, "src"), { recursive: true });
    mkdirSync(join(rootDir, "assets"), { recursive: true });

    writeFileSync(
        join(rootDir, "main.ts"),
        [
            'import { mount } from "svelte";',
            'import App from "./src/App.svelte";',
            'mount(App, { target: document.getElementById("app")! });',
        ].join("\n"),
    );

    writeFileSync(join(rootDir, "src", "App.svelte"), "<h1>new directories</h1>");

    writeFileSync(
        join(rootDir, "bun-svelte-builder.config.ts"),
        [
            'import { defineSvelteConfig } from "bun-svelte-builder";',
            "",
            "export default defineSvelteConfig({",
            `    port: ${devPort},`,
            "});",
        ].join("\n"),
    );

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
    };

    try {
        mkdirSync(join(rootDir, "src", "generated"), { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(join(rootDir, "src", "generated", "helper.js"), 'export const label = "first";');
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(join(rootDir, "src", "generated", "helper.js"), 'export const label = "second";');

        await new Promise<void>((resolve, reject) => {
            const deadline = Date.now() + 4000;
            const timer = setInterval(() => {
                const log = logs.join("\n");
                if (log.includes("Recompiled assets") && log.includes("src/generated/helper.js")) {
                    clearInterval(timer);
                    resolve();
                    return;
                }

                if (Date.now() > deadline) {
                    clearInterval(timer);
                    reject(new Error(`Timed out waiting for new-directory compile report. Logs:\n${log}`));
                }
            }, 25);
        });

        const response = await fetch(`http://127.0.0.1:${result.value.port}/src/generated/helper.js`);
        const source = await response.text();
        const log = logs.join("\n");

        expect(response.ok).toBe(true);
        expect(source).toContain('export const label = "second"');
        expect(log).toContain("src/generated/helper.js");
    } finally {
        console.log = originalLog;
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer rejects escaped project source paths and still serves valid source files", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-source-boundary-"));
    const escapedSourceRoot = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-source-boundary-outside-"));
    const escapedSourcePath = join(escapedSourceRoot, "leak.js");
    createdDirs.push(rootDir, escapedSourceRoot);

    writeConfiguredDevFixture(rootDir, { portLine: `    port: ${devPort},` });
    writeFileSync(join(rootDir, "src", "helper.js"), 'export const helper = "safe";');
    writeFileSync(escapedSourcePath, 'export const leaked = "outside root";');
    symlinkSync(escapedSourcePath, join(rootDir, "src", "escaped.js"));

    const leakedPackageJson = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    try {
        for (const pathname of ["/../package.json", "/%2e%2e/package.json", "/../App.svelte", "/%2e%2e/App.svelte"]) {
            const { body, status } = await requestDevServerPath(result.value.port, pathname);

            expect(status).toBe(404);
            expect(body).not.toContain(leakedPackageJson);
        }

        const escapedResponse = await requestDevServerPath(result.value.port, "/src/escaped.js");

        expect(escapedResponse.status).toBe(404);
        expect(escapedResponse.body).not.toContain('export const leaked = "outside root";');

        const missingSourceResponse = await fetch(`http://127.0.0.1:${result.value.port}/src/missing.js`);
        const missingSourceBody = await missingSourceResponse.text();

        expect(missingSourceResponse.status).toBe(404);
        expect(missingSourceBody).not.toContain(rootDir);
        expect(missingSourceBody).not.toContain(escapedSourceRoot);

        const validResponse = await fetch(`http://127.0.0.1:${result.value.port}/src/helper.js`);
        const validBody = await validResponse.text();

        expect(validResponse.status).toBe(200);
        expect(validBody).toContain('export const helper = "safe";');
    } finally {
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer rejects escaped node_modules paths and still serves valid node_modules files", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-node-modules-boundary-"));
    const escapedNodeModulesRoot = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-node-modules-boundary-outside-"));
    const escapedNodeModulesTarget = join(escapedNodeModulesRoot, "leak.js");
    createdDirs.push(rootDir, escapedNodeModulesRoot);

    writeConfiguredDevFixture(rootDir, { portLine: `    port: ${devPort},` });
    mkdirSync(join(rootDir, "node_modules", "svelte"), { recursive: true });
    writeFileSync(join(rootDir, "node_modules", "svelte", "package.json"), '{"name":"svelte"}');
    writeFileSync(escapedNodeModulesTarget, 'export const leaked = "outside node_modules";');
    symlinkSync(escapedNodeModulesTarget, join(rootDir, "node_modules", "escaped.js"));

    const leakedPackageJson = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    try {
        for (const pathname of ["/_node_modules/../../package.json", "/_node_modules/%2e%2e/%2e%2e/package.json"]) {
            const { body, status } = await requestDevServerPath(result.value.port, pathname);

            expect(status).toBe(404);
            expect(body).not.toContain(leakedPackageJson);
        }

        const missingResponse = await requestDevServerPath(result.value.port, "/_node_modules/missing.js");

        expect(missingResponse.status).toBe(404);
        expect(missingResponse.body).not.toContain("missing.js");

        const escapedResponse = await requestDevServerPath(result.value.port, "/_node_modules/escaped.js");

        expect(escapedResponse.status).toBe(404);
        expect(escapedResponse.body).not.toContain('export const leaked = "outside node_modules";');

        const validResponse = await fetch(`http://127.0.0.1:${result.value.port}/_node_modules/svelte/package.json`);
        const validBody = await validResponse.text();

        expect(validResponse.status).toBe(200);
        expect(validBody).toContain('"name":"svelte"');
    } finally {
        await result.value.stop();
    }
    }));

test("runConfiguredDevServer serves dev assets under /assets", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-assets-"));
    createdDirs.push(rootDir);

    const assetsDir = join(rootDir, "assets");
    mkdirSync(assetsDir, { recursive: true });

    writeFileSync(join(assetsDir, "banner.txt"), "banner from dev assets");
    writeConfiguredDevFixture(rootDir, { assetsDirLine: JSON.stringify(assetsDir), portLine: `    port: ${devPort},` });

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.ok).toBe(true);

    const response = await fetch(`http://127.0.0.1:${result.value.port}/assets/banner.txt`);
    const body = await response.text();

    await result.value.stop();

    expect(response.status).toBe(200);
    expect(body).toBe("banner from dev assets");
    }));

test("runConfiguredDevServer rejects symlink dev assets that escape the assets root", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-assets-symlink-"));
    createdDirs.push(rootDir);

    const assetsDir = join(rootDir, "assets");
    mkdirSync(assetsDir, { recursive: true });

    writeFileSync(join(rootDir, "leaked.txt"), "leaked outside assets root");
    symlinkSync(join(rootDir, "leaked.txt"), join(assetsDir, "banner.txt"));
    writeConfiguredDevFixture(rootDir, { assetsDirLine: JSON.stringify(assetsDir), portLine: `    port: ${devPort},` });

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    if (!result.ok) {
        throw new Error(result.error);
    }

    expect(result.ok).toBe(true);

    const response = await fetch(`http://127.0.0.1:${result.value.port}/assets/banner.txt`);
    const body = await response.text();

    await result.value.stop();

    expect(response.status).toBe(404);
    expect(body).not.toBe("leaked outside assets root");
    }));

test("runConfiguredDevServer fails when configured assetsDir is missing", async () =>
    runSequentialDevTest(async () => {
    const devPort = await allocateFreePort();
    const rootDir = mkdtempSync(join(process.cwd(), ".tmp-bsb-dev-assets-missing-"));
    createdDirs.push(rootDir);

    writeConfiguredDevFixture(rootDir, { assetsDirLine: '"missing-assets"', portLine: `    port: ${devPort},` });

    const { runConfiguredDevServer } = await import("../packages/bun-svelte-builder/src/index.ts");
    const result = await runConfiguredDevServer(rootDir);

    expect(result.ok).toBe(false);

    if (result.ok) {
        throw new Error("Expected dev server startup to fail when configured assets directory is missing");
    }

    expect(result.error).toMatch(/missing configured assets directory/i);
    expect(result.error).toContain("missing-assets");
    }));
