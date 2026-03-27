# svelte-builder

Minimal Bun + Svelte 5 production build preset.

`demo` 是仓库内 dogfood 示例, 用来验证当前仓库里的构建器行为和回归场景, 不作为发布包消费者模板。

当前仓库本身就是发布包源码仓库, 不是 monorepo 子包。README 中的路径、命令和配置说明都以仓库根目录为准。

它保留独立项目形态, 包含 `src/`、`assets/`、`svelte-builder.config.json` 和 `package.json`。入口由构建器根据 `appComponent` 自动生成, 不再需要手写 `main.ts`。

统一配置文件名是 `svelte-builder.config.json`。

配置是纯 JSON, 不执行项目代码。旧的 `svelte-builder.config.ts` 已不再支持; 如果你仍在使用它, 请迁移为 `svelte-builder.config.json`。

配置文件采用严格字段校验:

- 未知顶层字段会直接报错, 避免拼写错误静默回退到默认值
- `rootDir` 仍会被兼容性地忽略, 因为项目根目录由配置文件所在目录自动推导

这个 builder 只支持 SPA:

- 固定 SPA 入口由 `appComponent` 指定, 默认 `src/App.svelte`
- 不支持多页面
- `entrypoint` 已删除
- `appComponent` 默认 `src/App.svelte`
- `appComponent` 必须位于 `src/` 或其他顶级源码目录下, 不支持直接把组件放在项目根目录
- 配置文件所在目录会自动作为项目根, `rootDir` 是内部推导值, 不需要手填

HTML 一律使用内置 shell:

- build/dev 都不读取 `src/index.html`
- `htmlTemplate` 已删除
- 默认根容器固定为 `<main id="app"></main>`
- 默认标题固定为 `Svelte Builder`

dev 源码边界:

- 这里的“app 源码树”指 `appComponent` 归属的 `src/` 或其他顶级源码目录
- dev 只直接暴露 app 源码树里的 `.ts`、`.js`、`.svelte` 模块, 不直接暴露项目根上的 `svelte-builder.config.json`、测试文件或其他脚本
- 若 `appComponent` 位于 `src/` 下的更深层目录, dev 仍会回收到 `src/` 作为 app 源码树和 watch 根
- 若 `appComponent` 位于其他顶级源码目录, dev 会以该顶级目录作为 app 源码树和 watch 根
- `appComponent` 若是符号链接, 它解析后的目标仍必须留在对应的 app 源码树内
- 本地源码导入必须留在 app 源码树内; 不支持 `file://` 这类直接文件导入

公共配置与默认值:

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `appComponent` | `"src/App.svelte"` | SPA 根组件, build/dev 都会据此生成内部 bootstrap |
| `mountId` | `"app"` | 只支持 DOM `id`, build/dev 都会把它写进内置 shell |
| `appTitle` | `"Svelte Builder"` | 内置 shell 的 `<title>` |
| `assetsDir` | `"assets"` | 可选静态资源目录, dev 直接读, build 复制到 `dist/assets/` |
| `outDir` | `"dist"` | 生产输出目录, 必须是项目根内的独立目录, 不能指向项目根或落在 app 源码树内 |
| `port` | `3000` | dev server 监听端口 |
| `sourcemap` | `false` | 生产构建是否输出 inline sourcemap |
| `stripSvelteDiagnostics` | `true` | 是否裁剪 Svelte 运行时详细诊断文案, 默认保留短错误码/警告码 |

`appComponent` 是可选配置:

```json
{
    "appComponent": "src/App.svelte",
    "appTitle": "Svelte Builder"
}
```

`appComponent` 不配置时默认就是 `src/App.svelte`。

`assetsDir` 是可选配置:

```json
{
    "assetsDir": "assets",
    "appTitle": "Svelte Builder"
}
```

`assetsDir` 不配置时默认就是 `assets`。

`stripSvelteDiagnostics` 是可选配置:

```json
{
    "stripSvelteDiagnostics": true
}
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
  svelte-builder.config.json
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
- `outDir` 必须位于项目根目录内, 且必须是独立输出目录, 不能配置为 `.` 或落在 app 源码树内
- 只有在新产物准备完成后才会切换到 `<outDir>/`; 若最终发布失败, 现有输出目录会保留
- 若检测到失效的 `dist.lock`, 构建会自动回收后继续

安全注意事项:

- 配置文件固定为 `svelte-builder.config.json`, 它是纯 JSON 配置, 不执行项目代码
- 旧的 `svelte-builder.config.ts` 已不再支持; 若项目中仍存在该文件, 请迁移并重命名为 `svelte-builder.config.json`
- dev server 的设计目标是本地开发, 不应当作为公网服务暴露; 当前 HTTP 500 响应会对客户端隐藏内部错误细节, 但控制台仍会输出完整异常, 方便本地排查
- dev 只暴露受控 app 源码树、`/_node_modules/*` 和 `/assets/*`, 并对路径穿越与符号链接逃逸做了边界校验, 但这不等于适合承载不可信访问流量
- 若要部署到生产环境, 建议在反向代理或静态托管层补充安全响应头, 至少包括 `Content-Security-Policy`、`X-Content-Type-Options: nosniff` 和合适的 `Referrer-Policy`

安装依赖:

```bash
bun install
```

作为项目依赖使用:

```bash
svelte-builder dev
svelte-builder build
```

在这个仓库里运行 demo:

```bash
cd demo
bun install
bun run dev
bun run build
```

这组命令是仓库内 dogfood 工作流, 用于验证当前仓库源码与安装拓扑。`demo/package.json` 当前通过 `file:..` 依赖仓库根目录包, 因此修改 builder 源码后建议先执行一次 `bun install`, 再运行 `bun run dev` 或 `bun run build`。如果你是在自己的项目里使用本包, 应按上面的包依赖方式集成, 而不是复制 `demo` 的仓库内脚本。

`demo/package.json` 里的脚本当前保留为 `bun ./node_modules/.bin/svelte-builder ...`, 而不是直接写 `svelte-builder ...`。原因是这个仓库当前导出的 bin 仍由 Bun 解释执行 ESM 源文件, 直接把 `.bin/svelte-builder` 当作 shell 命令执行会失败。换句话说, 这里的写法不是为了兼容 PATH, 而是为了显式要求 Bun 来执行这个 bin 入口。

示例配置文件见 `demo/svelte-builder.config.json`。
