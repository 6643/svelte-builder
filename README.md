# bun-svelte-builder

Minimal Bun + Svelte 5 production build preset.

`demo` 是仓库内 dogfood 示例, 用来验证当前仓库里的构建器行为和回归场景, 不作为发布包消费者模板。

它保留独立项目形态, 包含 `src/`、`assets/`、`bun-svelte-builder.config.ts` 和 `package.json`。入口由构建器根据 `appComponent` 自动生成, 不再需要手写 `main.ts`。

统一配置文件名是 `bun-svelte-builder.config.ts`。

这个 builder 只支持 SPA:

- 固定 SPA 入口由 `appComponent` 指定, 默认 `src/App.svelte`
- 不支持多页面
- `entrypoint` 已删除
- `appComponent` 默认 `src/App.svelte`
- 配置文件所在目录会自动作为项目根, `rootDir` 是内部推导值, 不需要手填

HTML 一律使用内置 shell:

- build/dev 都不读取 `src/index.html`
- `htmlTemplate` 已删除
- 默认根容器固定为 `<main id="app"></main>`
- 默认标题固定为 `Bun Svelte Builder`

公共配置与默认值:

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `appComponent` | `"src/App.svelte"` | SPA 根组件, build/dev 都会据此生成内部 bootstrap |
| `mountId` | `"app"` | 只支持 DOM `id`, build/dev 都会把它写进内置 shell |
| `appTitle` | `"Bun Svelte Builder"` | 内置 shell 的 `<title>` |
| `assetsDir` | `"assets"` | 可选静态资源目录, dev 直接读, build 复制到 `dist/assets/` |
| `outDir` | `"dist"` | 生产输出目录 |
| `port` | `3000` | dev server 监听端口 |
| `sourcemap` | `false` | 生产构建是否输出 inline sourcemap |
| `stripSvelteDiagnostics` | `true` | 是否裁剪 Svelte 运行时详细诊断文案, 默认保留短错误码/警告码 |

`appComponent` 是可选配置:

```ts
import { defineSvelteConfig } from "bun-svelte-builder";

export default defineSvelteConfig({
    appComponent: "src/App.svelte",
    appTitle: "Bun Svelte Builder",
});
```

`appComponent` 不配置时默认就是 `src/App.svelte`。

`assetsDir` 是可选配置:

```ts
import { defineSvelteConfig } from "bun-svelte-builder";

export default defineSvelteConfig({
    assetsDir: "assets",
    appTitle: "Bun Svelte Builder",
});
```

`assetsDir` 不配置时默认就是 `assets`。

`stripSvelteDiagnostics` 是可选配置:

```ts
import { defineSvelteConfig } from "bun-svelte-builder";

export default defineSvelteConfig({
    stripSvelteDiagnostics: true,
});
```

`stripSvelteDiagnostics` 的行为边界:

- `true` 时, 构建器会拦截 Svelte internal 的 diagnostics 模块, 去掉长错误文案, 但保留短错误码/警告码, 例如 `derived_references_self`、`hydration_mismatch`
- `false` 时, 保留 Svelte 原始运行时诊断实现, 方便调试或排查升级兼容性问题
- 这个能力依赖 Svelte internal 模块路径与导出形式, 升级 Svelte 后应重新执行一次 `bun test` 和 `cd demo && bun run build` 做回归验证

最小目录形态:

```text
demo/
  src/
    App.svelte
  assets/
  bun-svelte-builder.config.ts
```

静态资源语义固定为 `/assets/*`:

- dev: 直接从 `<rootDir>/<assetsDir>/*` 读取
- build: 原样复制到 `<outDir>/assets/*`
- 不参与 hash, 不改名, 不注入到入口产物报告
- 示例页面当前直接引用 `/assets/panel-mark.svg`

构建输出示例:

- `bun run build`

```text
Entry assets

File                     Size     Gzip
f35ba27158e87d2b.js   4.1 KiB  1.9 KiB
d0c5e18487a809dd.css  4.6 KiB  1.4 KiB
index.html              274 B    217 B
```

- `bun dev`

```text
Recompiled assets

File                         Time                 Size     Gzip
src/lazy/ButtonDemo.svelte   2026-03-18 11:11:11  4.1 KiB  1.9 KiB
```

生产构建采用单写者 `dist` 发布:

- 最终产物直接写入当前项目的 `<outDir>/`
- 同一输出目录只允许一个构建进程写入
- 若检测到失效的 `dist.lock`, 构建会自动回收后继续

安装依赖:

```bash
bun install
```

作为项目依赖使用:

```bash
bun-svelte-builder dev
bun-svelte-builder build
```

在这个仓库里运行 demo:

```bash
cd demo
bun install
bun run dev
bun run build
```

这组命令是仓库内 dogfood 工作流, 用于验证当前仓库源码与安装拓扑。`demo/package.json` 当前通过 `file:..` 依赖仓库根目录包, 因此修改 builder 源码后建议先执行一次 `bun install`, 再运行 `bun run dev` 或 `bun run build`。如果你是在自己的项目里使用本包, 应按上面的包依赖方式集成, 而不是复制 `demo` 的仓库内脚本。

示例配置文件见 `demo/bun-svelte-builder.config.ts`。
