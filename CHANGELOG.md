# Changelog

本文件记录 dsh-vision-bridge 的对外变更。格式遵循 Keep a Changelog；版本号遵循 SemVer。

## [Unreleased]

## [0.3.0] - 2026-09-26

### Changed

- **§4.7 让路**：运行时缝自证生效时，磁盘准入自愈（`selfHealAdmissionGate`）与运行时行为探针都跳过——探针返回第三态
  `runtime: skipped`（`reason: seam-live`），**不再**产生 scratch 合成消息，也不会把「缝在跑」读成「闸已失效」。缝不可用时两条旧通路照旧工作。
- **§4.6 卡片**：环境体检区改为四行（运行时缝 / 标记残留 / 代读可用性 / 磁盘补丁遗留）。未自证的缝一律显示**中性**，绝不冒充 ✓；
  折叠汇总行同步修正：既不再把「缝已装但未自证」折叠成「环境就绪」（假 ✓），也不再让「靠磁盘补丁工作的部署」永远折叠不出「环境就绪」（假 ✗）。
- **凭证判据**（N-I2）：`readerAvailable()` 增加 5s TTL 缓存与「允许→拒绝」告警闩锁，`buildModelCatalog` 的批量调用不再每个模型解析一次凭证。

### Added

- `GET /vision-bridge/env` 新增只读 `seam` 字段（status / live / reason / mode / include / requireReader / residue）。
- `ctx.inject(['llm'], …)` 后到重试（N-I4）。
- 测试：新增 `tests/seam-runtime.test.mjs`（运行时让路与 env 契约）；全量 **428 用例**（0.2.0 基线 405）。

### Fixed

- 标记写入失败时先回滚再降级（N-I6），不再留下「方法被替换且抛错」的中间态。
- `seam.mode=off` 的那次挂载不再沿用上一次的 live 结论跳过磁盘自愈。
- F1 守卫的回归用例原本是空转的（未接凭证面 ⇒ 断言恒真，删掉守卫也能过）：已按评审 N-B3-1 补上凭证接线，并用变异实验验证——删掉 `!seamUnproven` 时该用例现在会失败。

## [0.2.0] - 2026-09-26

### Added — v0.2 系列开发中

#### 运行时服务缝（design v4.1，2026-09-26）—— 取代「改内核源码」的准入策略

- **动机**：DSH 桌面版把内核打包进 `resources/app.asar`，`scripts/patch-admission-gate.mjs` 那套「按目录改内核源码」够不到，
  纯文本模型（如 `zai-coding-cn:glm-5.3`，`input: []`）发图仍抛 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
- **关键发现**：DSH 判定「模型认不认图」走两条**互不调用**的路径 ——
  准入闸（session controller `prompt()` / subagent `assertImageCapable()` / ACP `assertImageRoute`）读**服务方法** `llm.resolveModelInfo`；
  图片投影（`LlmRuntime.adapterStream` → `[image omitted … sha256:xxxxxxxx]`）读 `adapter.prepareCall().model`。
  装饰前者让闸门放行，投影照旧发生 ⇒ 图能入账，插件照旧代读。**零内核改动、零落盘**。
- **新增 `lib/seam.js`**：对**真实服务实例**（`Symbol.for('cordis.original')`）操作；`Object.defineProperty(…, enumerable:false)` 保真；
  `delete` 还原并清标记；`already` 走**行为自证**（标记在但层不是我们的一律按未装处理）；三态 `installed / already / unsupported`。
- **新增三个 live 配置键**：`seam.mode`（auto/off）、`seam.include`（`provider:model` 白名单，非法项整体拒绝保旧值）、
  `seam.requireReader`（默认 true：代读不可用则**不注入**、保持硬拒绝，杜绝「发送成功但无人读图」）。
- **接线**：`apply()` 最先安装（挂在 `ctx.effect` 上受 fiber 生命周期保护；整段 try/catch → 还原 → 抛出）；
  `settings.watch` 驱动 卸载→重算→重装；disposer 还原。
- **`lib/auto.js` 2 行**：round-3 模态门禁改读 `resolveModelInfoUnseamed()` —— 否则自动代读会把纯文本会话读成「能收图」而跳过代读。
- **测试**：新增 `tests/seam.test.mjs` 30 例（含每条修复的变异回归）；仓库根 `node --test` **405 用例零失败**（基线 399）。
- **评审**：四轮独立评审（设计 FAIL→PASS、实现 FAIL→PASS），报告见 `docs/review-design-v4*.md`、`docs/review-impl-v4*.md`；
  当前状态与未做项见 `docs/HANDOFF-2026-09-26.md`，人工验收清单见 `docs/VERIFY.md` §12。
