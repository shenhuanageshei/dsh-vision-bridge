# dsh-vision-bridge

DeepSeek Harness 会话截图按模型能力自动分流 —— 多模态模型原样直读，纯文本模型由 VLM 代读（tool / auto 双模式）。

## 它解决什么问题

在 DeepSeek Harness 里往会话发截图时：

- **当前模型支持图像输入**（模型声明含 `image` 模态）→ 截图原样内联进请求，模型原生直读；
- **当前模型是纯文本** → 运行时把图投影成 `[image omitted … attachment sha256:xxxxxxxx]` 占位符。本插件接管这条路径：附件在请求前已持久化，插件回扫会话日志解析出完整引用，把截图交给视觉语言模型（VLM）代读，再把结构化描述交还模型。

对用户来说效果是：**截图随便发，任何模型都"看得见"**。

### 它是怎么让纯文本模型收下图

DSH 判定「这个模型认不认图」走两条**互不调用**的路径：

- **准入闸**（会话 prompt 准入 / 子代理 / ACP）读**服务方法** `llm.resolveModelInfo(...)`；
- **图片投影**（`LlmRuntime.adapterStream` → `[image omitted … sha256:xxxxxxxx]`）读 `adapter.prepareCall().model`。

插件在运行时**装饰前者**（`lib/seam.js`）：闸门看到「这个模型能收图」⇒ 带图消息放行、图片正常入账；投影照旧把图片换成占位符，插件的代读链路接手。

**不修改 DSH 任何文件**：不改内核源码、不写 `node_modules`、不需要补丁脚本；停用插件即还原（装饰只活在内存里，随插件生命周期拆除）。

> 旧版本靠改内核源码放行（`scripts/patch-admission-gate.mjs`），在桌面版行不通——那里的内核打包在 `resources/app.asar` 内。
> 该脚本保留为**遗留部署**路径，新部署一律走运行时缝。

**支持的内核代际**：DSH **0.1.6** / **0.1.7**（web profile），以及 **DSH 桌面版 0.1.7**（内核打包在 `resources/app.asar` 里的部署）。

## 能力面

| 工具/行为 | 说明 |
|---|---|
| `vision_bridge_read`（tool 模式） | 模型自主调用：按占位符里的 8-hex 前缀（或 `latest`）读取本会话截图，返回结构化描述（概览/可见文字/布局/对提问的回答）。输出恒带 UNTRUSTED 声明。只收 `{ ref?, question? }`，无 path/url 面。 |
| auto 预描述注入 | 新到 `user/message` 图片后台异步分析，经 `agent/pre-step` 同轮追加 `<vision-context>`（按进入消息的 attachment id 相关性匹配；超时/失败/无匹配一律放行），迟到结果经 PromptContext 兜底、消费后剪除。 |

多命中（8-hex 前缀碰撞）返回候选列表而非猜测；compaction/fork/resume 后旧截图仍可解析（原始日志 append-only）。

## 设置（卡片位置随 DSH 代际变化）

- **DSH 0.1.6**：设置 → 插件 →「dsh-VisionBridge 视觉代读」卡片。
- **DSH 0.1.7**：内置插件 → 找到 `vision-bridge` 那一行 → **点进详情页** → 配置区（宿主在新内核只在行**详情页**渲染配置槽；列表页只显示描述文字，不出表单）。

卡片三组布局（视觉引擎 / 触发与输出 / 高级折叠），支持：

- **Provider 联动**：下拉选 DSH 已配置 provider → 模型/凭证自动带出；「自定义」解锁手填。内置 URL 的 provider（zai/minimax 等）baseURL 自动补全。
- **凭证三形态**：跟 provider 走 / 从已存条目选 / **粘贴 API Key**（密码框，保存即建条目；换 Key 直接覆盖，同名无需新建）。
- **验证连通**：一键测试当前配置（返回延迟或具体错误）。
- **环境体检**：准入补丁两态（磁盘 + 运行时探针）+ modlens 冲突检测 + 一键修复。

字段语义（`vision-bridge:` 命名空间，settings.yaml 直改等效）：

| 字段 | 说明 |
|---|---|
| mode | `tool` / `auto` / `both`（默认 both） |
| provider.baseURL / model | 卡片可配；留空则首次运行从 dsh-vision-toolkit 拷贝并本地固化（0.1.7 上该插件通常不可用 ⇒ 回落到插件内置默认值） |
| credential | DSH CredentialRef（默认 `VISION_API_KEY`） |
| promptExtra | 附加指令（≤2000 字符，拼在代读请求尾部） |
| 其余 | timeoutMs / concurrency / cache / maxImageBytes / maxImagePixels / visionCapabilities / language / autoMode.maxPerTurn —— 见 `docs/design.md` §5.7 |

