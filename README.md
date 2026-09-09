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

## 设置（设置 → 插件 →「dsh-VisionBridge 视觉代读」卡片）

卡片三组布局（视觉引擎 / 触发与输出 / 高级折叠），支持：

- **Provider 联动**：下拉选 DSH 已配置 provider → 模型/凭证自动带出；「自定义」解锁手填。内置 URL 的 provider（zai/minimax 等）baseURL 自动补全。
- **凭证三形态**：跟 provider 走 / 从已存条目选 / **粘贴 API Key**（密码框，保存即建条目；换 Key 直接覆盖，同名无需新建）。
- **验证连通**：一键测试当前配置（返回延迟或具体错误）。
- **环境体检**：准入补丁两态（磁盘 + 运行时探针）+ modlens 冲突检测 + 一键修复。

字段语义（`vision-bridge:` 命名空间，settings.yaml 直改等效）：

| 字段 | 说明 |
|---|---|
| mode | `tool` / `auto` / `both`（默认 both） |
| provider.baseURL / model | 卡片可配；留空则首次运行从 dsh-vision-toolkit 拷贝并本地固化 |
| credential | DSH CredentialRef（默认 `VISION_API_KEY`） |
| promptExtra | 附加指令（≤2000 字符，拼在代读请求尾部） |
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

- **DSH 更新会冲掉准入补丁**（已知边界）：更新后插件在**下次启动时自动重打**（§12 启动自愈，日志一行 `admission gate re-patched`）；极端时序下更新后第一次启动的当次会话可能仍遇「模型不支持图片」拒绝——卡片体检区的运行时探针（`VISION_BRIDGE_ADMISSION_PROBE=1` 开启）会显式显示「已修复磁盘，重启后生效」。
- **modlens 用户**：modlens 的粘贴接管与本品设计重叠（同为文本模型读图）。已装 modlens 时请在卡片体检区「一键关闭」其接管（或 profile patch 行 `pasteToPath: false`），否则贴图被它截走。modlens 其余能力（路径/URL 读图、全文 OCR）与本品分工并存。
- **回合取消只覆盖附件读取**：取消时 `readImageRequest`（附件字节读取）即时中止；经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 `adapter.call`，受不改库源码约束）。上游库为 analyze 增加 signal 透传后可根治。
- 8-hex 前缀为 32bit 空间，理论碰撞率低但非零；多命中时返回候选列表。

## 文档

- `CHANGELOG.md` — 变更记录（v0.1.0 → v0.2 系列逐版本）
- `docs/design.md` — 设计文档（§5 核心 / §10 设置 v1 / §11 卡片 v2 / §12 启动自愈+探针；含偏差记录）
- `docs/VERIFY.md` — 人工验收清单（§8 卡片 v1 / §9 卡片 v2 / §10 自愈+探针）
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
