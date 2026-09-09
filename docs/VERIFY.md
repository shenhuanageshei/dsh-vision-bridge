# VERIFY — dsh-vision-bridge 人工验收清单（设计 §7 七条）

权威依据：`docs/design.md` §7。
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

- 插件根：`node --test`（296 用例、零失败；vendor 引擎库 108 例 + 插件层 188 例——其中 §11 增补 client 静态 16 例
  （client-static 总 30）、服务端路由 46 例；§10 前基线 234 例）。
- 真实调用冒烟：设置 `VISION_BRIDGE_SMOKE=1`、`VISION_BRIDGE_SMOKE_BASEURL`、`VISION_BRIDGE_SMOKE_MODEL`、
  `VISION_BRIDGE_SMOKE_KEY` 后运行 `node --test tests/smoke.test.mjs`。
- 用例 × 验收映射：`tests/TEST-MATRIX.md`。
## 10. 启动自愈 + 行为探针(2026-09-09 增订,design §12)

> 前置:§12 交付后 robocopy 同步安装副本。自愈在下次 DSH 重启时生效(不强制重启;探针在设置卡片被打开时即时可用)。

1. 磁盘补丁在 + 正常启动:boot 日志零 vision-bridge 补丁行;env 探针 runtime=dead;体检区 ✓「准入补丁已生效」。
2. 磁盘补丁失(换入干净 .bak 再重启):boot 日志一行 [vision-bridge] admission gate re-patched after update;env disk=patched;同次重启内文本模型会话贴图入账(端到端)。若 runtime=live:体检区显示「⚠ 已修复磁盘,重启后生效」。
3. 自愈失败(stub 拒绝单测模拟):插件照常启动零 crash;体检区 ⚠ + 一键修复按钮可用。
4. 探针三态:入账=dead;拒绝码=live;agent-busy/异常=unknown(不误报)。
5. 
node --test 全绿;patch 脚本 CLI 既有用例零回归。