- **本机安装方式**：profile 依赖由 `file:`（复制）改为 `link:`，插件目录直接指向本仓库 —— 改源码不再需要同步，重启即生效。
- **真机验证（2026-09-26，DSH 桌面版 0.1.7-rc.2）**：重启后纯文本模型会话（GLM-5.3）贴图**发送成功**，图片入账并由视觉引擎代读返回结构化描述（测试会话 `session-b37fe071`）；`node --test` **405 用例零失败**。

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

#### 双代兼容（DSH 0.1.6 / 0.1.7）（2026-09-24）

- **背景**：DSH **0.1.7 重写了设置服务面**（`settings.register` / `get` / `installSection` 均不再存在；客户端 `settingsScope` 亦改名搬家）。后果是插件在新内核上**整插件不加载**（`ctx.settings.register is not a function`）、设置卡片**永久 pending**。本批让同一份代码在 0.1.6 与 0.1.7 上都能装、能读配置、能改配置、能代读图片。
- **服务端·能力探测分派**：探 `typeof ctx.settings.register === 'function'`。老代走原路（该分支一行不改）；新代读**响应式配置引用**（`config.<字段>.get()`），配置变更经 `loader/volatile-update` 重建运行期，非法值由 `internal/config` 拦截（**带所有权守卫**，只校验本插件的候选值）并按平台语义**保留旧值**；新代码落独立模块 `lib/settings-compat.js`。
- **配置 schema**：给**卡片可编辑字段**加可热改标记（能力探测包裹——老代 schemastery 无该方法时原样返回，故老代解析不受影响）。字段集与校验语义不变。
- **客户端·数据源适配器**：inject 收敛为 `["slots","locale"]`，删除 0.1.7 上永不满足的 `settingsScope`；改双实现适配器（0.1.7 `configForms` / 0.1.6 `settingsScope`，卡片逻辑零改）+ **槽位候选探测** + 三态 UI（ready / loading / unavailable，**不冒充**可写）。
- **附件签名换代**：0.1.7 的 `readImageRequest` 中参由 `{maxPixels, maxBytes}` 变为 `{width, height, maxBytes}` ⇒ 宿主那套纯几何折算移植进 `lib/request-dimensions.js`（幂等、逐分支等价）；老代仍传旧中参。
- **启动自愈前移**：改为 `apply()` 入口最前调用——0.1.7 上原位置在 `settings.register` 之后，而该调用在新内核会抛错 ⇒ 自愈永不执行。
- **跨命名空间读**：0.1.7 连 `settings.get(ns)` 也没有 ⇒ 改走 `settings.describe()` 投影（provider 联动下拉 / 首次冻结默认值）。
- **验证**：`node --test` **375/375 全绿**（本批前基线 318，只增不减；新增 `tests/dual-gen.test.mjs` 30 例、`tests/client-adapter.test.mjs` 24 例）；静态断言三条（客户端 inject 不含 `settingsScope`、服务端 `ctx.settings.register(` 全部位于能力探测守卫内、自愈调用早于首个 settings 面调用）；**0.1.7 真机活体**：插件装载成功、启动卡片无本插件条目、设置卡片在插件行详情页可见可配、纯文本模型贴图 → 占位符 → `vision_bridge_read` 返回描述（实测通过）。
- **本批遗留边界**：见下 `Known Issues / Boundaries` 前三条。

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
- **设置卡片位置随内核代际变化**（2026-09-24 双代兼容批）：DSH 0.1.6 =「设置 → 插件」内的一张卡片；DSH 0.1.7 =「内置插件 → 该插件行 → **详情页**」的配置区——宿主在 0.1.7 只在行**详情页**渲染该配置槽，列表页只显示描述文字，故 0.1.6 的位置在新内核上不存在。
- **0.1.6 客户端槽面未在真机核验**（本机无 0.1.6 树）：老代槽服务是否提供声明探测面（`spec` / `specDynamic`）与等声明面（`inject`）未验；若两者皆无，卡片将**不挂载**（留一条 warn），而改造前是直接注册老槽位。
- **两个文件先于本批超 500 行参考线**：`lib/client.js` 1636 行、`lib/index.js` 571 行；拆分（客户端需先验两代 chunk 装载面）登记为后续工作。

### 详见

- 设计：`docs/design.md` §11（卡片 v2）/ §11.8（偏差记录 9 项）/ §12（自愈+探针 v2）/ §12.8（偏差记录 8 项）
- 验收：`docs/VERIFY.md` §9（卡片 v2）/ §10（自愈+探针）
- 测试：`tests/TEST-MATRIX.md`（§11/§12 映射行）；`node --test` 375 用例

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
