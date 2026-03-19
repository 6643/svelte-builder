type RuntimeElement = { id: string };

export type RuntimeMountScope = {
    getElementById: (id: string) => RuntimeElement | null;
};

const normalizeMountId = (mountId: string): string => mountId.trim();

const isPlainMountId = (mountId: string): boolean => /^[A-Za-z0-9_-]+$/.test(mountId);

// Type-only export for editor/type-checker consumers.
// Build/dev replace this module with a generated runtime module that embeds the configured mount id.
export declare const mountId: string;

export const getMountTarget = (scope: RuntimeMountScope, mountId: string): RuntimeElement => {
    const normalizedMountId = normalizeMountId(mountId);
    const target = scope.getElementById(normalizedMountId);
    if (!target) {
        throw new Error(`Missing mount id: ${normalizedMountId}`);
    }

    return target;
};

export const createRuntimeModuleSource = (mountId: string): string => {
    const normalizedMountId = normalizeMountId(mountId);
    if (!isPlainMountId(normalizedMountId)) {
        throw new Error(`Invalid mount id for runtime module: ${mountId}`);
    }

    return [
        `export const mountId = ${JSON.stringify(normalizedMountId)};`,
        "export const getMountTarget = (scope = document) => {",
        "    const target = scope.getElementById(mountId);",
        "    if (!target) {",
        '        throw new Error(`Missing mount id: ${mountId}`);',
        "    }",
        "    return target;",
        "};",
    ].join("\n");
};
