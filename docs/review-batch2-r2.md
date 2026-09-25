# 复评报告（修复轮）：F1 / F2 / F3 核销

> 评审人：design-reviewer（只读 + 单文件产出）。对象：仓库当前工作区（`docs/review-batch2.md` 之后的修复轮）。
> 本轮唯一写入产物：本文件。未改任何仓库文件、未跑安装/构建/重启、未写 node_modules/app.asar/profile/~/.dsh；临时实验目录已清理。
> 独立复跑：`node --test` → **428/428 pass**（116 suites；较上轮 422 净增 6，与声明一致）。
> 独立复现：本轮另建了三组临时脚本（不落仓库）——F2 的挂载序列、F1 守卫的**变异验证**、F3 的变异验证。均给出实测输出。

---

## 1. 结论

**通过（PASS）** —— **无 blocking**。

三条修复**全部核销为「已处置」**，且都由我独立复现/变异验证过：

- **F1**：`allOk` 已改成两条通路任一成立，且 `!seamUnproven` 是**真正独立的守卫**——我用变异实验证明：**只要删掉这条守卫，一个"已装未自证 + 磁盘补丁可用 + 代读已配置 + 连通 ok"的部署就会折叠成「环境就绪」**（我的探针用例因此失败）；装上守卫则不折叠。`off`/`unsupported` + 磁盘补丁可用 ⇒ 可折叠（源码逻辑 + 其行为测试 + 我的读码三证）。
- **F2**：⓪ 已加「本次基座未把 seam 关掉」前置；我的挂载序列实测 **`mount#3 base mode=off → skip=false`**（上轮同一手法是 `true`），且 stand-down 在 auto 挂载上照旧生效（`#2/#5 → skip=true`）。
- **F3**：选了 (a)：服务端新增只读 `residue` 位（`seamMarker(llm) !== undefined && !seamInstalled(llm)`），卡片**只**读这个位；"已装未自证"不再渲染为 ⚠ 残留；真残留仍告警——我把卡片改回旧写法（`seamInstalled && !seamLive`）后，其行为测试**失败了**，说明该测试对 F3 是**敏感**的。
- **N-B2-3**：确认只登记未改行为（JSDoc `KNOWN DEVIATION … NOT fixed`，闩锁代码逐字未变）。

**新增非阻断 1 条（N-B3-1）**：F1 守卫的**回归测试是空转的**——删掉守卫它照样通过（产品代码本身是对的）。详见 §3。

---

## 2. 逐条核销

### F1（原 N-B2-2）—— `allOk` 两条通路 + 未自证独立守卫

| 检查 | 判定 | 依据 / 证据 |
|---|---|---|
| 改为「两条通路任一成立」 | **已处置** | `lib/client.js:1541-1542`：`const allOk = connectivityOk && (seamLive || admissionOk) && !seamUnproven && !seamResidue && reader.ok && modlensOk;`（`admissionOk` 仍在 `:1517` 计算、`:1694` 供第 5 行使用，未被删） |
| 守卫是否**独立**于磁盘通路 | **已处置（变异证明）** | `lib/client.js:1532` `const seamUnproven = seamInstalled && !seamLive;`（`seamInstalled = status ∈ {installed, already}`，`:1523`）⇒ 只依赖 seam 的 status/live，与 `admissionOk` 无耦合。**变异实验**见下 |
| `off` / `unsupported` + 磁盘补丁可用 ⇒ 可折叠 | **已处置** | `off`/`unsupported` 时 `seamInstalled=false` ⇒ `seamUnproven=false` ⇒ 守卫不拦；`(seamLive \|\| admissionOk)` 由 `admissionOk` 成立。行为测试 `tests/client-adapter.test.mjs:671-679`（off）与 `:681-692`（unsupported）断言 `envReady` 出现且已通过 |
| 未自证不得被磁盘通路救活 | **已处置** | 见下方变异实验：删掉守卫 ⇒ 折叠（探针失败）；装上 ⇒ 不折叠（探针通过） |

**我的变异实验（独立、可复现）**：复制 `lib/client.js` 与 `tests/client-adapter.test.mjs` 到临时目录（不触仓库），在**同一 describe 作用域**里插入一个探针用例：payload = `installed/live:null/residue:false` + `admission={disk:'patched',runtime:'dead'}` + `remote.credentials` 已接（照抄同文件 `:684-690` 的写法）+ `settleTest`，断言 `envReady` **不出现**。实测：

```text
[guard PRESENT] ℹ tests 1 | pass 1 | fail 0
[guard REMOVED] ℹ tests 1 | pass 0 | fail 1   AssertionError: PROBE: an unproven seam must never hide behind the ready line
```

⇒ 守卫**真的独立、真的必要**；F1 的产品代码正确。

### F2（原 N-B2-1）—— ⓪ 的基座前置

**判定：已处置（独立复现通过）**

