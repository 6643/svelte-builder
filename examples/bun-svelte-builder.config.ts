import { defineSvelteConfig } from "../src/index.ts";

export default defineSvelteConfig({
    appComponent: "src/App.svelte",
    assetsDir: "assets",
    appTitle: "Bun Svelte Builder",
    mountId: "app",
});
