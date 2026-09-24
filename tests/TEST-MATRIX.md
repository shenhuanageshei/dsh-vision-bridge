# 测试矩阵 — 设计 §7 验收标准 × 测试映射

运行：插件根目录 `node --test`（零依赖 node:test；递归含 vendor 测试）。
真实调用冒烟：`VISION_BRIDGE_SMOKE=1 VISION_BRIDGE_SMOKE_BASEURL=… VISION_BRIDGE_SMOKE_MODEL=… VISION_BRIDGE_SMOKE_KEY=… node --test tests/smoke.test.mjs`。

| 验收/故事 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| 验收2 文本-only 模型占位符 → tool 代读 | 8-hex 前缀解析→描述 | `latest` 默认；多命中候选列表 | 坏 ref/未知 ref → isError+可行动信息 | resolve.test.mjs（findImage 前缀/多命中/精确优先/latest）；tools.test.mjs（bad ref/unknown ref/ambiguous/无图会话） |
| 双占位符形态 | text-only 形态 | offloaded 形态 | — | resolve.test.mjs（stripPlaceholders 两种形态 + placeholderPrefixes） |
| 扫描范围：user/message + tool/result、fork 全量、compaction 影子 | user/message 图 | tool/result 嵌套图 | — | resolve.test.mjs（contentHasImage 对齐/fork 前缀/compaction 影子节点保留） |
| 验收4 resume/fork 后旧图可解析 | snapshotEvents 全量扫 | constructor seed 不发事件 → agent/created 回填 | — | auto.test.mjs（backfill 计数）；tools.test.mjs（事件数组即全量日志） |
| 验收3 auto 同轮注入 | fast path 注入 <vision-context> | slow path 超时放行 → PromptContext 一次性兜底 | failed path 只记日志 | auto.test.mjs（fast/slow/failed/sync-registration/multi-message/maxPerTurn） |
| 回合取消 → 在途调用中止（**仅附件读取**） | 附件读取中止：tool=exec.signal、auto=pre-step 联动 abort | 已取消回合孤儿分析中止 | — | auto.test.mjs + tools.test.mjs（取消断言覆盖 readImageRequest 的 signal）；adapter-wrapper.test.mjs（wrapper 自身的 fetch 级 signal 接线/退避期取消——直连调用可取消）。**已知边界**：经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 adapter.call；受不改库源码约束）——上游库为 analyze 增加 signal 透传后可根治 |
| 超限（字节/像素/每轮条数） | readImageRequest 策略透传（maxPixels/maxBytes） | — | maxPerTurn 截断告警 | settings-lifecycle.test.mjs（policy 断言）；auto.test.mjs（maxPerTurn cap） |
| 验收5 缓存不串答案 | 同图同问命中 | 同图异问必 miss；tool/auto 分 namespace | — | cache-backend.test.mjs（key 组成面/namespace 隔离/LRU/TTL/损坏降级）；tools.test.mjs（命中不再调 VLM） |
| 空 VLM 响应 | — | — | 视为失败不缓存 | adapter-wrapper.test.mjs（EmptyResponseError/不重试）；tools.test.mjs（空响应 isError） |
| 凭证错配/缺失 | per-operation resolve | — | 缺失 → 可行动错误不缓存 | settings-lifecycle.test.mjs（missing credential） |
| 验收6 fiber 重启可重建 | apply 全状态闭包内重建 | disposer 冲刷缓存 | 拒收保旧（watch 校验失败保旧代） | settings-lifecycle.test.mjs（register/validate/watch/disposer） |
| 验收7 设置即改即生效 | watch 重建 + live gate | mode 每事件/每步实时判定 | 校验失败拒收 | settings-lifecycle.test.mjs（update 拒收断言）；config.test.mjs（resolveConfig 校验面） |
| §5.6 适配器工程缺口 | signal 接线（库 bug 补修） | 2× 抖动退避重试（429/5xx/网络） | 4xx 不重试；3 次封顶 | adapter-wrapper.test.mjs（全矩阵） |
| 结构化 maxTokens≥2048 | structured 构造级开关 | — | — | adapter-wrapper.test.mjs（max_tokens 断言） |
| 真实调用冒烟（方法论） | 真 VLM 一问一答 | — | — | smoke.test.mjs（环境变量门控） |
| 引擎库（vendor）自身 | 108 用例随插件套件运行 | — | — | vendor/vision-bridge/tests/*.test.mjs（8 个 vitest 文件的 node:test 移植） |

## §10 设置界面 + promptExtra 映射（2026-09-07 增订；活体验收=VERIFY §8）

| 验收/故事 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| §10.5-1/VERIFY§8-1 卡片出现+字段齐全 | 槽位注册（settings.plugin.item + key=vision-bridge）/10 字段全集/嵌套路径声明（静态断言） | 加载态与只读态渲染分支（静态断言 t("loading")/t("readOnly")） | — | client-static.test.mjs（loader 协议/id/inject 清单/无 JSX/模块加载零副作用/字段全集/加载与只读分支） |
| §10.5-2/VERIFY§8-2 UI 改 provider 即时生效 | 设置写入走 settingsScope 原子 mutate；live 链路=§5.7 既有 watch | — | — | client-static.test.mjs（bind+mutate 断言）；settings-lifecycle.test.mjs（watch 重建/live gate）；活体=VERIFY §8-2 |
| §10.5-3/VERIFY§8-3 promptExtra 生效+缓存失效 | 指令拼装单测：非空 promptExtra 出现在 userRequest 尾部（zh/en 顺序锁定 question→language→extra） | 空串/纯空白归一为空，请求字节级零漂移 | — | prompt-extra.test.mjs（zh/en 顺序/三态字节一致） |
| §10.5-4/VERIFY§8-4 非法值拒收保旧 | resolveConfig 接受 ≤2000 字符 | 恰 2000 字符；trim 归一 | >2000 拒绝抛 TypeError；非法 UTF-16 孤项拒 | prompt-extra.test.mjs（恰 2000/2001/孤高/孤低/合法代理对） |
| 缓存指纹（§10.3） | promptExtra 变化 → configFingerprint 变化 | 缺省/空串/纯空白同指纹（含无字段 resolved 对象） | — | prompt-extra.test.mjs（fingerprint 三态一致/变化/无字段等价） |
| client 半侧声明 | package.json `dsh.client`（platform:web + 宿主包 inject；§10 时三包，§11 增至四含 `@deepseek-ai/dsh-api-remotes`）/`exports["./client"]`/files 覆盖 | 客户端与服务端 promptExtra 限额同步（2000）防漂移 | — | client-static.test.mjs（严格 JSON.parse 断言；MAX_PROMPT_EXTRA 跨侧同步断言；4 包 inject deepEqual） |

## §11 设置卡片 v2 映射（2026-09-07 增订；活体验收=VERIFY §9）

| 验收/故事 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| M0 前提核验（§11.2/§11.4） | M0-1 providers 投影：id+baseURL（部分 provider 可读，不可读→空串，风险#12 登记降级）+apiKeyEnv+models（vision 标识） | 空配置/抛错配置 → `[]`（卡片仅剩「自定义」）；坏行/坏模型过滤 | — | server-routes.test.mjs（projectProviders 4 例：投影/无 baseURL/坏行/空配置） |
| M0-2 凭证 API 核验 | credentialCandidateRefs：provider apiKeyEnv+当前 ref+VISION_API_KEY 去重保序 | 无 config → 仅 envs+默认 | — | server-routes.test.mjs（refs 2 例）。**注**：核实发现 remote.credentials 无 create/枚举 API，§11.3C「create+碰撞拒绝」按 M0-2 备案落地为 describe-then-set（client 侧）——create 调用参数/碰撞拒绝断言见 client-static.test.mjs（set(entry,key)/conflict 拒绝/仅条目名入 staged） |
| M0-3 webServer 路由同构 | 四 exact 路由注册，disposer 全数移除（fiber 重跑不漏重复注册） | — | 无 webServer/register 非函数 → 抛错 | server-routes.test.mjs（mounting 2 例） |
| §11.5-1 卡片标题+三组+核心 7 字段 | cardTitle 双语「dsh-VisionBridge 视觉代读」；三组（engineGroup/triggerGroup/advancedGroup）；高级默认折叠；7 核心字段（provider/model/baseURL/credential/mode/language/promptExtra） | 折叠开关翻转（advancedOpen） | — | client-static.test.mjs（§11 v2 card structure 6 例） |
| §11.5-2 Provider 下拉+联动 | selectProvider/syncProviderMode/linkedProviderFromBaseURL；选中自动带出 model（首个 vision）+baseURL+credential（apiKeyEnv） | vision 模型 👁 标识；无 baseURL provider → 留空+手填提示 | — | client-static.test.mjs（联动函数/自动带出/👁 3 例）+server-routes.test.mjs（providers 投影，见 M0-1 行） |
| §11.5-3 自定义模式 | CUSTOM `__custom` 哨兵；data-custom 紫边框视觉区分 | — | — | client-static.test.mjs（custom 哨兵+data-custom 断言） |
| §11.5-4 凭证三形态 | 下拉+`__paste`/`__manual` 哨兵；贴密钥保存=describe-then-set（密钥不落配置，仅条目名入 staged） | describe 已 configured → conflict 拒绝（不覆盖，提示改名） | 服务不可用/写入失败 → 失败提示不写 credential | client-static.test.mjs（三形态 4 例：哨兵/三控制器/describe-then-set+conflict/describe） |
| §11.5-5 验证连通 | POST /test → ok+latencyMs（确定性时钟 25ms）+model 回显；恰一次 round trip | pendingApiKey 瞬态：resolver 零调用、Authorization 单次携带、响应不回显密钥 | 非 POST → 405；401/403→auth；404→endpoint；Abort/timeout→timeout；凭证解析失败→auth(200)；坏 baseURL→400；classifyTestFailure 单测（auth/endpoint/timeout/unknown） | server-routes.test.mjs（/test 8 例+classify 4 例） |
| §11.5-6 补丁 marker 检测 | detect true（两文件带 marker→ok） | detect false（可读无 marker→missing） | 路径不存在→unknown | server-routes.test.mjs（detect 直测 3 例+env 路由 ok/missing/unknown 3 例） |
| §11.5-6 一键修复准入 | POST /fix-admission → applied+needsRestart；.bak 备份保留原文；盘上含 marker | 幂等：二次调用全 skipped→alreadyPatched | — | server-routes.test.mjs（fix-admission 3 例，mkdtemp node_modules） |
| §11.5-6 modlens 检测 | 未安装+404→✓（无冲突） | 装了+404→✓；探测抛错→unknown 无冲突；config 源失败→env 仍 200 | 装了+200→conflict ⚠ | server-routes.test.mjs（env modlens 4 例） |
| §11.5-6 一键关闭 modlens | POST /fix-modlens → 追加 override 行、原行保留、applied+needsRestart | 幂等：二次调用字节级不变→alreadyPatched；已有手写 override 行→跳过 | 非列表文档（列 0 映射键）→500 原文不动（风险#14）；不可读→500；路径未配置→500；非 POST→405 | server-routes.test.mjs（fix-modlens 7 例，mkdtemp 临时 cordis.patch.yml，绝不触碰真实 `<PROFILE_PATCH>`） |
| client 静态断言（§11.6 client 行） | 三组结构/provider 联动函数/凭证三形态控件/体检区（envGroup/refreshEnv/runFix/说明折叠/全✓折叠）/pendingApiKey 调用/卡标题 cardTitle | — | — | client-static.test.mjs（§11 三 describe 16 例+manifest 4 包断言） |

## §12 准入补丁启动自愈 + 运行时行为探针映射（2026-09-09 增订；活体验收=VERIFY §10）

| 验收/故事 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| §12.4-1 补丁已在→零噪音零写 | 已打补丁目录→selfHeal 返回 already，两文件 skipped，mtime 不变、零日志 | fiber 重入 apply()→同一 dir 复用缓存 promise（一次修复调用）；apply() 自身跑过一次后缓存命中 | — | self-heal.test.mjs（already/缓存/apply 缓存 3 例） |
| §12.4-2 补丁失→自动重打 | 干净文件→applyAdmissionPatch 落 marker+.bak，1 行 info 且含 `(effective on next boot)` | 两文件一有一无→只补缺的（skipped+patched） | — | self-heal.test.mjs（patched/部分 2 例） |
| §12.4-3 自愈失败不阻塞启动 | — | nodeModulesDir 不存在→failed（两文件 error），不抛 | stub applyAdmissionPatch reject→捕获、恰 1 行 error、status failed | self-heal.test.mjs（reject/缺失目录 2 例） |
| §12.2 A nodeModulesDir 双源 | 插件 `../..` 命中核心包→用它（安装副本=node_modules 本身） | 无核心包→DSH_HOME 推导；DSH_HOME 未设→主推导兜底 | — | self-heal.test.mjs（resolveNodeModulesDir 1 例） |
| §12.4-4 探针三态 | 入账→dead（并调用 cleanup seam）；拒绝码 MODEL_DOES_NOT_SUPPORT_IMAGES→live | 无 RPC 面/无 scratch 会话→unknown 且零提交；cleanup 抛错不改判 | agent-busy/其它异常/超时→unknown（不误报）；classifyAdmissionProbeError 直测 | self-heal.test.mjs（probe 6 例+classify 1 例） |
| §12.2 B 生产 RPC 面 | 未 opt-in→无 seam→unknown（默认关闭，见 VERIFY §10 注） | opt-in→稳定 scratch 会话 id、选文本模型、AbortSignal 随提交 | 服务缺失→ensureScratchSession 返回 undefined→unknown | self-heal.test.mjs（seam 3 例） |
| §12.2 B env 载荷 | disk=patched+runtime=dead→conflict false；§11 字段（status/files）不变 | disk=missing / disk=unknown（核心包缺失） | disk=patched+runtime=live→conflict true（§12.1 故事 1） | self-heal.test.mjs（env 4 例） |
| §12.4-6 既有 CLI/路由用例零回归 | POST /fix-admission 3 例复跑全绿（applyAdmissionPatch 导出面未改） | — | — | server-routes.test.mjs（§11.5-6 行，本次未改动） |
| §12.2 B client 三态渲染 | disk=patched+runtime=dead→✓；disk=missing→⚠+一键修复 | runtime=unknown→中性「已写入磁盘——运行时状态未验证」（不冒充 ✓） | disk=patched+runtime=live→⚠「已修复磁盘，重启后生效」 | client-static.test.mjs 既有静态断言（本次未改动）+ VERIFY §10 人工验收 |
| §12.2 B client | client-static 断言:admissionLive/admissionUnverified/savedFlash 渲染+admissionOk 严格判定 | i18n en/zh 四键 | — |

## §13 双代（0.1.6/0.1.7）兼容映射（2026-09-24 增订；对应设计 §7-1..13）

> 覆盖现状如实标注：客户端双代行为用例在 `client-adapter.test.mjs`；**服务端新分支**（`lib/settings-compat.js`、`lib/request-dimensions.js`）
> 的自动用例在 `tests/dual-gen.test.mjs`（30 例，2026-09-24 二轮；分派/守卫 · 自愈行序 · 装配与读法 · 校验拦截 · 跨命名空间读与投影 · 尺寸折算等价）。

| 验收条 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| §7-5① 客户端 inject 面 | inject 列表仅 `slots`+`locale`，不含 `settingsScope` | — | — | client-static.test.mjs（module-loader factory shape 的 inject 断言） |
| §7-5 卡片四顺位槽梯 | 顺位声明在⇒直接注册（row / bundle / item / legacy 4 例） | 声明晚到⇒走 `slots.inject` 等声明，单挂守卫只挂一张 | 无探测面⇒等 legacy；`kind` 不符⇒退下一顺位 + warn；候选皆无⇒不挂载 + 恰 1 条 warn | client-adapter.test.mjs（槽梯 6 例） |
| §7-5/6 三态卡片 | `ready`⇒实值填入 + 保存可用（0.1.7 走 `configForms` 服务） | 面晚到⇒唤醒轮询（500ms）后重发布为 `ready` | `loading`⇒骨架、无控件冒充值；`unavailable`⇒置顶只读提示 + 控件只读 + 保存禁用 | client-adapter.test.mjs（三态 5 例） |
| §7-6 写路径 | 0.1.7：`configForms.mutate(ops, revision)` 携带快照 revision + `savedFlash` | 两代并存⇒取 0.1.7 | `mutate` 返回 false⇒`saveRejected` 文案，失败不静默 | client-adapter.test.mjs（写路径 4 例） |
| §7-9 客户端老路径行为保持 | 0.1.6 面：`settingsScope.bind` 恰一次、`mutate` 单参、调用序列原样 | inject 瘦身后一次 `loading` 瞬态（设计 §8 认可） | — | client-adapter.test.mjs（0.1.6 2 例） |
| §7-12 降级可见（客户端） | 无设置面⇒中性提示，手填字段保留 | 仅 `remote.credentials`⇒凭证面仍可读 | 无凭证服务⇒中性注 + 无粘贴项，保留 `__manual` | client-adapter.test.mjs（凭证 3 例） |
| §7-1/2/3/4 服务端分派/装配/传播/校验对拍 | 两代 apply() 各自装配（老 = register 句柄、新 = volatile ref），运行期读数一致 | 面缺失/register 非函数/无 ref/表退化 ⇒ 降级可见且不抛 | 非法候选两代同拒，拒后旧配置继续服务 | dual-gen.test.mjs（§7-1/9 分派 8 例，含下两行的源码扫描各 1；§7-2/3 装配 8 例、§7-4 校验 5 例、跨代装配 2 例） |
| §7-5② 服务端 `ctx.settings.register(` 受守卫 | 出现点均为守卫三元臂，探针先于调用（`lib/index.js:344/355-357`） | 老代 ⇒ 仍经句柄注册（行为侧分派例） | 非函数 register ⇒ 走新面、不触老调用 | dual-gen.test.mjs（源码扫描断言 + `§7-1/9` 两代 apply() 例） |
| §7-8 自愈前移 | 自愈调用 `lib/index.js:335` < 首个 settings 面调用 `:344`/`:356`（源码扫描断言：调用点先于能力探测与 register） | 自愈 throw⇒仅 1 行 error、不阻塞启动 | — | dual-gen.test.mjs（§7-8 源码扫描 1 例）+ self-heal.test.mjs（throw 不阻塞 2 例） |
| §7-13 描述符投影 | `describe()` 行含 `llm-pi-ai` ⇒ 读取辅助返 `value` ⇒ `projectProviders` 得非空行 | 表内无该 ns ⇒ 空投影、零告警（卡片仅留自定义项） | `describe()` 抛错 ⇒ 读取视为不可用 + 恰 1 条 warn | dual-gen.test.mjs（`§2.1-18/§7-13` 5 例）；真机 provider 下拉非空属部署期活体验收（见 `docs/VERIFY.md` §11） |
| §7-10 计数护栏 | 插件根 `node --test` 375 例零失败（插件层 267 + vendor 108），基线 318 只增不减 | — | — | 本批实跑读数（VERIFY「附：自动化测试」） |
