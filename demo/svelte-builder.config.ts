import { defineSvelteConfig } from "svelte-builder";

export default defineSvelteConfig({
    appComponent: "src/App.svelte",
    assetsDir: "assets",
    appTitle: "Svelte Builder",
    mountId: "app",
});
