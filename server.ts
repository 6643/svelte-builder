import { join } from "node:path";
import { runConfiguredDevServer } from "bun-svelte-builder";

const result = await runConfiguredDevServer(join(import.meta.dir, "examples"));
if (!result.ok) {
    console.error(result.error);
    process.exit(1);
}

console.log(`Serving http://localhost:${result.value.port}`);
