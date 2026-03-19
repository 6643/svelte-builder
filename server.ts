import { join } from "node:path";
import { runConfiguredDevServer } from "./src/index";

const DEFAULT_EXAMPLE_ROOT = join(import.meta.dir, "demo");

export const serveDevelopment = () => runConfiguredDevServer(DEFAULT_EXAMPLE_ROOT);

if (import.meta.main) {
    const result = await serveDevelopment();
    if (!result.ok) {
        console.error(result.error);
        process.exit(1);
    }

    console.log(`Serving http://localhost:${result.value.port}`);
}
