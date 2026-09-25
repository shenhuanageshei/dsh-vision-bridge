# VERIFY — dsh-vision-bridge 人工验收清单

权威依据：`docs/design.md`（插件长期设计）；双代兼容验收（§11）的依据由该节各条目自述。
接线已写好但**本交付不重启 DSH web、不执行 profile pnpm install**——以下第 0 步完成后逐条人工验证。
**〔2026-09-07 §10 交付注〕**设置界面交付（design §10）已用 robocopy /MIR（排除 .git、node_modules）把含 `lib/client.js`
与新 `package.json`（`dsh.client` 声明）的源码同步到安装副本，**但未重启 DSH web**——重启 + 浏览器硬刷新 +
§8 活体验证由主会话执行（重启会终止运行中的会话，不在交付内完成）。

## 0. 安装与挂载（先决）

1. ```powershell
   cd <DSH_HOME>
   pnpm install
   ```
   （`@dsh-external/dsh-vision-bridge` 经 `file:../../../plugins/dsh-vision-bridge` 进 profile 依赖闭包。**这一步不可省**——2026-09-05 曾因加了依赖没跑 install,启动即 `cannot resolve profile bundle` 三连崩;且 file: 依赖是复制不是链接,此后每次改 `plugins/dsh-vision-bridge/` 源码都要重跑本步(或手动同步 `profile/profiles/web/node_modules/@dsh-external/` 副本)才生效。挂载由插件自带 cordis.patch.yml 完成,**不要再往 `profile/cordis.patch.yml` 手动加同名 insert 行**(duplicate loader entry id 同样崩启动);覆盖配置走 settings.yaml 的 `vision-bridge:` 键。）
2. 重启 DSH web。
3. 启动日志检查：无 `cannot get property "x" without inject`；无 `vision-bridge` 相关 error/warn（除预期的 info 行
   `vision-bridge: first run — froze provider defaults …` 或 `configuration applied live`）。
4. 首运行固化检查：`<DSH_HOME>\vision-bridge\provider-defaults.json` 生成（本 profile 已在 settings.yaml 显式给出
   provider，固化文件内容与之一致）。
