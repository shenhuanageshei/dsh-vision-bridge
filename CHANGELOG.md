# Changelog

本文件记录 dsh-vision-bridge 的对外变更。格式遵循 Keep a Changelog；版本号遵循 SemVer。

## [Unreleased]

### Added — v0.2 系列开发中

#### 设置卡片 v2（design §11，2026-09-07~09）

- **卡片改名**「dsh-VisionBridge 视觉代读」（原「Vision 截图代读」）。
- **三组折叠布局**：①视觉引擎 ②触发与输出 ③高级（默认折叠）；首次露出 7 个核心字段。
- **Provider 联动选择**：下拉列出 DSH 已配置 providers（settings.yaml `llm-pi-ai.providers` 投影）+「自定义」；选中后 model 下拉只列该 provider 的模型（vision-capable 带 👁）；Base URL 与凭证引用自动带出（可改）；写回仍为三字段——**schema 零新增**，联动只是填表辅助。
- **内置 baseURL 目录**：服务端扫描 pi-ai 内置 provider 目录提取 32 个 provider 的 baseUrl（zai-coding-cn / minimax-cn 等 DSH 内置 URL 的 provider 不再要求手填）；`/anthropic` 尾缀（Anthropic 协议面）自动改写为同主机 `/v1`（OpenAI 面，实测 404→200）；settings.yaml 显式值仍优先。
- **凭证三形态**：①provider 联动自动带出 ②已存凭证下拉（providers apiKeyEnv + 当前 ref + VISION_API_KEY 候集，宿主无枚举 API 的降级；「输入凭证条目名…」手填兜底）③「粘贴新 API Key…」——密码掩码 + 👁/🙈 切换；保存时经 DSH 凭证服务 describe-then-set **直接覆盖**已存在条目（换钥即覆盖，不再要求无限新增条目名）；密钥不落本插件配置。
- **验证连通按钮**：POST `/vision-bridge/test`（1×1 PNG 单次 analyze，不写缓存；`pendingApiKey` 瞬态密钥仅驻留单次请求）；⏳ 验证中 → ✓（模型+延迟）或 ✗（具体原因：401/404/超时/服务端错误消息）。
- **环境体检区**：连通缓存 + **准入补丁两态**（磁盘标记 + 运行时行为探针）+ modlens 粘贴冲突检测；⚠ 项带折叠人话说明 + 一键修复。
  - **一键修复准入补丁**：调 `scripts/patch-admission-gate.mjs` 的导出函数（幂等，.bak 兜底），提示需重启。
  - **一键关闭 modlens 粘贴冲突**：幂等向 profile 层 cordis.patch.yml 追加 `- id: modlens / config: {pasteToPath: false}` override 行（已存在行缺配置时**合并**进该行，绝不追加重复 id）；已有行+`pasteToPath: false` 则跳过。
- **保存成功徽章**：保存成功后 4 秒绿色「✓ 已保存」。

#### 准入补丁启动自愈 + 运行时行为探针（design §12，2026-09-09）

- **磁盘自愈**：DSH 每次启动时插件自动检测准入闸（`dsh-api-session-controller` 两文件）磁盘标记，未带则自动重打（幂等，.bak 兜底）——**保证下一次启动干净**。重打成功记一行 info 日志（含 `effective on next boot`）；已在则静默零写。
  - 背景：9/8 DSH 核心包更新冲掉补丁 → 9/9 用户贴图被拒半日——「能不能一次做好」。
  - 诚实语义（cordis 并发挂载下加载顺序无保证）：当次启动可能仍运行陈旧闸；硬承诺是**下一次**启动干净。
- **运行时行为探针**（`probeAdmissionGate`，opt-in）：经 RPC 面向 scratch 会话提交 1×1 PNG 合成消息，观测拒绝码——`MODEL_DOES_NOT_SUPPORT_IMAGES`=闸活（live），入账=闸死（dead），agent-busy/超时/异常=unknown（绝不误报）。由 `VISION_BRIDGE_ADMISSION_PROBE=1` 显式开启（默认关——任务硬约束「不要真调 session/prompt」；宿主无消息删除 API，opt-in 启用时 scratch 会话会留一条合成消息，已登记）。
  - 探针假 dead 守卫：scratch 无法钉定文本-only 模型时返回 unknown（多模态默认模型下活闸被误读为 dead 的路径已封死）。
- **体检区准入行四态**：✓已生效（disk=patched & runtime=dead）/ ⚠已修磁盘待重启（disk=patched & runtime=live）/ 中性「运行时状态未验证」（unknown——**不冒充 ✓**，9/9「UI 回显≠服务端真相」误导源的根治）/ ⚠未修+一键修复（disk=missing）。
- 测试 hermetic 化：`VISION_BRIDGE_SELF_HEAL_NM` 覆盖 env——单测永不触真实宿主 node_modules。

