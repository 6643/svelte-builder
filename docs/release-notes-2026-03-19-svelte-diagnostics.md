# 2026-03-19 Svelte Diagnostics Release Notes

## Summary

- 新增 `stripSvelteDiagnostics` 构建配置, 默认在生产构建中裁剪 Svelte 运行时详细诊断文案
- 生产构建不再保留大段 `Svelte error` / hydration 详细说明文本, 改为保留短错误码和警告码
- `demo` 改为通过 `file:..` 使用仓库当前包, 便于仓库内 dogfood 和真实构建回归

## Added

- 新增 `stripSvelteDiagnostics` 配置项, 默认值为 `true`
- 新增 Svelte diagnostics 精简逻辑, 在保留函数签名的同时输出短错误码或警告码, 例如 `derived_references_self`、`hydration_mismatch`
- 新增结构校验, 若 Svelte internal diagnostics 模块导出形态变化, 构建会更早暴露不兼容问题
- 新增针对 diagnostics 裁剪开关、保留短码和配置校验的测试覆盖

## Changed

- `demo/package.json` 当前通过 `file:..` 引用仓库根目录包, 使 demo 构建直接验证当前源码版本
- README 新增 `stripSvelteDiagnostics` 配置说明、行为边界、升级风险与 demo dogfood 说明
- README 明确解释 `demo` 为什么显式使用 `bun ./node_modules/.bin/svelte-builder ...`

## Verification

- `bun test`
- `bun run typecheck`
- `cd demo && bun install`
- `cd demo && bun run build`

## Upgrade Notes

- diagnostics 裁剪依赖 Svelte internal diagnostics 模块路径与导出形式
- 升级 Svelte 后, 建议重新执行 `bun test` 与 `cd demo && bun run build`
- 若需要保留原始详细诊断, 可将 `stripSvelteDiagnostics` 显式设为 `false`