5. 设置页出现 vision-bridge 配置面，字段与 design §10.1 一致（mode/provider/credential/timeoutMs/
   concurrency/cache/maxImageBytes/maxImagePixels/visionCapabilities/language/autoMode/**promptExtra**）。
   **〔2026-09-07 勘误〕** v0.1.x 无 client 半侧，设置页本就**不可见**（design §5.7 勘误：无卡片即不渲染）——
   本条自 §10 交付起，按 §8 在 设置→插件 页的 vision-bridge 卡片上验证。
6. 缓存目录 `<DSH_HOME>\vision-bridge\cache\` 在首次分析后出现 `tool.json` / `auto.json`。

## 1. 多模态模型声明 image 后原样直读

1. settings.yaml 中 `llm-pi-ai.providers.zai-coding-cn.models` 的 `glm-5.3-flash` 与 `glm-5v-turbo` 已声明
   `input: [text, image]`（本次交付已完成；重启后生效）。
2. 会话选择 glm-5.3-flash，粘贴一张截图并发问"这张图里有什么？"
3. 预期：模型直接描述图片内容；会话不出现 `UNSUPPORTED_CONTENT`；请求管线无 vision-bridge 工具调用。
4. 反向确认：切到未声明 image 的模型（如 glm-5.1）重复粘贴，模型消息里出现
   `[image omitted … attachment sha256:xxxxxxxx]` 占位符（投影生效）。

## 2. 文本-only 模型：tool 模式代读 + 多命中候选

> **✅ 2026-09-07 活体验证通过(本节 1–3 项)**：全新 CDP 浏览器页面(文本-only 模型 glm-5.3)：
> 合成粘贴与真实键盘 Ctrl+V+OS 剪贴板位图均出缩略图;粘贴 120×60 PNG 后
> user/message seq7 真实入账 image block(sha256:53c42ca9…);模型 reasoning 引用
> "image was omitted because this model accepts text only" 占位符;显式调用
> vision_bridge_read{ref:"53c42ca9"}(seq1491)返回带 [UNTRUSTED EVIDENCE…] 头的
> 结构化描述并正确读出图中文字(seq1492);auto 模式同轮 vision-context 注入在首轮
> 亦生效;glm-5.1 下粘贴同样成功。取证细节与"用户旧标签页需硬刷新"结论见
> `HANDOFF.md`。4–6 项(多命中/坏 ref/取消)由单测覆盖(tests/TEST-MATRIX.md)。

1. 在文本-only 模型会话中，**直接 Ctrl+V 粘贴截图**（或回形针附图）并发问"报错信息是什么？"。
   依据：本部署已对服务端准入打本地补丁（`scripts/patch-admission-gate.mjs`，带 .bak 备份）——准入不再按当前模型拒图；
   图片照常入账，请求时由运行时投影为占位符，进入桥的 tool 模式。
   **DSH 更新后若验收 §2 失败，先重跑该脚本再重启**（核心包更新会覆盖补丁）〔2026-09-09 勘误:§12 启动自愈已自动化此动作,重启即自检重打;手动重跑仅作自愈失败后的兜底〕。
2. 预期：模型看到占位符后调用 `vision_bridge_read`（ref=8-hex）→ 返回带
   `[UNTRUSTED EVIDENCE …]` 头的结构化描述（image_overview/visible_text/objects_and_layout/user_request_answer…）。
3. 模型依据描述正确回答原问题。
4. 多命中：向同一会话粘贴两张内容不同但可在占位符中同为 8-hex 前缀碰撞的图（或直接让模型用 4 位以下短前缀调用）→
   工具返回 isError，消息列出全部候选（seq/尺寸/类型），不猜测。
5. 坏 ref：传 `ref: "hello"` → isError 且提示可用的 8-hex 列表；`ref: "00000000"` → isError 列出现有图片。
6. 取消：工具执行期间点击停止 → **附件读取（readImageRequest）即时中止**。已知边界：经引擎
   `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把
   信号传入引擎内部的 adapter.call；受不改库源码约束）——上游库为 analyze 增加 signal 透传后可根治。

## 3. auto 模式：同轮注入、超时不阻塞、失败仅日志

> 定位说明〔2026-09-07 改写〕：本部署已打服务端准入补丁（`scripts/patch-admission-gate.mjs`），文本-only 会话
> 新图照常入账——auto 的触发条件在补丁生效时**可以自然发生**，并已于 2026-09-07 活体验证（文本-only glm-5.3
> 会话，auto 同轮 `<vision-context>` 注入真实出现，见 §2 活体记录）。「防御性兜底」框定仅适用于未打补丁的
> 窗口（DSH 更新覆盖核心包后、重跑补丁脚本前）。本节步骤为常备回归流程；单测层 tests/auto.test.mjs 覆盖不变。

1. 设置页把 `vision-bridge.mode` 改为 `auto`（或保持 `both`）。
2. 文本-only 模型会话粘贴截图 + 问题"截图里报错是什么？"。
3. 预期（VLM 快于装配时）：当轮模型消息流中出现 `<vision-context>…</vision-context>`（plugin 来源，标注
   "该解读回答的是附图当时的问题"），模型据此作答。
4. 超时路径：把 `timeoutMs` 临时调小（如 1000）后贴图提问 → 回合不被阻塞（模型正常回答，只是没图可看）；
   稍后同会话再发一条消息 → 迟到的解读经动态上下文出现一次，且**不**在后续每步重复（消费后剪除）。
5. 失败路径：把 credential 改成未配置的名字 → 贴图提问 → 回合正常进行，日志仅有
   `vision-bridge auto: analysis failed …` warn，无注入。
6. 每轮上限：一条消息贴 >maxPerTurn 张图 → 日志 warn "beyond autoMode.maxPerTurn"，仅前 N 张被分析。

## 4. compaction / fork / resume 后旧图仍可解析（tool 模式）

1. 长会话贴多张截图，触发/等待 compaction（或手动构造长上下文）。
2. 之后让模型用先前截图的 8-hex ref 调用 `vision_bridge_read` → 仍能解析并返回描述
   （原始日志 append-only，影子协议不改写）。
3. fork 该会话 → 子会话中对父会话截图的 ref 调用工具 → 成功（全量扫，含 fork 前缀）。
4. 重启 DSH web 后 resume 该会话 → 同上成功（事件种子不重放，工具按 snapshotEvents 现场全量扫）。

## 5. 双模式缓存不串答案

1. tool 模式对同一张图先问 A（如"什么颜色？"）再问 B（如"写了什么字？"）→ 第二次必为一次新 VLM 调用
   （两次答案不同、且日志显示两次调用；同问重发则秒回缓存）。
2. auto 注入的 note 与 tool 对同图同问的答案互不影响：检查 `cache\tool.json` 与 `cache\auto.json`
   键空间独立（不同文件）。
3. 改 provider.model 或 language → 再次同图同问 → cache miss（指纹变化），旧条目留存待 LRU/TTL 老化。

## 6. fiber 重启可重建、disabled 行 warn 不致命

1. 设置页改 `vision-bridge.timeoutMs` → 日志 `configuration applied live`，工具与 auto 继续可用（状态重建）。
2. 手工把 settings.yaml 里 vision-bridge 的 `timeoutMs` 改成非法值（如 5）→ 日志
   "keeping the previous configuration after a refused settings generation"，插件仍以旧配置服务。
3. 在 profile cordis.patch.yml 临时给 vision-bridge 行加 `disabled: true` → 启动仅 warn-skip，web 正常起；
   撤销后恢复。

## 7. 设置页改 provider/mode 即时生效

> 〔2026-09-07 勘误〕v0.1.x 无设置界面（design §5.7 勘误），本节步骤在当时不可执行；§10 交付后经
> 设置→插件 页 vision-bridge 卡片执行（见 §8），`promptExtra` 同理即时生效（纳入缓存指纹，改动即 miss）。

1. Web 设置页改 `provider.model` → 无需重启，下一次工具调用/自动分析即用新模型
   （缓存指纹随 model 变化，自然 miss）。
2. `mode` 在 tool ↔ auto ↔ both 间切换 → 立即生效（gate 每事件/每步实时判定）：
   切到 tool 后贴图不再触发自动分析；切回 both 恢复。
3. `provider.credential` 指向另一已配置凭证名 → 下一次调用即用新凭证（per-operation resolve，无重启、无缓存）。

## 8. 设置界面卡片 + promptExtra(2026-09-07 增订,design §10)

> **✅ 2026-09-07 活体验证通过(本节 1–6 项全部)**:重启 DSH web(15:44)+ 全新页面后,
> 设置→插件 页出现「Vision 截图代读」卡片,10 字段当前值与 settings.yaml 逐项一致;
> 卡片写 promptExtra「…MARKER-EXTRA」保存(落盘 settings.yaml)→ 文本-only 会话贴图提问,
> VLM note 正确读图且**尾部带 MARKER-EXTRA**(指令即改即生效,零重启);同图同问改指令为
> MARKER-SECOND → 显式工具调用返回**全新 note**(缓存 miss)尾部 MARKER-SECOND,旧标记
> 不再出现;清空指令 → settings.yaml 行移除,回默认;timeoutMs=5 保存 → banner「保存被
> 拒绝(可能是非法值);旧配置继续生效,草稿已保留。」+ 草稿保留 + 重置回 60000 +
> settings.yaml 不变;F5 后卡片存活、值正确、零 console 错误。取证明细见主会话
> (session-de098681,seq 3153/3212/3443/3630 证据)。附注:服务端日志无 UI 拒收行系
> settingsScope 契约丢弃 response.error 所致(design §10.8-1 已声明,UI banner 即补偿);
> CDP 合成键 Ctrl+V 在调试实例失灵为环境怪象(纯 data: 页同样复现),合成 ClipboardEvent
> 全链路通过,真实键盘粘贴由用户亲测闭环。

> 前置:插件源码(含 lib/client.js 与 package.json 的 dsh.client 声明)已 robocopy 同步安装副本,重启 DSH web,浏览器**硬刷新**页面(client 插件清单变化)。

1. 设置 → 插件 页出现 **vision-bridge 卡片**,字段与 design §10.1 一致(provider.baseURL/model、credential、mode、language、promptExtra 多行、outputFormat、timeoutMs、concurrency、autoMode.maxPerTurn),当前值与 `settings.yaml` 一致。
2. UI 改 `provider.model` 保存 → 无重启,下一次 `vision_bridge_read` 用新模型(日志可见,缓存 miss)。
3. promptExtra 写「回答末尾附一行 MARKER-EXTRA」保存 → 文本-only 会话贴图提问,代读输出含该标记;
   同图同问改指令再问 → 不命中旧缓存(新答案);清空指令 → 输出回默认。
4. 非法值(timeoutMs=5)保存 → 卡片显示**保存失败提示**(具体原因不回传,系 settingsScope 公开契约边界,
   见 design §10.8;原因看服务端日志 keeping the previous configuration 行),旧配置生效;
   promptExtra>2000 由客户端预拦截(保存禁用+红字提示)。
5. client 半侧加载零 console 错误;F5 后卡片仍在;profile cordis.patch.yml 临时加
   `disabled: true` → 卡片消失且设置页不崩(撤销恢复)。
6. 插件根 `node --test` 全绿(含 promptExtra 新用例)。

## 9. 设置卡片 v2:Provider 联动 + 凭证三形态 + 连通验证 + 环境体检(2026-09-07 增订,design §11)

> 前置:§11 交付后 robocopy 同步安装副本 → 重启 DSH web → 刷新页面。

1. 卡片标题显示「**dsh-VisionBridge 视觉代读**」;三组分区(视觉引擎/触发与输出/高级折叠);首次露出核心 7 字段(Provider/模型/BaseURL/凭证/触发模式/回答语言/附加指令)。
2. Provider 下拉列出 DSH 已配置 providers;选中后 model 下拉只列该 provider 模型(vision-capable 带 👁);Base URL 与凭证自动带出(可改)。
3. 选「自定义」→ 四字段解锁手填,视觉上以边框色区分联动模式。
4. 凭证下拉:已存条目列表(带来源说明)+「粘贴新 API Key…」;贴入密钥保存 → 凭证条目自动创建(密钥不落 vision-bridge 配置)→ 输入框清空、credential 字段变为条目名。
5. 「验证连通」按钮:验证中态 → **✓ 连通**(模型+延迟)或 **✗ 失败**(具体原因:401/404/超时)。
6. 环境体检区:准入补丁/modlens 冲突检测正确;⚠ 项显示「一键修复/一键关闭」→ 点击后提示「已应用,重启 DSH web 后生效」;全 ✓ 时缩为一行「环境就绪」。
7. §8 的 1-6 项(保存/重置/拒收保旧/promptExtra/F5)全部不回归。
8. 插件根 `node --test` 全绿(含 §11 新用例)。

## 附：自动化测试

- 插件根：`node --test`（318 用例、零失败；vendor 引擎库 108 例 + 插件层 210 例——其中 §11 增补 client 静态 16 例
  （client-static 总 30）、服务端路由 46 例、§12 增补 self-heal 22 例；§10 前基线 234 例、§12 前基线 296 例）。
- 真实调用冒烟：设置 `VISION_BRIDGE_SMOKE=1`、`VISION_BRIDGE_SMOKE_BASEURL`、`VISION_BRIDGE_SMOKE_MODEL`、
  `VISION_BRIDGE_SMOKE_KEY` 后运行 `node --test tests/smoke.test.mjs`。
- **本批双代兼容（2026-09-24）**：插件根 `node --test`（插件层 267 例 + vendor 引擎库 108 例 = **375 用例、零失败**，基线 318 只增不减）；
  新增 `tests/client-adapter.test.mjs` 24 例（假 `__ModuleLoader__` 捕获 def → 组件直调：槽梯/三态/写路径/凭证面/双语文案）；`client-static.test.mjs` 现 33 例；老用例零回归。
  新增 `tests/dual-gen.test.mjs` 30 例（同批二轮补落）——服务端新分支自动覆盖：能力分派与守卫（§7-1/9、§7-5②）· 自愈前移行序（§7-8）· 0.1.7 引用装配与读法（§7-2/3）·
  校验拦截与拒收保旧（§7-4）· 跨命名空间 `describe()` 读与 provider 投影（§2.1-18、§7-13）· 附件尺寸折算等价（§2.4，含 400 样本宿主活体对拍）。
- 用例 × 验收映射：`tests/TEST-MATRIX.md`。
## 10. 启动自愈 + 行为探针(2026-09-09 增订,design §12)

> 前置:§12 交付后 robocopy 同步安装副本。自愈在下次 DSH 重启时生效(不强制重启;探针在设置卡片被打开时即时可用)。
>
> **〔2026-09-09 交付注:运行时探针的生产接线状态〕** design §12.2 B 设想探针经「插件注入的 RPC 面」提交合成消息。实证该面**存在,但不在顶层 inject 清单内**:宿主服务 `ctx.get('sessionController')` 暴露 `prompt(request, signal)`(`dsh-api-session-controller/lib/index.js:2772-2775`;服务名注册见同文件 `:2598`)与 `create({sessionId})`(`:2707`,幂等采纳)。本交付按任务硬约束 2(「不要真调 session/prompt」)**默认不接线**:未接线时探针返回 `runtime=unknown`,体检区显示中性「准入补丁已写入磁盘——运行时状态未验证」,而**不冒充 ✓**。三态行为由单测 stub 全覆盖(`tests/self-heal.test.mjs`;§12.5 映射见 `tests/TEST-MATRIX.md`)。
> **要在活体上验证三态**:启动 DSH web 前设 `VISION_BRIDGE_ADMISSION_PROBE=1`(env 变量,非 schema 字段)。此时探针经真实 RPC 面提交 1×1 PNG:闸活→拒绝码→`live`;闸死→入账→`dead`(并触发 cleanup seam;宿主无「删除会话消息」API,scratch 会话 `session-vision-bridge-admission-probe` 会留一条合成消息,§12.6-20 已登记该残留)。移除该变量即回默认关闭。

1. 磁盘补丁在 + 正常启动:boot 日志零 vision-bridge 补丁行;env `disk=patched`;探针 `runtime=dead`(需上面的 opt-in)时体检区 ✓「准入补丁已生效」;未 opt-in 时中性「运行时状态未验证」。
2. 磁盘补丁失(换入干净 .bak 再重启):boot 日志一行 `[vision-bridge] admission gate re-patched after update (effective on next boot)`;env `disk=patched`;同次重启内文本模型会话贴图入账(端到端)。若探针报 `runtime=live`:体检区显示「⚠ 已修复磁盘,重启后生效」(`admission.conflict=true`),再重启一次后 `runtime=dead`。
3. 自愈失败(stub 拒绝单测模拟):插件照常启动零 crash;体检区 ⚠ + 一键修复按钮可用。
4. 探针三态:入账=`dead`;拒绝码=`live`;agent-busy/异常/超时=`unknown`(不误报)。
5. `node --test` 全绿;patch 脚本 CLI 既有用例零回归。

## 11. 双代兼容 DSH 0.1.6 / 0.1.7(2026-09-24 增订)

> 前置:交付后 robocopy 同步安装副本(排除 .git/node_modules)→ `pnpm install` → **重启 DSH web**(0.1.7 上不重启则插件仍是"不激活"态)→ 浏览器硬刷新。
> 本清单在 0.1.7 宿主上验证新面;0.1.6 侧以「老路径原样保留 + 老用例全绿」验证不回归。

1. **装载(F1)**:启动日志无 `ctx.settings.register is not a function`;`dsh --dump-config` 的 did not activate 清单不含 vision-bridge;插件页出现本插件的配置入口(不再永久 pending)。
2. **卡片可用(F5/F6)**:标题 / 三组分区 / 字段集与 §9-1 清单逐条一致;改一项设置保存 → 不重启即生效(运行期读数变化);外部改动经订阅反映到卡片。
3. **生效值(F2/F3)**:行配置的值进入运行期(体检区 / 日志读数一致);改一处可编辑值后运行期状态被重建。
4. **保旧(F4)**:写入非法值(如 `timeoutMs: 0`)⇒ UI 保存被拒 / 报错,插件继续用旧值服务(贴图链路仍可用)。
5. **代读链路(F7)**:纯文本模型会话贴图 → 占位符 → `vision_bridge_read` 返回结构化描述;请求图尺寸不超过 `maxImagePixels` 折算结果。
6. **启动自愈(F8)**:换入干净 `.bak` 后重启 ⇒ 一行 `admission gate re-patched after update`;体检区按 §10-2 三段显示;patch 脚本 CLI 直跑照旧。
7. **静态面(机器可核)**:仓库根 `node --test` 全绿;client-static 断言 inject 列表**不含** `settingsScope`;
   服务端 `ctx.settings.register(` 的每一处出现**都在能力探测守卫之内**(老分支保留该调用 ⇒ 机器可核形式取「受守卫」;该条现由 `tests/dual-gen.test.mjs` 源码扫描断言机检);
   自愈调用点**位于所有 settings 面调用之前**(F8 静态断言,`lib/index.js:335` < `:344`/`:356`;同由 `tests/dual-gen.test.mjs` 源码扫描断言机检)。
8. **降级可见**:卡片进入 `unavailable`(内核不暴露设置面)⇒ 只读提示 + 保存禁用,**不冒充**可写;两代槽位皆不可用 ⇒ 不挂载 + 一行 warn(控制台可观测)。
9. **不回归(F9)**:§8 的 1-6 项、§9 的 1-7 项、§10 的 1-4 项在 0.1.7 上重跑通过;老用例(settings-lifecycle / client-static 老断言)全绿。

> 计数回填:已回填(375;基线 318,只增不减)——见「附:自动化测试」;本批新增用例组在该小节列出。
## 12. 运行时服务缝（2026-09-25 增订；2026-09-26 补齐 §4.6/§4.7 并发布 0.3.0）

> 前置（**2026-09-26 起改为直接 link，不再 robocopy 同步**）：桌面版 profile 的插件入口
> `C:\Users\magic\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-vision-bridge`
> 已由 junction 直接指向本仓库 `D:\DSH-Portable\plugins\dsh-vision-bridge`；profile 依赖也已改为 `link:`，
> `pnpm install` 不会把它重建回复制副本。**改完源码只需重启 DSH 即可生效。**

> **〔2026-09-26 验收记录〕** §12-3 已在 DSH 桌面版 0.1.7-rc.2 上通过：纯文本模型（GLM-5.3）会话贴图发送成功并完成代读
> （sha256:170ffeed，895×298，测试会话 `session-b37fe071`）。其余各条的自动化部分（插件装载、代读引擎连通、
> 设置投影未被污染、不产生假 ✓）已由 lead 逐条实测，结论见 `docs/HANDOFF-2026-09-26.md`。
>
> **〔2026-09-26 收尾记录〕** §4.6（卡片四行）与 §4.7（缝 live 时让路磁盘自愈与行为探针）已交付并过评审；
> 本清单新增第 10–13 项。测试基线 **428 用例**（`tests/seam.test.mjs`、`tests/seam-runtime.test.mjs` 等）。

1. 装载：启动日志出现一行 `vision-bridge seam: installed on llm.resolveModelInfo (image capability injection active)`；无 error。
2. 自证（§4.5-2）：日志 `runtime seam live — self-check passed (<provider>:<model>)`；取不到自证路由时是 `installed but not self-verified — …`（中性，不得出现假 ✓）。
3. 端到端（E2）：纯文本模型会话 Ctrl+V 贴图 → 发送**成功**（不再出现「当前模型不支持图片」）→ 会话日志含 image block → 模型上下文出现 `[image omitted … sha256:xxxxxxxx]` → `vision_bridge_read` 返回结构化描述。
4. 多模态回归（E3）：`glm-5.3-flash` 贴图仍原生内联；装缝前后 `resolveModelInfo` 逐字段相同。
5. 子代理（E4）：给纯文本子代理发图不再报 `subagent/attachment-invalid`。
6. 卸载还原（E5/E5b）：停用插件 → 贴图恢复硬拒绝；再启用 → 缝可正常重装（不出现 `already` 假阳性）。
7. live 配置（E6/E7）：`seam.mode=off` 不重启即回到硬拒绝；`seam.include` 收窄后，被排除路由仍被拒、被包含路由放行。
8. 代读前置（B5）：把 provider/credential 清空 → 缝不注入，贴图仍被硬拒（不得出现「发送成功但无人读图」）。
9. `node --test` 全绿。
10. 卡片四行（§4.6）：体检区显示「运行时缝 / 标记残留 / 代读可用性 / 磁盘补丁（遗留）」四行——
    缝自证通过 ⇒ 第 1 行 ✓ 且第 4 行标「对本部署不适用——已被运行时缝取代」、不显示一键修复；
    缝已装但未自证 ⇒ 第 1 行**中性**（不得 ✓），汇总行也不折叠为「环境就绪」；
    缝 off / 不可用但磁盘补丁仍工作 ⇒ 汇总**可以**折叠为「环境就绪」（两条通路任一成立）。
11. 探针让路（§4.7-2）：缝 live 时 `VISION_BRIDGE_ADMISSION_PROBE=1` 的运行时探针**不执行**，体检区显示第三态
    （`admission.runtime === 'skipped'`、`reason === 'seam-live'`），**不再**产生 scratch 合成消息；缝非 live 时探针照旧。
12. 自愈让路（§4.7-1）：同一进程内的后续挂载，缝 live 时跳过磁盘自愈并记一行 info；冷启动（live 未知）照旧修复；
    本次基座把 seam 关掉（`seam.mode=off`）时**不**沿用上一次的 live 结论去 stand down。
13. env 契约：`GET /vision-bridge/env` 的 `seam` = { status, live, reason, mode, include, requireReader, residue }；既有字段一字未改。

**已知偏差（截至 0.3.0）**：

- **N-B2-3（告警闩锁覆盖面）**：闩锁按 `route+reason` 键控，`buildModelCatalog` 那种「N 个不同纯文本模型各调一次」仍每 route 一行 warn；
  昂贵项（每次调用的凭证解析）已由 5s TTL 缓存归零，剩余成本受投影内纯文本模型数约束（`lib/seam.js` 的 JSDoc 已登记，刻意不在本批做）。
- **外观一致性（lead 裁决接受）**：在「缝 unsupported + 磁盘补丁可用」这一**今天不存在**的部署里（需内核改名或服务实例不可扩展），
  第 1 行会显示 ✗ 而汇总行折叠为「环境就绪」——即第 1 行的 ✗ 被汇总行隐藏。
- **TTL 窗口**：凭证判据有 ≤5s 缓存，撤销凭证后最长 5s 内仍会注入（与「配置可用 ≠ 运行可用」同源）。

- 历史偏差全部已修（0.3.0）：§4.7-1 / §4.7-2 让路、N-I2 凭证缓存与告警抑制、N-I4 `llm` 后到重试、N-I6 标记写入回滚。
- **N-B3-1 已修（lead 执行 + 变异验证）**：F1 守卫的回归用例补上凭证接线后，删掉 `!seamUnproven` 会使其失败（修复前该用例在变异下恒真）；全量 428/428。
