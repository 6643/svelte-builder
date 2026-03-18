# bun-svelte-builder

Minimal Bun + Svelte 5 production build preset.

SPA only.

- the SPA root component is configured by `appComponent`, defaulting to `src/App.svelte`
- multi-page builds are not supported
- `entrypoint` is not supported
- the config file directory is used as the project root, so `rootDir` is inferred internally

HTML always uses the built-in shell.

- `htmlTemplate` is not supported
- `src/index.html` is ignored
- the default mount root is `<main id="app"></main>`
- the default title is `Bun Svelte Builder`

Public config and defaults:

| Config | Default | Description |
| --- | --- | --- |
| `appComponent` | `"src/App.svelte"` | SPA root component; build/dev generate the bootstrap module from it |
| `mountId` | `"app"` | DOM `id` only; build/dev write it into the built-in shell |
| `appTitle` | `"Bun Svelte Builder"` | Built-in shell `<title>` |
| `assetsDir` | `"assets"` | Optional static asset directory; dev reads it directly, build copies it into `dist/assets/` |
| `outDir` | `"dist"` | Production output directory |
| `port` | `3000` | Dev server port |

Production publishing uses a single-writer `dist` directory:

- build output is written directly into `dist/`
- only one build process may publish to the same output directory at a time
- stale `dist.lock` state is recovered automatically before the next build

```ts
import { defineSvelteConfig } from "bun-svelte-builder";

export default defineSvelteConfig({
    assetsDir: "assets",
    appTitle: "Bun Svelte Builder",
});
```

If `assetsDir` is omitted, it defaults to `assets`.

Minimal project shape:

```text
app/
  src/
    App.svelte
  assets/
  bun-svelte-builder.config.ts
```

`assetsDir` is optional and maps static files to a fixed `/assets/*` URL space.

- `dev`: reads files directly from `<rootDir>/<assetsDir>/*`
- `build`: copies files as-is into `<outDir>/assets/*`
- assets are not hashed, renamed, or included in the entry asset report

Build output example:

```text
Entry assets

File                     Size     Gzip
f35ba27158e87d2b.js   4.1 KiB  1.9 KiB
d0c5e18487a809dd.css  4.6 KiB  1.4 KiB
index.html              274 B    217 B
```

Dev output example:

```text
Recompiled assets

File                         Time                 Size     Gzip
src/lazy/ButtonDemo.svelte   2026-03-18 11:11:11  4.1 KiB  1.9 KiB
```

```ts
import { runConfiguredBuild } from "bun-svelte-builder";

const result = await runConfiguredBuild(import.meta.dir);
```

```bash
bun-svelte-builder build
bun-svelte-builder dev
```