代码：`lib/index.js:645-658`
```js
const baseSeamOff = config?.seam?.mode === 'off';
if (!baseSeamOff && processSeamLive() === true) { logger.info(SEAM_LIVE_SKIP_SELF_HEAL_LOG); }
else { try { await selfHealAdmissionGate({ logger }); } catch (error) { logger.error(...); } }
```

我的挂载序列（同一进程、同一 llm 实例、真实 `apply()`，NM 目录里两张补丁文件带标记以免噪声日志）：

```text
mount#1 auto (cold)              -> skip=false live=true     ← 冷启照旧修复（§4.7-1 语义不变）
mount#2 auto (2nd)               -> skip=true  live=true     ← stand-down 仍生效（无回归）
mount#3 base seam.mode=off       -> skip=false live=false    ← ★ 上轮这里是 true，窗口已关闭
mount#4 auto (after off)         -> skip=false live=true     ← off 那次已清掉进程结论，故再修一次（保守且正确）
mount#5 auto (2nd after off)     -> skip=true  live=true     ← stand-down 重新建立
mount#6 base seam.mode=off again -> skip=false live=false    ← 可重复
```

### F3（原 N-B2-4）—— 只读 `residue` 位

| 检查 | 判定 | 依据 / 证据 |
|---|---|---|
| env 补只读 residue 位 | **已处置** | 服务端：`lib/index.js:452-459` `seamResidueNow() = seamMarker(llm) !== undefined && !seamInstalled(llm)`（标记在、但当前方法不是我们那一层）；`:895-904` 经 `getSeamState().residue` 暴露；`lib/server-routes.js:600-602` 归一化为布尔 `residue: state.residue === true`（缺源/抛错时为 false，不猜） |
| 卡片只用服务端位，不再推测 | **已处置** | `lib/client.js:1528` `const seamResidue = seam?.residue === true;`（注释明写 "never inferred by the card"） |
| 「已装未自证」不再渲染为 ⚠ 残留、不再与第 1 行矛盾 | **已处置** | `lib/client.js:1634-1643` `markerRow()`：只有 `seamResidue` 才 `dvb-warn`；`seamInstalled`（含未自证）走 `:1640` `dvb-ok` + `markerOk`"标记与行为一致，无残留"（`:321`）；而"未自证"由第 1 行中性表达（`:1626`）。两者陈述不同事实，不矛盾 |
| 真残留仍会告警 | **已处置（变异证明）** | 行为测试 `tests/client-adapter.test.mjs:632-638`（`residue:true` ⇒ `markerResidue`）通过；把卡片改回旧写法 `const seamResidue = seamInstalled && !seamLive;` 后**该用例失败**：`✖ a real residue (server flag) is the only thing that warns on row 2` ⇒ 测试对 F3 敏感、修复受保护 |

（🔵 顺带一提：`markerResidue` 的文案被改成了"标记在、行为自证未通过"（`:201/:322`），而该行现在只在**真残留**（标记在、但层不是我们的）时出现——新文案读起来更像它已经不再覆盖的"未自证"态。建议换成残留专属措辞，避免两种状态读起来一样。纯文案，不影响判定。）

### N-B2-3 —— 只登记未改行为

**判定：已处置（登记确认，行为未变）**

`lib/seam.js:136-146` 的 JSDoc 原文：`KNOWN DEVIATION, registered on purpose (review N-B2-3, NOT fixed)`，并说明"昂贵的一半（每次调用一次凭证解析）已消除，剩下的是按 route 一行、量级 = 投影里纯文本模型数；聚合需要 flush 窗口，刻意不做"。闩锁代码（key = `routeLabel + '|' + reason`，`:162-167`）与上轮逐字一致 ⇒ 行为零改动 ✓。

### 零回归 / 改动面

- **测试**：`node --test` → **428/428**（116 suites）独立复跑 ✓。CHANGELOG 记的"0.2.0 基线 405 → 428"与我这几轮的实测序列一致（405 → [批2 +17] 422 → [本轮 +6] 428）✓。
- **改动面**：`git status` 的代码面**恰好**是任务列出的 `lib/index.js`、`lib/seam.js`、`lib/server-routes.js`、`lib/client.js` + `tests/{seam-runtime,client-adapter,client-static,dual-gen}`；额外被改的 6 个是记账件（`CHANGELOG.md`、`README.md`、`docs/HANDOFF-2026-09-26.md`、`docs/VERIFY.md`、`tests/TEST-MATRIX.md`、`package.json` 版本 `0.2.0 → 0.3.0`），属本仓 house pattern（design.md §12.3 的文件清单惯例），**无越界的代码改动**。

---

## 3. 新增 blocking

**无。**

### 新增非阻断

#### N-B3-1（🟡）F1 守卫的回归测试是**空转**的：删掉守卫它照样通过

**现象（实测）**：把 `lib/client.js` 里的 `&& !seamUnproven` 删掉（即重新引入 N-B2-2 的假 ✓ 通道），**shipped 的那条测试仍然通过**：

