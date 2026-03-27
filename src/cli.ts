#!/usr/bin/env bun

import { runConfiguredBuild } from "./build";
import { runConfiguredDevServer } from "./dev";
import { formatBuildReport } from "./report";

const command = process.argv[2];

if (command === "build") {
    const result = await runConfiguredBuild(process.cwd());
    if (!result.ok) {
        console.error(result.error);
        process.exit(1);
    }

    console.log(formatBuildReport(result.value));
} else if (command === "dev") {
    const result = await runConfiguredDevServer(process.cwd());
    if (!result.ok) {
        console.error(result.error);
        process.exit(1);
    }

    console.log(`Serving http://localhost:${result.value.port}`);
} else {
    console.error("Usage: svelte-builder <build|dev>");
    process.exit(1);
}
