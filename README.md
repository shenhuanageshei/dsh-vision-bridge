<h1 align="center">dsh-vision-bridge</h1>

<p align="center">DeepSeek Harness 会话截图按模型能力自动分流 —— 多模态模型原样直读，纯文本模型由 VLM 代读（tool / auto 双模式）。</p>

## 能力面

| 工具 | 说明 |
|---|---|
| `vision_bridge_read` | 模型自主调用：按占位符里的 8-hex 前缀（或 `latest`）读取本会话截图，返回结构化描述（概览/可见文字/布局/对提问的回答），输出恒带 UNTRUSTED 声明。只收 `{ ref?, question? }`，无 path/url 面。 |

| 自动行为 | 说明 |
|---|---|
| auto 预描述注入 | 新到 `user/message` 图片后台异步分析，经 `agent/pre-step` 同轮追加 `<vision-context>`（相关性按进入消息的 attachment id 匹配；超时/失败/无匹配一律放行），迟到结果经 PromptContext 兜底、消费后剪除。 |

| 设置（命名空间 vision-bridge，设置页自动渲染） | 说明 |
|---|---|
| mode | `tool` / `auto` / `both`（默认 both），live 生效 |
| provider | baseURL/model；留空用首次运行自 toolkit 拷贝并本地固化的默认值 |
| credential | DSH CredentialRef（默认 `VISION_API_KEY`，与 toolkit 同名共享凭证条目） |
| 其余字段 | timeoutMs / concurrency / cache / maxImageBytes / maxImagePixels / visionCapabilities / language / autoMode.maxPerTurn —— 见设计文档 §5.7 |

## 已知限制

- **回合取消只覆盖附件读取**：取消时 `readImageRequest`（附件字节读取）即时中止；经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**——`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 `adapter.call`（受不改库源码约束）。上游库为 analyze 增加 signal 透传后可根治。

## 安装（profile web）

```text
依赖行: "@dsh-external/dsh-vision-bridge": "file:../../../plugins/dsh-vision-bridge"（profile/profiles/web/package.json）
层登记: dsh.profile.bundles 数组追加 "@dsh-external/dsh-vision-bridge"
挂载行: profile cordis.patch.yml 同 id insert 行
然后: cd profile && pnpm install，重启 DSH web
```

## 权威文档

- 设计（架构/运行时事实/验收标准，单一权威）: `D:\DSH-Portable\docs\superpowers\specs\2026-09-04-dsh-vision-bridge-design.md`
- 人工验收清单: `docs/VERIFY.md`

## vendor 来源

引擎库 vendor 自本机工作副本 `D:\workspace\vision-bridge`（快照 2026-09-04，该目录非 git 仓库，无 commit；逐文件 sha256 指纹见 `vendor/vision-bridge/VENDOR.md`）。源码逻辑零改动，仅补 `package.json`/`tsconfig.json` 并 tsc 出 `dist`；其 8 个 vitest 测试已移植为 node:test（`vendor/vision-bridge/tests/`，原文件存档于 `tests-vitest-original/`）。

## 开发

```bash
npm run build:vendor   # tsc 出 vendor dist（改 vendor src 后）
npm test               # node --test（零依赖；递归含 vendor 测试）
```
