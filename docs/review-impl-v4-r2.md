# 第四轮核销报告：实现修复复核（B-I1 / N-I1 / N-I3）

> 评审人：design-reviewer（只读 + 单文件产出）。对象：仓库当前工作区（比 `docs/review-impl-v4.md` 那一轮多出 B-I1/N-I1/N-I3 的修复）。
> 本轮纪律：**只核销**，不重新全量评审。依据：`docs/review-impl-v4.md`（VERDICT: FAIL）。
> 本轮唯一写入产物：本文件。未改任何仓库文件、未跑安装/构建/重启、未写 node_modules/app.asar/profile/~/.dsh；临时实验目录已清理。
> 独立复跑：`node --test tests/seam.test.mjs` → **30/30**；`node --test` → **405/405**（较上轮 399 多 6 例，与"新增 6 条回归"一致）。

---

## 1. 结论

**通过（PASS）**。

三条修复**全部核销为「已处置」**，而且每一条都不是"看代码觉得对"——我用**自己写的临时脚本独立复现**了关键场景（含上轮那条我用来定 blocking 的"apply() 中途抛错"）：

- **B-I1**：①缝已挂到 fiber 生命周期（`ctx.effect`，并按 cordis 源码核对过契约）；②`:530` 起整段 try / `:806-813` catch → `uninstallSeam()` → `throw`；③**我的独立复现三点全中**：残留装饰已还原（`own prop=false`、`marker=false`、闸门回 `["text"]`），且随后 `installSeam()` 返回 **`installed`**（不再是 `already`）。
- **N-I1**：`pickSelfCheckRoute()` 在 include 非空时只从被包含路由挑；挑不到 → `live=undefined` + **独立 reason**（不是 `live=false`），且不再打 "NOT injecting" 假警报；包含命中时 `live=true`。
- **N-I3**：`defineProperty` 抛错 → `{status:'unsupported'}`，不抛、不装、不写标记（`preventExtensions` / `freeze` 两种都实测过）。
- **实现者自报的改造缺陷**（try{} 内 `const settingsReader` 块级作用域不可见 → 自证静默 unknown）：**已核实修好**，并做了机械化交叉引用审计确认**无第二处同类**。

**新增 blocking：无。** 新增非阻断观察 1 条（N-I6，见 §3）——一个仍在 try 之外的写入，我端到端验证过它**不会**产生 B-I1 那种静默通路，故不构成 blocking。

---

## 2. 逐条核销表

### B-I1（blocking）—— 缝必须受 fiber 生命周期保护

| 子项 | 判定 | 依据 / 独立证据 |
|---|---|---|
| ① 安装已挂 `ctx.effect` | **已处置** | `lib/index.js:536-539`：`ctx.effect(() => { installCurrentSeam(); return () => uninstallSeam(); }, 'vision-bridge: runtime seam')`。**契约已对源码核实**：`cordis/src/fiber.ts` 的 `Effect = Disposable \| Promise<Disposable> \| Iterable<Disposable> \| AsyncIterable<Disposable>`，且 `Disposable` 的注释原文是 "Function returned by an effect to release resources during disposal"、`runDisposable(dispose){ const result = dispose() }` ⇒ **effect 体立即执行，其返回的函数在拆除时被无参调用**。我的 disposer 模拟实测：apply 后 `own prop=true / gate=["text","image"]`，逐个执行 effect 的 disposer 后 `own prop=false / gate=["text"]`。 |
| ② `:530` 起整段 try → `uninstallSeam()` → rethrow | **已处置** | `lib/index.js:530` `try {` … `:806-813` `} catch (error) { uninstallSeam(); throw error; }`（注释原文点名 B-I1(2) 与 B2）。`return async () => {...}`（`:795-805`）在该 try 内，因此"没走到 return 就抛"的所有路径都被覆盖。 |
| ③ **独立复现：apply() 中途抛错** | **已处置（三点全中）** | 我的临时脚本用一个 `tools.register` 抛错的 ctx harness 复现（与上轮定 blocking 时用的是同一手法）：`apply rejected: true \| tools service rejected the registration`；`disposer returned? undefined`；**`own resolveModelInfo left? false \| marker left? false`**；**`gate answer now: ["text"]`**（门禁回基线）；**`subsequent installSeam() => installed`**（不再 `already`）。`ctx.effect registered: vision-bridge: runtime seam`。 |

**结论**：上轮 blocking 的**两个后果**（"闸门开着但插件没加载" + "后续加载被失败代 wrapper 占位成 already"）都已被切断并有回归用例守着（`tests/seam.test.mjs:543` `a throw after the install restores the seam and leaves it re-installable`；`:570` `the ctx.effect cleanup restores the seam when the fiber is torn down`）。

