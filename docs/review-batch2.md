# 批次评审报告：A+B（§4.7 让路 / seam 状态暴露 / N-I2·I4·I6 / 卡片四行）

> 评审人：design-reviewer（只读 + 单文件产出）。对象：v0.2.0 之后的未提交改动（工作区）。
> 本轮唯一写入产物：本文件。未改任何仓库文件、未跑安装/构建/重启、未写 node_modules/app.asar/profile/~/.dsh；临时实验目录已清理。
> 独立复跑：`node --test` → **422/422 pass**（116 suites，与声明一致；较 v0.2.0 净增 17）。
> 独立复现：本轮另写了两组临时脚本（不落仓库），覆盖 A1 冷启/同进程/关缝、A4 TTL+闩锁的**批量调用模式**、A6 两种回滚情形。结论见各条。

---

## 1. 结论

**通过（PASS）** —— **无 blocking**。

七项核销全部成立，其中三条"加宽/新增"的必要性由我自己复现证到（R1 的冷启不跳过、R2 的探针零提交、R5 的两种回滚）。另发现 **3 条非阻断 + 1 条外观级** 问题，都由实测或精确代码路径支撑，均**不改变关键判定**：

| # | 问题 | 级别 |
|---|---|---|
| N-B2-1 | `seam.mode=off` 的那一次 mount 仍读到上一 mount 的 `live=true` 而**跳过磁盘自愈**（下一次 mount 自纠；实测） | 🟡 |
| N-B2-2 | 汇总行 `allOk` 用 `seamLive` **替换**了 `admissionOk` ⇒ 靠磁盘补丁工作、缝被关闭/不可用的部署再也折叠不出「环境就绪」（**新的假 ✗**，方向保守，逐行判定仍准确） | 🟡 |
| N-B2-3 | N-I2 的告警闩锁只抑制"**同一 route+reason 的连续重复**"，`buildModelCatalog` 那种"N 个不同纯文本模型"的批量调用**每条 route 仍各打一行**（成本项已修好：实测 5 次调用 0 次额外凭证解析） | 🟡 |
| N-B2-4 | 标记残留行把"已装但未自证"也渲染为 ⚠「标记残留」，与第 1 行（中性「已安装——行为自证未通过」）语义重复 | 🔵 |

零回归面：`git diff --stat v0.2.0` 的改动面**恰好**是任务列出的 7 个文件 + 1 个新测试；`git diff -U0 v0.2.0 -- lib/` 的**删除行**只有 7 处且都是被替换项（`explainOpen` 初始化、旧 `allOk`、旧 `installSeam` import、⓪ 旧自愈块、seam 旧 warn、`raw[SEAM_MARK] = …`、旧探针调用），无未解释删除。

---

## 2. 逐条核销表（R1–R7）

### R1 — A1：进程级 live 与跳过自愈

**判定：已处置（设计意图达成）；发现一处"不该跳却跳了"的一次性窗口（N-B2-1）**

| 检查 | 结果 |
|---|---|
| 冷启动是否修复（不跳过） | **正确**。实测 mount#1（冷启动、同进程无历史）：`skip-log? false`、`live? true` ⇒ 先做（无害的）磁盘修复，自证在 ④ 才发生 |
| 同一进程的后续 mount 是否 stand down | **正确**。实测 mount#2：`skip-log? true`（`SEAM_LIVE_SKIP_SELF_HEAL_LOG`） |
| 目标实例变化 / 无 llm 时是否失效 | **正确**。`processSeamLive()`（`lib/index.js:454-458`）在 `target === undefined` 或 `target !== seamTarget(readSeamLlm())` 时返回 undefined ⇒ 照旧修复 |
| 自证的"无条件 publish 会抹掉 live"缺陷 | **现状正确，无同类残留**。三个发布点核对：①`installCurrentSeam()` 的 finally 只在 `status ∉ {installed, already}` 时发布（`:462-471`，即"off/unsupported 是真结论，fresh install 不是"）；②`verifySeamLive()` 的 finally **无条件**发布（`:550-558`，失败也发布 undefined ⇒ 下次 mount 会修复）；③settings.watch 路径经 ①。⇒ "proof 不被抹掉"与"失败不被缓存成 live"两条同时成立 |
| **实测发现的窗口（N-B2-1）** | `seam.mode: off` 的那一次 mount **仍然跳过**了自愈：`mount#3(mode=off): skip? true`（同时 `live-log? false`、缝确实关着 `no own prop`、闸门 `["text"]`）；下一次 mount 自纠：`mount#4(mode=off again): skip? false` |

