export type SvelteDiagnosticsKind = "errors" | "warnings";

export const stripSvelteDiagnosticsModule = (source: string, kind: SvelteDiagnosticsKind): string => {
    const exportedFunctions = Array.from(source.matchAll(/export function\s+(\w+)\s*\(([^)]*)\)\s*\{/g));
    const exportStatements = Array.from(source.matchAll(/^\s*export\s+/gm)).length;

    if (exportedFunctions.length === 0 || exportedFunctions.length !== exportStatements) {
        throw new Error(`Unsupported Svelte ${kind} module shape for diagnostics stripping`);
    }

    return exportedFunctions
        .map(([, name, args]) => {
            const statement = kind === "errors" ? `throw Error(${JSON.stringify(name)});` : `console.warn(${JSON.stringify(name)});`;
            return `export function ${name}(${args}) { ${statement} }`;
        })
        .join("\n");
};