### N-I1 —— 自证路由必须尊重 `seam.include`

| 要求 | 判定 | 依据 / 独立证据 |
|---|---|---|
| include 非空时只从被包含路由挑 | **已处置** | `lib/index.js:458-474` `pickSelfCheckRoute()`：`include` 为空 → 退回 `pickTextOnlyModel`；非空 → 遍历投影并额外要求 `seamRouteIncluded(include, provider.id, model.id)`。`verifySeamLive` 在 `:485` 改用它。 |
| 挑不到 → `live=undefined` + 独立 reason（不是 `live=false`） | **已处置** | `lib/index.js:490-499`：`seam.live = undefined`；reason 二选一区分 `'no included text-only route (seam.include excludes every declared text-only model in the projection)'` 与 `'self-check route unavailable (…)'`。 |
| 不再出现假 ✗ | **已处置（实测）** | 投影只有 `qax:glm-5.3`（纯文本）时：<br>A `include=[]` → `live=true`、无 "NOT injecting"；`qax` 路由注入出 `["text","image"]`。<br>B `include=['zai-coding-cn:glm-5.3']`（排除投影里唯一纯文本模型）→ **"NOT injecting" warn 已消失**；warn 变为 `runtime seam installed but not self-verified — no included text-only route (seam.include excludes every declared text-only model in the projection)`；**而被包含的路由确实注入** `["text","image"]`。<br>C `include=['qax:glm-5.3']`（命中投影）→ `live=true`。 |

（上轮我实测到的 "假 ✗" 是 `live=false` + "NOT injecting"；本轮同场景已变为"未自证 + 说清原因"，与 N-I1 要求一致。）

### N-I3 —— `defineProperty` 失败必须降级而不是抛

| 要求 | 判定 | 依据 / 独立证据 |
|---|---|---|
| 抛错降级为 `{status:'unsupported'}` | **已处置** | `lib/seam.js:184-195`：`try { Object.defineProperty(...) } catch (error) { logger?.warn?.(…'the llm instance is not extensible, so the decoration was refused'…); return { status: 'unsupported' }; }`；标记写在成功路径上（`:196`）。 |
| `preventExtensions` / `freeze` | **已处置（实测）** | `preventExtensions (new prop) -> status unsupported \| method replaced? false \| marker? false`；`freeze -> status unsupported \| method replaced? false \| marker? false`（上轮同一脚本这两种都是 THREW）。 |
| 回归用例 | **已处置** | `tests/seam.test.mjs:653` `preventExtensions and freeze: no throw, no install, no marker`、`:672` `the instance keeps answering normally after the refusal`。 |

**残留（新，非阻断）**：见 §3 N-I6 —— 我把"非扩展 + 实例已有自在可配置 `resolveModelInfo`"这一组合也跑了，`:196` 仍会抛且留下已替换的方法；端到端验证表明**不产生** B-I1 的静默通路。

### 实现者自报的改造缺陷（`settingsReader` 块作用域）

| 要求 | 判定 | 依据 / 独立证据 |
|---|---|---|
| 声明提升到 try 之前 | **已处置** | `lib/index.js:528` `let settingsReader;`（在 `:530` 的 try 之前），`lib/index.js:559` 在 ① 内赋值；使用点 `:485` 在 `verifySeamLive`（定义于 try 之前）。`const settingsReader` 已无第二处（全文 0 处）。 |
| 修复真的到位（不是又一处静默 unknown） | **已处置（实测反证）** | 我的实验 A/C：`live=true` 且 `vision-bridge: runtime seam live — self-check passed (qax:glm-5.3)`。若 `settingsReader` 仍被遮蔽，`verifySeamLive` 会命中它自己的 catch ⇒ 出现 `could not read the provider projection` 且 `live=undefined`——**实测两者都不出现**。 |
| 有无第二处同类 | **已处置（机械化审计，独立于其自述）** | 我从源码里抽出 try 块（`:530-805`）**顶层声明**的全部 10 个名字：`legacy, providerDefaults, validate, settings, state, lifecycle, disposers, buildCaches, buildBridge, runtime`；再逐个在 `:1-529` 里搜"裸标识符引用"（排除 `.name`、注释、字符串）。结果：**无一处真正的越界引用**——命中的全部是注释（`validate`/`state`/`lifecycle`/`runtime`）、`inject` 列表里的字符串 `'settings'`、import 路径 `'./settings-compat.js'`，以及 `:231` 另一个函数内的同名局部变量 `for (const runtime of registry.values())`。⇒ 与实现者自述的审计结论一致。 |

