# App Component Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the user-authored `main.ts` entry file and have `bun-svelte-builder` generate the SPA bootstrap internally from a public `appComponent` config, while keeping `mountId`, `appTitle`, `assetsDir`, `outDir`, and `port` aligned across build, dev, docs, and tests.

**Architecture:** `appComponent` becomes the single source of truth for the SPA root component, and `mountId` stays the single source of truth for the mount node id. Build and dev both generate the same bootstrap module from config, so the app no longer needs a hand-written entry file. The built-in HTML shell still comes from the builder, and the example workspace remains the canonical consumer.

**Tech Stack:** Bun, TypeScript, Svelte compiler, existing builder package, Bun test.

---

### Task 1: Add `appComponent` config parsing and a generated bootstrap source helper

**Files:**
- Create: `packages/bun-svelte-builder/src/bootstrap.ts`
- Modify: `packages/bun-svelte-builder/src/build.ts`
- Modify: `tests/build.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that prove:
- `appComponent` defaults to `"src/App.svelte"`
- `appComponent` rejects empty strings, whitespace-only strings, and non-string values
- the bootstrap source generator emits an import for the configured app component path and mounts to the configured `mountId`

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/build.test.ts -t "appComponent|bootstrap"
```
Expected: FAIL until the new config parsing and source generator exist.

- [ ] **Step 3: Write minimal implementation**

Add `appComponent` to `BuildSvelteOptions`, validate it with the same guard-style parsing used for the other config fields, and create a small `bootstrap.ts` helper that renders the generated SPA entry source from an import path plus `mountId`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/build.test.ts -t "appComponent|bootstrap"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bun-svelte-builder/src/bootstrap.ts packages/bun-svelte-builder/src/build.ts tests/build.test.ts
git commit -m "feat: add app component bootstrap config"
```

### Task 2: Switch build and dev to generated bootstrap modules and remove `main.ts`

**Files:**
- Modify: `packages/bun-svelte-builder/src/build.ts`
- Modify: `packages/bun-svelte-builder/src/dev.ts`
- Modify: `packages/bun-svelte-builder/src/index.ts`
- Modify: `packages/bun-svelte-builder/src/runtime.ts`
- Delete: `examples/main.ts`
- Modify: `tests/build.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests that prove:
- build no longer requires `examples/main.ts`
- dev no longer requires `examples/main.ts`
- the generated bootstrap uses the configured `appComponent`
- the old runtime-export path is no longer part of the public bootstrap flow

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/build.test.ts -t "main.ts|bootstrap|runtime"
```
Expected: FAIL until build/dev stop depending on the user-authored entry file.

- [ ] **Step 3: Write minimal implementation**

Generate the bootstrap code internally for both build and dev:
- build should compile from a generated bootstrap file instead of `<rootDir>/main.ts`
- dev should serve the same generated bootstrap source for `/main.ts`
- remove the public runtime mount-id path if it is no longer needed
- delete `examples/main.ts`

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/build.test.ts -t "main.ts|bootstrap|runtime"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bun-svelte-builder/src/build.ts packages/bun-svelte-builder/src/dev.ts packages/bun-svelte-builder/src/index.ts packages/bun-svelte-builder/src/runtime.ts examples/main.ts tests/build.test.ts
git commit -m "feat: generate spa bootstrap internally"
```

### Task 3: Update example config and documentation for the new entry model

**Files:**
- Modify: `examples/bun-svelte-builder.config.ts`
- Modify: `README.md`
- Modify: `packages/bun-svelte-builder/README.md`
- Modify: `docs/superpowers/specs/2026-03-18-app-component-bootstrap-design.md`

- [ ] **Step 1: Update the docs**

Document every public config item and default value:
- `appComponent = "src/App.svelte"`
- `mountId = "app"`
- `appTitle = "Bun Svelte Builder"`
- `assetsDir = "assets"`
- `outDir = "dist"`
- `port = 3000`

Remove any remaining user-facing mention of a required `main.ts` file.

- [ ] **Step 2: Run doc checks**

Run:
```bash
rg -n "main.ts|appComponent|mountId|appTitle|assetsDir|outDir|port|runtime" README.md packages/bun-svelte-builder/README.md examples/bun-svelte-builder.config.ts docs/superpowers/specs/2026-03-18-app-component-bootstrap-design.md
```
Expected:
- `appComponent`, `mountId`, and `appTitle` should appear in the public docs
- `main.ts` should no longer be presented as a required user-authored file

- [ ] **Step 3: Commit**

```bash
git add README.md packages/bun-svelte-builder/README.md examples/bun-svelte-builder.config.ts docs/superpowers/specs/2026-03-18-app-component-bootstrap-design.md
git commit -m "docs: describe generated app bootstrap"
```

### Task 4: Full verification and cleanup

**Files:**
- Modify: none if prior tasks are complete

- [ ] **Step 1: Run full verification**

Run:
```bash
bun test
bun run build
cd examples && bun run build
```
Expected:
- all tests pass
- both builds pass
- the example workspace works without `examples/main.ts`

- [ ] **Step 2: Clean up stale references**

Search for leftover references to the removed user entry file and the old runtime flow, then remove anything that conflicts with the new bootstrap model.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: remove user main entry and generate bootstrap"
```