**N-B2-1 的根因（代码路径，非猜测）**：`⓪`（`:636`）在 ④ 之前，读的是 `processSeamState`；而 `:617` 的 `ctx.effect` 体在**配置尚未解析**时就跑 `installCurrentSeam()`，此时 `seamOptions.mode` 还是初值 `'auto'`（`:349-357`）⇒ 装上了 ⇒ `status='installed'` ⇒ 按 `:470` **不发布** ⇒ 上一 mount 的 `live=true` 站着不倒 → ⓪ 跳过。**后果与量级**：该次 mount 少做一次磁盘修复（写完磁盘只影响下一次启动，所以真正被推迟的也只是"下一次启动干净"）；方向安全——mode=off 时 617 那次安装的 `reader` 尚为空（`:356`）⇒ `requireReader` 恒 false ⇒ 不注入；且下一次 mount 必自纠（④ 发布 undefined）。触发需同时满足：上一 mount live + 本次 `seam.mode=off` + 磁盘补丁确实缺失。

**建议**（择一，均非本批必须）：⓪ 的判据里加一条"本次传入的合成基座没有把 seam 关掉"（`config?.seam?.mode === 'off'` 时不 stand down），或把该窗口如实登记为已知一次性偏差。

### R2 — A2/A3：env 的 seam 字段与探针第三态

**判定：已处置**

- `lib/server-routes.js:584-601` `readSeamState()`：把 `getSeamState()` 归一化为 `{status, live(三态 true/false/null), reason, mode, include, requireReader}`；源缺失抛错 → `unknown` 且不炸路由（`:588-591`）。
- `lib/server-routes.js:620-633`：`seam.live === true` ⇒ `{ runtime: 'skipped', reason: ADMISSION_PROBE_SKIPPED_REASON }`，`probeAdmissionGate` 在 else 分支 ⇒ **真的不发合成 prompt**。
- **独立证据**：`tests/seam-runtime.test.mjs:296-314` 断言 `submissions === 0`（`promptRemote` 从未被调用）；`:316-328` 断言 `live=false / null` 时**仍**探针并给出 `dead`；`:330-360` 覆盖无 seam 源与抛错源。
- `conflict` 判据未变：`disk === 'patched' && runtime === 'live'`（`:646`），`skipped` 不会误判为 conflict（测试 `:309` 明确断言）。语义自洽：seam live 时探针只能读 `dead`，那是"关于缝而非关于闸"的结论 ⇒ 第三态 + 不提交，正确。

### R3 — A4：TTL 缓存与告警闩锁

**判定：已处置（成本项完全修好）；闩锁覆盖面窄于测试标题所述（N-B2-3）**

- **TTL（`lib/index.js:82`, `:403-416`）**：key = `baseURL\0model\0credential`，命中且 `< 5000ms` 复用结论。**实测**：`credential resolves during 5 blocked calls: 0`（上轮同一手法是 5）⇒ N-I2 的"每次调用一次凭证解析"已消除。
- **闩锁（`lib/seam.js:136-163`）**：key = `routeLabel + '|' + reason`，`blockedLogged` 单槽；`:162` 在**允许**的调用上清空（重新武装）。**实测**：同一 route 连打 4 次 ⇒ 只多 1 条（transition），再打就被抑制；但 **5 个不同 route ⇒ 5 条 warn**（`blocked warns for 5 DIFFERENT routes: 6`，含 mount 期 1 条）。
- ⇒ 测试标题 `a blocked reader warns once per episode, not once per model`（`:385-406`）实际只覆盖**同一 route 重复**；`buildModelCatalog` 的真实形态是"N 个不同模型各调一次"，那里仍是每个被挡 route 一行。**非阻断**：昂贵项（凭证解析）已归零，日志量受"投影里纯文本模型数"约束，且与改造前同阶。
- **过期/误判**：TTL ≤5s 内凭证被撤销仍会注入（之后 bridge 侧读取失败，auto 吞错、tool 可见）——与 R6 已声明的"配置可用≠运行可用"同源，量级有界，可接受。

### R4 — A5：inject 断言加宽是否等价

**判定：已处置（等价，且更严），未掩盖既有回归**

`tests/dual-gen.test.mjs:1017-1044` 逐条对照原意图：