### 附：测试与既存项的现状（未重评）

- `tests/seam.test.mjs`：**30/30**；全仓 `node --test`：**405/405**（独立复跑）。
- 新增 6 例与本轮三处修复一一对应：`543`(B-I1②/③)、`570`(B-I1①)、`607`+`635`(N-I1)、`653`+`672`(N-I3)。
- 上轮的非阻断项状态未变、本批声明不做的：N-I2（每次调用一次 `credentials.resolve` + 每次 warn）未变；**N-I4（`llm` 后到不重试）已在代码里显式登记为延后**（`lib/index.js:593-596`：需要一个额外的 `ctx.inject` 作用域，且既有 dual-gen 断言把 inject 列表钉在 `['webServer']`，归 §4.6 批）；N-I5（§4.7 未接）仍在。这些都不是本轮的核销对象，也不构成本轮 blocking。

---

## 3. 新增 blocking

**无。**

### 新增非阻断观察

#### N-I6（🟡）`lib/seam.js:196` 的标记写入仍在 try 之外 —— 一种组合下 `installSeam` 会"抛错且有副作用"

`lib/seam.js:184-195` 守住了 `Object.defineProperty`，但紧随其后的 `raw[SEAM_MARK] = { wrapped, restore, original };`（`:196`）**不在 try 内**，而 ES module 是严格模式 ⇒ 在不可扩展的实例上会抛。

**实测（本轮，临时脚本）**：构造一个"`Object.preventExtensions` **且已带自在可配置** `resolveModelInfo``的实例——
`defineProperty` 对这种实例是**允许**的（改的是既有可配置属性），于是流程走到 `:196`：

```text
preventExtensions + own configurable method -> THREW: TypeError: Cannot add property Symbol(@dsh-external/dsh-vision-bridge/seam), object is not extensible
                                              | METHOD LEFT REPLACED? true | marker? false
```

**为什么它不构成 blocking（我把它端到端跑完了）**：走完整 `apply()` 时，首次安装发生在 `:536`，而 `seamOptions.reader` 要到 `:590` 才填充 ⇒ **失败那一代的 wrapper 的 `requireReader` 恒为 false（不注入）**。实测：

```text
apply rejected: true | TypeError: Cannot add property Symbol(@dsh-ext…), object is not extensible
disposer returned? undefined
host method LEFT REPLACED? true | marker present? false
gate answer now: ["text"]          ← 门禁仍关着，没有 B-I1 的静默通路
```

且随后一次成功加载会在其上再装一层、正常注入（`subsequent installSeam() => installed`，见 §2 B-I1③ 同款机制）。所以真实代价是：**插件加载失败 + 宿主方法上留下一个不可单独移除的空转包装层（每次失败加载多一层）**，不是"闸门开着没人读图"，也不是永久功能失效。触发前提（实例非扩展 **且** 自带自有可配置方法）今天两条都不成立（真实 `LlmRuntime`：`extensible:true`、方法在原型上、无自有同名属性）。

**建议（3 行级，随 §4.6 批一起即可）**：把 `:196` 移进同一个 try；若标记写不进，先 `delete raw.resolveModelInfo` 回滚再返回 `unsupported`；测试补一例"非扩展 + 自带自有可配置方法"（现有 `:653` 只覆盖了两种前提均成立的情形，故此组合无回归保护）。

---

## 4. 核销总表

| 项 | 判定 |
|---|---|
| B-I1① `ctx.effect` 挂载 | 已处置（cordis 源码核对 + disposer 模拟实测） |
| B-I1② `try` 整段 + `catch{uninstallSeam;throw}` | 已处置 |
| B-I1③ 独立复现 apply() 抛错 | 已处置（残留已还原、门禁回基线、再装返回 installed） |
| N-I1 自证路由尊重 include + 独立 reason | 已处置（A/B/C 三组实测） |
| N-I3 `defineProperty` 降级 unsupported | 已处置（preventExtensions / freeze 实测） |
| 自报的 `settingsReader` 块作用域缺陷 | 已处置（修复到位 + 无第二处：机械化审计） |
| 测试 | seam 30/30、全量 405/405 独立复跑 |
| 新增 blocking | **0** |
| 新增非阻断 | 1（N-I6） |

**未核销 blocking：0；新增 blocking：0。** 三条修复的实测证据与设计（§4.2/§4.4/§4.5）及我上轮的要求一致；N-I6 属可随下一批处理的收尾项。

VERDICT: PASS
