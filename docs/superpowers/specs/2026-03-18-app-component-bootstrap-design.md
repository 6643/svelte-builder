# App Component Bootstrap Design

**Goal:** `bun-svelte-builder` removes the user-authored `main.ts` entry file and generates the SPA bootstrap internally from a public `appComponent` configuration, while keeping the SPA-only shape, `mountId`, `appTitle`, `assetsDir`, `outDir`, and `port` defaults stable.

## Context

The builder already owns the built-in HTML shell, mount target id, document title, and dev/build output flow. The remaining user-authored `main.ts` is now redundant because it only wires the app component to the mount target.

The public configuration should therefore describe the actual app entry directly:

- the root component field is `appComponent`
- the mount target field is `mountId`
- the document title field is `appTitle`
- build/dev/bootstrap generation all consume the same values

## Decision

Adopt the following public config model:

- `appComponent?: string`
  - default: `"src/App.svelte"`
  - meaning: SPA root Svelte component path
  - invalid values: empty string, whitespace-only string, non-string
- `mountId?: string`
  - default: `"app"`
  - meaning: DOM id only
  - invalid values: empty string, whitespace-only string, selector-shaped string, non-string
- `appTitle?: string`
  - default: `"Bun Svelte Builder"`
  - meaning: `<title>` text in the built-in shell
- `assetsDir?: string`
  - default: `"assets"`
- `outDir?: string`
  - default: `"dist"`
- `port?: number`
  - default: `3000`

## Behavior

### Build

- `buildSvelte()` no longer reads a user-authored `main.ts`
- the builder generates an internal bootstrap module from `appComponent` and `mountId`
- the built-in shell uses `<main id="{mountId}"></main>`
- the shell `<title>` uses `appTitle`
- the bundle output still contains the hashed JS entry and CSS entry

### Dev

- `runConfiguredDevServer()` no longer expects a user-authored `main.ts`
- the dev server serves the same generated bootstrap module shape
- the dev shell uses the same `mountId` and `appTitle`

### Bootstrap

The generated bootstrap module is internal to the builder and becomes the single SPA entry.

The mount pattern becomes:

```ts
import { mount } from "svelte";
import App from "./src/App.svelte";

mount(App, {
    target: document.getElementById("app")!,
});
```

The generated bootstrap uses the configured `appComponent` path and `mountId`. The user no longer writes this file manually.

## File Boundaries

Public-facing changes:

- `packages/bun-svelte-builder/src/build.ts`
  - parse `appComponent`, `mountId`, and `appTitle`
  - generate the internal bootstrap module
  - use `appTitle` in the built-in shell title
  - use `mountId` in shell generation
- `packages/bun-svelte-builder/src/dev.ts`
  - serve the generated bootstrap module
  - use `mountId` and `appTitle` in the dev shell
- `examples/main.ts`
  - remove the file entirely
- `examples/bun-svelte-builder.config.ts`
  - add `appComponent`
  - keep `mountId`
  - keep `appTitle`
- `packages/bun-svelte-builder/src/runtime.ts`
  - remove public runtime mount id export if it becomes unused

Documentation:

- `README.md`
- `packages/bun-svelte-builder/README.md`

## Testing

Minimum regression set:

1. The default config emits `appComponent = "src/App.svelte"`, `mountId = "app"`, and `appTitle = "Bun Svelte Builder"`.
2. `appComponent` changes the generated bootstrap import path.
3. `mountId: "app"` emits `<main id="app"></main>` in build/dev shells.
4. `appTitle` changes the emitted `<title>`.
5. Empty string, whitespace-only string, and non-string `appComponent` values are rejected.
6. The example workspace builds and serves without a user-authored `main.ts`.

## Risks

- The builder now owns more of the entry wiring, so debug output will shift from user code to generated bootstrap code.
- Docs must be updated together with code, otherwise the repo drifts back into a mixed `main.ts` / bootstrap model.
- The generated bootstrap must stay aligned with the `appComponent` path resolution rules, or builds will fail at runtime.

## Non-Goals

- No selector support for mount targeting
- No multiple mount targets
- No HTML template reintroduction
- No multi-page support
- No user-authored `main.ts` entry file
