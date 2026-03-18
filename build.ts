import { join } from "node:path";
import { type BuildSvelteOptions, buildSvelte, formatBuildReport, runConfiguredBuild } from "bun-svelte-builder";

const DEFAULT_EXAMPLE_ROOT = join(import.meta.dir, "examples");
const hasBuildOverrides = (options?: BuildSvelteOptions): options is BuildSvelteOptions =>
    Object.values(options ?? {}).some((value) => value !== undefined);

export const buildProduction = (options?: BuildSvelteOptions) =>
    hasBuildOverrides(options) ? buildSvelte(options) : runConfiguredBuild(DEFAULT_EXAMPLE_ROOT);

if (import.meta.main) {
    const result = await buildProduction();
    if (!result.ok) {
        console.error(result.error);
        process.exit(1);
    }

    console.log(formatBuildReport(result.value));
}