## 安装

### A. 直接 link 到本仓库（推荐）

1. profile 的 `package.json` 依赖加一行（`link:` = 链接，改源码重启即生效）：
   `"@dsh-external/dsh-vision-bridge": "link:<本仓库绝对路径>"`
2. `dsh.profile.bundles` 数组追加 `"@dsh-external/dsh-vision-bridge"`。
3. 在 profile 目录跑 `pnpm install`。
4. 重启 DSH。

### B. `file:` 依赖（复制安装）

用 `"file:<路径>"` 也能装上，但 pnpm 会**复制**一份到 `node_modules`：以后每改一次插件源码都要重跑 install（或手动同步副本）才生效。

> ⚠️ 挂载由插件自带的 `cordis.patch.yml`（dsh.bundle.patch）自动完成。**不要**在 profile 的 `cordis.patch.yml` 里再手动加同名 insert 行——两处同 id 会以 `duplicate loader entry id` 崩掉启动。配置覆盖走 settings.yaml 的 `vision-bridge:` 键。

> 桌面版（`DSH_PROFILE=desktop`）与 web 版装法相同，差别只在 profile 目录（`<DSH_HOME>/profiles/desktop`）。

## 已知限制

- **运行时缝依赖一个内部方法名**：它装饰的是 `llm.resolveModelInfo`。若未来内核改名，插件会打一行 error 并在体检区显示未生效（不静默），但需要按新内核适配。
- **代读不可用时不放行**：`seam.requireReader`（默认 true）在视觉 provider/凭证未配置时**不注入**，带图消息仍被硬拒绝。这是有意的——宁可明确拒绝，也不制造「消息发出去了但没人看图」。
- **磁盘补丁与探针尚未随缝让路**（登记为下一批）：缝生效时本应跳过旧的磁盘自愈与行为探针；当前未接。开启 `VISION_BRIDGE_ADMISSION_PROBE=1` 的部署里，探针会把「缝在跑」读成 `runtime=dead` 且会留下一条合成消息——**不要把它当作磁盘证据**（详见 `docs/VERIFY.md` §12 已知偏差）。
- **modlens 用户**：modlens 的粘贴接管与本品设计重叠（同为文本模型读图）。已装 modlens 时请在卡片体检区「一键关闭」其接管（或 profile patch 行 `pasteToPath: false`），否则贴图被它截走。modlens 其余能力（路径/URL 读图、全文 OCR）与本品分工并存。
- **回合取消只覆盖附件读取**：取消时 `readImageRequest`（附件字节读取）即时中止；经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 `adapter.call`，受不改库源码约束）。上游库为 analyze 增加 signal 透传后可根治。
- 8-hex 前缀为 32bit 空间，理论碰撞率低但非零；多命中时返回候选列表。
- **卡片位置随内核代际变化**：0.1.6 在「设置 → 插件」，0.1.7 在「内置插件 → 插件行详情页」的配置区（见上「设置」）。
- **0.1.6 客户端槽面未真机核验**：老代槽服务是否提供声明探测面与等声明面未验；若两者皆无，卡片将不挂载（留一条 warn），而改造前是直接注册老槽位。
- **两个文件先于双代兼容批超 500 行参考线**：`lib/client.js` 1636 行、`lib/index.js` 571 行；拆分（客户端需先验两代 chunk 装载面）登记为后续工作。

- `CHANGELOG.md` — 变更记录（v0.1.0 → v0.2 系列逐版本）
- `docs/design.md` — 设计文档（§5 核心 / §10 设置 v1 / §11 卡片 v2 / §12 启动自愈+探针；含偏差记录）
- `docs/design-v4-runtime-seam.md` — **运行时服务缝设计 v4.1**（当前生效的准入机制；含评审响应表）
- `docs/VERIFY.md` — 人工验收清单（§8 卡片 v1 / §9 卡片 v2 / §10 自愈+探针 / **§12 运行时缝**）
- `docs/review-design-v4*.md`、`docs/review-impl-v4*.md` — 四轮独立评审报告（设计 2 轮 + 实现 2 轮）
- `docs/HANDOFF-2026-09-26.md` — **本次交付的交接状态**（做了什么 / 未做项 / 如何回退 / 命令备忘）
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