| 原意图 | 加宽后的断言 | 是否保留 |
|---|---|---|
| 只有一个 inject，且是 webServer | `injects.length === 2`（**精确**，不是 `>=`） | 保留（数字变了，但精确性不变；第三个 scope 会让它失败） |
| webServer 是第一个 | `assert.deepEqual(injects[0].list, ['webServer'])` | **逐字保留** |
| webServer 只请求一次 | `injects.filter(list.includes('webServer')).length === 1` | **逐字保留** |
| 有回调 | `typeof callback === 'function'` | 保留 |
| （新增）后到的 llm scope 也被钉住 | `injects[1].list === ['llm']` + 回调是函数 | 新增，更强 |
| headless 内核仍挂工具 | `withoutInject.registered.tools.length === 1` | 保留 |

⇒ 加宽是**精确等价 + 新增一条精确断言**，没有把任何一条放松成"至少/包含"；也不会掩盖"多注册了一个 scope"这类回归。

### R5 — A6：标记写入的回滚（两种情形）

**判定：已处置（两种情形实测通过）**

`lib/seam.js:197-215`：一个 try 覆盖**两处写入**（`defineProperty` 与 `raw[SEAM_MARK] = …`）；catch 内先判 `raw.resolveModelInfo === wrapped`（只在"方法已被替换"时才需要回滚，`defineProperty` 自身失败时该判断为 false ⇒ 不动），再按 `ownDescriptor` 有无恢复原描述符或 `delete`，最后 warn + `{status:'unsupported'}`。

**实测**：
- 有自有可配置方法 + `preventExtensions`：`status: unsupported | method restored? true | marker? false | still answers: ["text"]`（上轮此处是"抛错且方法被替换"）。
- 无自有方法 + `preventExtensions`：`status: unsupported | own prop? false | marker? false`。
- 回归用例：`tests/seam-runtime.test.mjs:436`。

### R6 — B：卡片四行

**判定：已处置（未自证中性、✓ 仅 live）；发现 1 条新的假 ✗（N-B2-2）+ 1 条外观级（N-B2-4）**

- **不冒充 ✓**：`lib/client.js:1602` `if (seamLive)` → `dvb-ok` 是唯一给缝 ✓ 的分支；`:1611-1613` 已装未自证 → `dvb-unknown`（注释原文 "Deliberately NEUTRAL"）；`status==='off'` → 中性；`unsupported` → warn。`seamLive` 严格等于 `seam?.live === true`（`:1522`）⇒ `false`/`null` 都拿不到 ✓ ✓。
- **遗留行**：`:1667-1670` 仅在 `seamLive` 时把磁盘补丁行标为"不适用——已被运行时缝取代"（`dvb-ok`）；否则维持 §12 判据（`admissionOk` 仍在 `:1681` 生效）⇒ 旧的 ✓ 语义未被削弱 ✓。
- **折叠汇总（N-B2-2）**：`:1529` `const allOk = connectivityOk && seamLive && !seamResidue && reader.ok && modlensOk;` —— 它**替换**了 v0.2.0 的 `connectivityOk && admissionOk && modlensOk`（`git diff` 的删除行可证）。后果：一个"靠磁盘补丁正常工作、缝被显式关闭（`mode=off`）或不可用"的部署，**永远折叠不出「环境就绪」**（该部署此前在探针启用且 `disk=patched|runtime=dead` 时是可以折叠的）⇒ 新的**假 ✗**（保守方向：逐行判定都准确，只是汇总行不给）。若想同时保留两条通路：`(seamLive || admissionOk)`。
- **零回归**：`git diff -U0 v0.2.0 -- lib/client.js` 的删除行只有两处（`explainOpen` 初始化 → 扩成 5 行；旧 `allOk` → 新 `allOk`），其余全是新增（四行 + i18n 中英两套 + 新 Details 键）；`client-static` / `client-adapter` 的既有断言在 422 全绿里未变（这两文件只新增了 40/85 行）。保存/重置/拒收保旧/Provider 联动/凭证三形态/验证连通走的是未被改动的代码路径。

### R7 — 其它真实缺陷排查

**判定：未发现 other blocking**

按"静默失效 / 状态泄漏 / 假 ✓ / 破坏宿主服务 / 破坏其它插件"五类逐项排查：

