# dsh-vision-bridge

DeepSeek Harness 会话截图按模型能力自动分流 —— 多模态模型原样直读，纯文本模型由 VLM 代读（tool / auto 双模式）。

## 它解决什么问题

在 DeepSeek Harness 里往会话发截图时：

- **当前模型支持图像输入**（模型声明含 `image` 模态）→ 截图原样内联进请求，模型原生直读；
- **当前模型是纯文本** → 运行时把图投影成 `[image omitted … attachment sha256:xxxxxxxx]` 占位符。本插件接管这条路径：附件在请求前已持久化，插件回扫会话日志解析出完整引用，把截图交给视觉语言模型（VLM）代读，再把结构化描述交还模型。

对用户来说效果是：**截图随便发，任何模型都"看得见"**。

## 能力面

| 工具/行为 | 说明 |
|---|---|
| `vision_bridge_read`（tool 模式） | 模型自主调用：按占位符里的 8-hex 前缀（或 `latest`）读取本会话截图，返回结构化描述（概览/可见文字/布局/对提问的回答）。输出恒带 UNTRUSTED 声明。只收 `{ ref?, question? }`，无 path/url 面。 |
| auto 预描述注入 | 新到 `user/message` 图片后台异步分析，经 `agent/pre-step` 同轮追加 `<vision-context>`（按进入消息的 attachment id 相关性匹配；超时/失败/无匹配一律放行），迟到结果经 PromptContext 兜底、消费后剪除。 |

多命中（8-hex 前缀碰撞）返回候选列表而非猜测；compaction/fork/resume 后旧截图仍可解析（原始日志 append-only）。

## 设置（命名空间 `vision-bridge`，设置页自动渲染，live 生效）

| 字段 | 说明 |
|---|---|
| mode | `tool` / `auto` / `both`（默认 both） |
| provider.baseURL / model | 留空则首次运行从 dsh-vision-toolkit 拷贝并本地固化 |
| credential | DSH CredentialRef（默认 `VISION_API_KEY`，与 vision-toolkit 同名共享凭证条目） |
| 其余 | timeoutMs / concurrency / cache / maxImageBytes / maxImagePixels / visionCapabilities / language / autoMode.maxPerTurn —— 见 `docs/design.md` §5.7 |

## 安装（web profile）

1. `profile/profiles/web/package.json` 依赖加一行：
   `"@dsh-external/dsh-vision-bridge": "file:../../../plugins/dsh-vision-bridge"`
   （本仓库放到 `profile/plugins/dsh-vision-bridge` 时用此相对路径；其它位置自行调整。）
2. `dsh.profile.bundles` 数组追加 `"@dsh-external/dsh-vision-bridge"`。
3. **`cd profile && pnpm install`**（file: 依赖是复制不是链接；以后改插件源码也要重跑或手动同步安装副本）。
4. 重启 DSH web。

> ⚠️ 挂载由插件自带的 `cordis.patch.yml`（dsh.bundle.patch）自动完成。**不要**在 profile 的 `cordis.patch.yml` 里再手动加同名 insert 行——两处同 id 会以 `duplicate loader entry id` 崩掉启动。配置覆盖走 settings.yaml 的 `vision-bridge:` 键。

## 已知限制

- **回合取消只覆盖附件读取**：取消时 `readImageRequest`（附件字节读取）即时中止；经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 `adapter.call`，受不改库源码约束）。上游库为 analyze 增加 signal 透传后可根治。
- 8-hex 前缀为 32bit 空间，理论碰撞率低但非零；多命中时返回候选列表。

## 文档

- `docs/design.md` — 设计文档（架构/运行时事实/验收标准，本仓内快照）
- `docs/VERIFY.md` — 人工验收清单（七条）
- `vendor/vision-bridge/VENDOR.md` — 引擎库来源与指纹

## 开发

```bash
npm run build:vendor   # tsc 出 vendor dist（改 vendor src 后）
npm test               # node --test（零依赖；递归含 vendor 测试）
```

> **开发环境注意**:插件的 peer 依赖（`@deepseek-ai/*`）不在公共 npm,测试解析依赖把本目录 `node_modules/@deepseek-ai/*` 以 junction 指向 web profile 的 `node_modules`（已 gitignore）。新 clone 上跑测试前需自建这些 junction,或在 DSH profile 内开发。
  另:settings-lifecycle 测试会临时改 `process.env.DSH_HOME` 以隔离持久化目录;`node --test` 每个测试文件独立子进程,无跨文件污染。

## 引擎库来源

vendor 自 [shenhuanageshei/vision-bridge](https://github.com/shenhuanageshei/vision-bridge)（快照 2026-09-04；逐文件 sha256 指纹见 `vendor/vision-bridge/VENDOR.md`）。源码逻辑零改动，仅补 `package.json`/`tsconfig.json` 并 tsc 出 `dist`；其 8 个 vitest 测试已移植为 node:test。

## License

BSD-3-Clause（见 `LICENSE`）
