# Vendored: @ti-agent/vision-bridge

- **来源**: `github.com/shenhuanageshei/vision-bridge(vendor 上游,公开仓)`(本机工作副本,该目录**不是 git 仓库**,无 commit 可记)
- **快照日期**: 2026-09-04
- **源码逻辑零改动**: `src/**` 与原样一致;仅新增本 manifest(`package.json`/`tsconfig.json`)并由 tsc 产出 `dist/`。
- **测试**: 原库 8 个 vitest 测试文件保留于 `tests-vitest-original/*.vitest.ts`(仅存档,不参与运行);
  移植后的 node:test 版本在 `tests/*.test.mjs`(`npm test` = `node --test`,零依赖)。
- ** specifier 策略**: 保持 .js 相对导入(设计 §5.1 方案 A),必须经 tsc 出 dist 后消费。

## src 文件快照指纹(sha256 前 16 位)

| 文件 | 指纹 |
|---|---|
| src/adapters/anthropic.ts | 14464217e6aa941f |
| src/adapters/openai-compatible.ts | 5e1f4184d69aa89a |
| src/adapters/types.ts | 2fd9e01e14892279 |
| src/core/cache.ts | 75994ceec62f3524 |
| src/core/formatters.ts | 176609941ba52f85 |
| src/core/prompts.ts | 5a93841e1652edc9 |
| src/core/types.ts | b37f8f296baf29d6 |
| src/core/utils.ts | 351f63810af09238 |
| src/core/vision-bridge.ts | 24e5a585c4a79961 |
| src/index.ts | 1801a41d19694ee2 |

权威设计文档(工程上下文与运行时事实): `docs/design.md(本仓内快照)`