- **静默失效**：A1 的 stand-down 只在 `live===true` 时发生，而 `live` 只由行为自证置位（`:584-590`）；失败/未知一律回到"下次 mount 修复"。未见新的静默通路。
- **状态泄漏**：`processSeamState`（`:93`）是**有意**的模块级进程状态（`:87-92` 注明"必须跨 fiber 重启存活"，与 `selfHealResults` 同款）；它持有 `target`=`llm` 实例引用——llm 是进程级单例，忽略。fiber 拆除仍由 `ctx.effect` + 返回 disposer 双重还原（`:617-620`, `:916-920`）。
- **假 ✓**：缝行需要 `live===true`；遗留行需要 `seamLive`；env 的 `conflict` 仍要求 `runtime==='live'`（`skipped` 不参与）。未发现新的假 ✓。
- **破坏宿主服务 / 其它插件**：本批未新增对宿主对象的写入面（A6 反而收紧了失败路径）；A5 的新 inject 是 `['llm']` 的**只读使用**，回调用 `if (status installed/already) return` 守卫（`:903`），重复触发是幂等的。
- `ctx.inject(['llm'])` 的**行为**未被 dual-gen 覆盖（那里的 stub 只记录不调用），由 `tests/seam-runtime.test.mjs:410-434` 覆盖（安装 on arrival）——建议保留这一分工，不必再改。

---

## 3. 缺陷清单

### blocking

**无。**

### non-blocking

1. **N-B2-1（🟡）`seam.mode=off` 的那次 mount 会沿用上一 mount 的 `live=true` 跳过磁盘自愈。**
   证据：实测 `mount#3(mode=off): skip? true`（同一次运行里缝确实关着、闸门 `["text"]`），`mount#4` 自纠 `skip? false`；根因见 R1（`:617` 的安装用的是未解析的默认 `mode:'auto'` + `:470` 的不发布规则 + ⓪ 在 ④ 之前）。
   建议：⓪ 的 stand-down 条件追加"传入基座未把 seam 关掉"，或如实登记为一次性偏差。

2. **N-B2-2（🟡）`lib/client.js:1529` 的 `allOk` 用 `seamLive` 替换了 `admissionOk`，靠磁盘补丁工作的部署从此折叠不出「环境就绪」。**
   证据：`git diff -U0 v0.2.0 -- lib/client.js` 显示旧行 `const allOk = connectivityOk && admissionOk && modlensOk;` 被删；`:1517` 仍计算 `admissionOk` 但只用于第 5 行（`:1681`）。
   建议：`(seamLive || admissionOk)`，或明确接受"缝是唯一被承认的主通路"并写进卡片说明。

3. **N-B2-3（🟡）告警闩锁不覆盖批量调用（`buildModelCatalog` 的 N 个不同 route）。**
   证据：实测 5 个不同 route ⇒ 5 条 warn（`blocked warns for 5 DIFFERENT routes: 6`，含 mount 期 1 条）；同 route 连打 4 次 ⇒ +1。
   建议：闩锁 key 去掉 route（只按 reason）并配一个"每次 flush 只报一条"的聚合，或接受现状（量级 = 纯文本模型数）。

4. **N-B2-4（🔵）`lib/client.js:1524,1622-1623`：`seamResidue = seamInstalled && !seamLive` 把"已装但未自证"也渲染成 ⚠「标记残留」**，与第 1 行的中性「已安装——行为自证未通过」重复；真正的"标记残留"（标记在、缝不是我们那层）在当前实现下几乎不可达（`installSeam` 的 `already` 必过行为自证）。建议把该行判据收窄为"标记在但行为自证失败且 status 不是 installed/already"，或把文案改为"已装未自证"。

---

## 4. 汇总

| 项 | 判定 |
|---|---|
| R1 A1 进程级 live / 跳过自愈 | 已处置（冷启正确、同进程 stand down 正确）；1 条一次性窗口（N-B2-1） |
| R2 A2/A3 env seam + 第三态 skipped | 已处置（探针真的零提交，conflict 判据未变） |
| R3 A4 TTL + 闩锁 | 已处置（TTL 成本归零）；闩锁覆盖面窄（N-B2-3） |
| R4 A5 inject 断言加宽 | 已处置（精确等价 + 更强，无掩盖） |
| R5 A6 回滚两情形 | 已处置（实测两种都恢复） |
| R6 B 卡片四行 | 已处置（未自证中性、✓ 仅 live）；1 条新的假 ✗（N-B2-2）+ 1 条外观级（N-B2-4） |
| R7 其它真实缺陷 | 未发现 blocking；无新增静默通路/状态泄漏/假 ✓ |
| 测试 | 422/422 独立复跑；改动面与任务清单一致（git diff 佐证） |

**blocking：0；non-blocking：3；外观级：1。** 四条都给出了可复现证据与最小修法，其中 N-B2-1/N-B2-2 建议随下一批（§4.6 收尾）一起处理，N-B2-3/N-B2-4 可择机。

VERDICT: PASS