```text
[baseline/F1guard]                       ℹ tests 1 | pass 1 | fail 0
[mutA(drop unproven guard)/F1guard]      ℹ tests 1 | pass 1 | fail 0      ← 变异未被发现
```

**根因**：`tests/client-adapter.test.mjs:694-702` 的用例标题是 "…even when the disk patch works"，也确实把 `payload.admission` 覆写成 `disk:'patched', runtime:'dead'`（`:696`）并调了 `settleTest`（`:698`）——但它**没有接 `remote.credentials`**（对比同文件 `:681-690` 的孪生用例是接了的）。因此 `state.credentialCheck` 停在 `unknown` ⇒ `readerVerdict().ok === false`（`lib/client.js:1648-1660`）⇒ `allOk` 在任何变异下都是 false ⇒ 断言 `envReady === false` **恒真**。

**我另做的对照（同一 payload + 补上 credentials 接线 + 等 `credentialCheck.status==='ok'`）**：
```text
[guard PRESENT] ℹ tests 1 | pass 1 | fail 0
[guard REMOVED] ℹ tests 1 | pass 0 | fail 1   AssertionError: PROBE: an unproven seam must never hide behind the ready line
```
⇒ 差别只在 `reader.ok` 这一项；也就是说**产品代码是对的，保护它的测试是空转的**。

**影响**：未来任何一次编辑只要删掉 `!seamUnproven`，N-B2-2 的"未自证被磁盘通路救活 ⇒ 假 ✓"会**静默复活**而套件全绿。
**修法（2 行级，照抄孪生用例）**：给该用例加 `const credentials = { describe: async () => ({ ok: true, value: { VISION_API_KEY: { configured: true } } }) };`、`mountWithEnv(payload, undefined, { 'remote.credentials': credentials })`，并在 `settleTest` 前等 `card.state().credentialCheck?.status === 'ok'`（同 `:684-690`）。

---

## 4. 对 lead 裁决项的意见（`unsupported` + 磁盘补丁可用 ⇒ 第 1 行 ✗ 被汇总隐藏）

**我同意 lead 的裁决，不升级为 blocking，也不认为它比「假 ✗」更糟。** 理由（按重要性）：

1. **汇总行说的是真话**。`envReady` 的完整文案是"✓ 环境就绪，无需操作。"（`lib/client.js:297`）。在该部署里环境**确实**就绪：图片能进、能被代读（走磁盘补丁这条已工作的通路）。被折叠掉的是"某个**对本部署不承重**的机制不可用"的提示，而不是一个失败状态 ⇒ 不是"假 ✓"。
2. **这个提示会自己回来**。一旦磁盘补丁真的失效（DSH 更新冲掉），`admissionOk` 变 false ⇒ `allOk` false ⇒ 面板自动展开，第 1 行的 ⚠ 恰好在它第一次有意义的时候出现。
3. **反向做法的代价更大**：若改成"只要 `status==='unsupported'` 就不许折叠"，等于给一个**正常工作**的部署永久挂一条 ⚠ 且永不折叠——那正是我这轮核销掉的"假 ✗"（N-B2-2）的同型问题，只是换了个状态。
4. 触发条件（内核改名 / 服务实例不可扩展）今天不存在，且已由 `R1`/`N-I3` 的记录与日志覆盖。

建议（与 lead 计划一致）：写进文档作为**已接受的外观偏差**，并在文案层面可选加一句——折叠行后追加"（运行时缝不可用，当前由磁盘补丁工作）"，但这属于可选增强，不是缺陷修复。

---

## 5. 核销总表

| 项 | 判定 | 独立证据 |
|---|---|---|
| F1 两条通路 + 未自证独立守卫 | **已处置** | 源码 + **变异实验**（删守卫 ⇒ 折叠，探针失败）+ 孪生用例断言 off/unsupported 可折叠 |
| F2 ⓪ 基座 mode 前置 | **已处置** | 6 段挂载序列实测：`mode=off ⇒ skip=false`，auto stand-down 无回归 |
| F3 只读 residue 位 | **已处置** | `seamResidueNow()` 定义 + env 归一化 + 卡片只读服务端位；**变异实验**证明其行为测试敏感（改回旧写法 ⇒ 失败） |
| N-B2-3 只登记 | **已处置** | JSDoc `NOT fixed`；闩锁代码逐字未变 |
| 零回归 / 改动面 | **已处置** | 428/428 独立复跑；代码面与任务清单一致，其余为记账件；版本 0.2.0→0.3.0 与 CHANGELOG 计数自洽 |
| lead 裁决项（unsupported 折叠） | **同意，不升级** | 理由见 §4 |
| 新增 blocking | **0** | — |
| 新增非阻断 | **1**（N-B3-1：F1 守卫的回归测试空转） | 变异实测 |

VERDICT: PASS
