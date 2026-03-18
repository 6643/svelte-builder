import { isAbsolute, join, relative } from "node:path";

const normalizeImportPath = (value: string): string => value.replaceAll("\\", "/");

export const createImportPath = (fromDir: string, toPath: string): string => {
    const importPath = normalizeImportPath(relative(fromDir, toPath));

    return importPath.startsWith(".") ? importPath : `./${importPath}`;
};

export const resolveConfiguredPath = (rootDir: string, value: string | undefined, fallback: string): string => {
    const target = value ?? fallback;
    return isAbsolute(target) ? target : join(rootDir, target);
};

export const createBootstrapSource = (appComponentImportPath = "./src/App.svelte", mountId = "app"): string =>
    [
        'import { mount } from "svelte";',
        `import App from ${JSON.stringify(normalizeImportPath(appComponentImportPath))};`,
        "",
        "mount(App, {",
        `    target: document.getElementById(${JSON.stringify(mountId)})!,`,
        "});",
    ].join("\n");

export const createBootstrapModuleSource = createBootstrapSource;
