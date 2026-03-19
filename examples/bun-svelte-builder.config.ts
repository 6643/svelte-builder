import { defineSvelteConfig } from "bun-svelte-builder";

export default defineSvelteConfig({
    appComponent: "src/App.svelte",
    assetsDir: "assets",
    appTitle: "Bun Svelte Builder",
    mountId: "app",
});