### Changed

- **凭证贴密钥语义修订**（2026-09-07 用户反馈）：`set()` 直接覆盖已存在条目（用户本意就是换 Key）；describe 预检与「条目已存在请改名」拒绝逻辑整体移除（曾阻断合法换钥）。
- patch 脚本 `DEFAULT_NM` 从 `DSH_HOME` 推导（公开仓不硬编码贡献者本机路径）；CLI 入口判定用 realpathSync 大小写容忍比较（Windows 驱动器盘符大小写不再静默 no-op）。
- `dsh.client.inject` 增 `@deepseek-ai/dsh-api-remotes`（四包）。

### Fixed

- **一键修复结果提示被同步抹除**（代码评审 #1 🔴）：`runFix` 的 fixMessage 在 refreshEnv 前暂存、await 后回填——「已应用，重启后生效」不再是被合并渲染吞掉的死代码。
- **凭证半失败恢复陷阱**：paste 模式在 `service.set` 成功后立即退出（清 pendingKey）——settings 写失败重试只重跑 mutate，不再撞自己刚建的凭证条目。
- **describe 拒绝被误读为「未配置」**：fail-closed（ok:false → 写入失败），仅显式 `configured === false` 才继续 set——「已有条目不会被覆盖」承诺闭合。
- **验证按钮错误归类**：非 2xx 先解析服务端 JSON error 字段（400「baseURL must be http(s)」不再显示为网络错误）。
- modlens 覆盖行三态：已有 `- id: modlens` 行但缺 `pasteToPath: false` 时**合并**进该行（此前会追加重复 id 行——同 id 双行有 duplicate loader entry 崩启动风险）。
- webServer port 探测双形态（`webServer.port ?? webServer.address?.()?.port`）。

### Known Issues / Boundaries

- **准入补丁与 DSH 更新的关系**（根因记录）：DSH 更新会覆盖 node_modules 核心包 → 补丁被冲掉。§12 启动自愈已自动化恢复；极端时序下（更新后第一次启动）当次会话可能仍遇拒绝——体检区行为探针（opt-in）会显式暴露「已修磁盘，重启后生效」。
- modlens paste-to-path 接管与本插件的设计重叠（同为「文本模型读图」目标）：已装 modlens 的部署建议关闭其接管（卡片一键关闭 / profile patch 行 `pasteToPath: false`）；modlens 其余能力（任意路径读图/全文 OCR/failover）与本插件分工并存（design §6）。
- 回合取消只覆盖附件读取；VLM HTTP 调用不可取消（上游库 `AnalyzeParams` 无 signal 面，不改库源码约束）。
- 8-hex 前缀 32bit 空间理论碰撞率低但非零；多命中返回候选列表。

### 详见

- 设计：`docs/design.md` §11（卡片 v2）/ §11.8（偏差记录 9 项）/ §12（自愈+探针 v2）/ §12.8（偏差记录 8 项）
- 验收：`docs/VERIFY.md` §9（卡片 v2）/ §10（自愈+探针）
- 测试：`tests/TEST-MATRIX.md`（§11/§12 映射行）；`node --test` 319 用例

## [0.1.1] — 2026-09-07

### Added

- **设置卡片 v1**（design §10）：客户端半侧（`lib/client.js`，纯 JS module-loader 协议）注册 `settings.plugin.item` 卡片——设置 → 插件 →「Vision 截图代读」。字段全集（baseURL/model/credential/mode/language/promptExtra/outputFormat/timeoutMs/concurrency/maxPerTurn）+ 保存/重置/拒收保旧行为。
- **promptExtra 附加指令**：拼装在代读请求尾部（≤2000 字符；空/纯空白归一为空；修改后缓存指纹变化自然失效）。
- `dsh.client` 声明（package.json）：platform web + 三包 inject。

### Fixed

- 凭据竞态窗口：`resolveCredential` 与 `bridge.analyze` 之间零 await。

## [0.1.0] — 2026-09-05

### Added

- 首个可用版本：占位符 + 工具代读（`vision_bridge_read`：8-hex 前缀/latest 解析、候选列表消歧）+ auto 预描述注入（agent/pre-step 同轮 + PromptContext 兜底）。
- 准入补丁脚本（`scripts/patch-admission-gate.mjs`）：惰性化 session-controller 两文件的文本模型图片拒绝闸（幂等 + .bak）。
- 双层缓存（内存 LRU + FileCacheBackend）、并发闸 + 在途去重、UNTRUSTED 声明。
- vendor 引擎库（vision-bridge 快照 + tsc dist + 8 vitest 移植 node:test）。
