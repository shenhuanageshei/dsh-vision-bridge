# 实现评审报告：design-v4.1 运行时缝（lib/seam.js + 接线）

> 评审人：design-reviewer（只读 + 单文件产出）。对象：仓库当前工作区**未提交**的实现。
> 依据设计：`docs/design-v4-runtime-seam.md` v4.1（含 §4.2/§4.4/§4.5/§4.7）；前两轮报告 `docs/review-design-v4.md`、`docs/review-design-v4-r2.md`。
> 本轮唯一写入产物：本文件。未改任何仓库文件、未跑安装/构建/重启、未写 node_modules/app.asar/profile/~/.dsh。
> 实测：`node --test tests/seam.test.mjs` → **24/24 pass**；`node --test` → **399/399 pass**（本轮独立复跑，与实现者声明一致）。另有本报告 §3 的四组临时目录实验（不落仓库）。

---

## 1. 结论

**不通过（FAIL）** —— 有 **1 条 blocking**（B-I1：缝不受 fiber 生命周期保护，`apply()` 中途抛错会留下「已注入但插件未加载」的静默通路，正是本设计明令禁止的那条），其余实现质量高、与设计的符合度很好。

**正面确认（先说清楚，避免误读）**：§4.2 的硬约束**逐条符合**，且不是纸面符合——装饰落在真实实例上、`defineProperty` 保住了原型方法的 `enumerable:false`、`delete` 还原并清标记、`already` 走行为自证、返回新对象不改写适配器答案、`inputModalities===undefined` 逐字段不动、谓词抛错时回退适配器答案（fail-closed）。§4.4 的 live 重装与 dispose 还原都真的接上了（E5/E6 用例 + 本轮 E5b 复跑）。**D1 的越界改动理由成立且必要**；**D2 可接受**；**D3 可接受为下一批**（附两条条件）。

---

## 2. 与设计的符合度核销

### §4.2 装饰实现（对接 design §4.2 / review B1·B2·N11）

| 设计要求 | 判定 | 证据 |
|---|---|---|
| 一切读写落到**真实实例**（`Symbol.for('cordis.original')`） | **符合** | `lib/seam.js:53-56` `seamTarget()`；`lib/seam.js:115,130,172-187`；`tests/seam.test.mjs:93-96`（`seamTarget(llm) === raw`；且断言"代理读是新的 shadow method"——B1 根因被写成回归） |
| `defineProperty(…, enumerable:false)`（N11a） | **符合** | `lib/seam.js:181-186`；`tests/seam.test.mjs:107-115` 断言自有属性描述符与原型**逐项相同**。原型描述符本身本轮再由真实 `LlmRuntime` 复核：`{writable:true, enumerable:false, configurable:true}`（R1 报告 F5） |
| `delete` 还原 + **清 `SEAM_MARK`**（B1/B2） | **符合** | `lib/seam.js:169-177`（`ownDescriptor` 优先还原，否则 `delete`；再 `delete raw[SEAM_MARK]`）；`tests/seam.test.mjs:170-181, 427-436` |
| `already` = **行为自证**（不允许只看标记） | **符合** | `lib/seam.js:70-75, 124-128`（`marker.wrapped === raw.resolveModelInfo`）；`tests/seam.test.mjs:156-164` 专测"仅有标记、不是我那一层"必须按未装处理 |
| 返回新对象、不改写适配器答案 | **符合** | `lib/seam.js:153`；`tests/seam.test.mjs:100-101` |
| `inputModalities === undefined` 逐字段原样（E8） | **符合** | `lib/seam.js:140`；`tests/seam.test.mjs:125-131` |
| 未声明/非数组模态不注入（fail-closed） | **符合** | `lib/seam.js:141`（`!Array.isArray(...)` 直接返回原 info） |
| 谓词自身出错不得破坏宿主查询 | **符合** | `lib/seam.js:158-166` try/catch → error 日志 + 原 info；`tests/seam.test.mjs:284-297` |
| 幂等（重复安装不叠层） | **符合** | `lib/seam.js:124-128`；`tests/seam.test.mjs:167-175` |
| 不破坏别人的装饰（R5） | **符合** | `lib/seam.js:172` 只在"我仍是最外层"时动作；`tests/seam.test.mjs:194-208` |

### §4.4 生命周期与 live 更新（B3）

| 设计要求 | 判定 | 证据 |
|---|---|---|
| `apply()` **最先**安装 | **符合** | `lib/index.js:499` 在 ⓪ 磁盘自愈（`:509`）与设置面（`:529`）之前 |
| 读取走 `ctx.get('llm')`，**不扩严格 `inject`**（N5） | **符合** | `lib/index.js:363-371`；`inject` 仍为 `['tools','settings','attachments','agents','systemPrompt','credentials']`（`:49`，无 `llm`） |
| `seam.mode/include/requireReader` **live** 生效（改即卸载→重算→重装） | **符合** | `lib/index.js:716-721`；`lib/index.js:403-416`（uninstall → install，无 await 窗口）；`tests/seam.test.mjs:443-471`（E6 三态：off→auto→include 收窄） |
| fiber dispose 还原 | **符合** | `lib/index.js:751-755`（disposer 第一件事就是 `uninstallSeam()`）；`tests/seam.test.mjs:427-430` |
| 启动失败的兜底（**未在设计中写、但属于"fiber 生命周期"硬约束**） | **偏离** | 见 B-I1 |

### §4.5 探测、降级与前置条件（B5）

| 设计要求 | 判定 | 证据 |
|---|---|---|
| 三态 + 安装后**立刻自证** | **符合** | `lib/index.js:461-497`（挑一个声明纯文本的路由 → 真解析 → 断言含 image；无候选/超时/异常一律 `live=undefined`，不冒充 ✓，`SEAM_SELF_CHECK_TIMEOUT_MS=5000` 有界） |
| `requireReader` 前置条件（B5） | **符合（且比文档更优）** | 文档 §4.5 写"安装前置条件"，实现按其自己的 `§8-3a` 与 review N11b 落成**调用时谓词**：`lib/index.js:415` + `lib/seam.js:97-102,142-152` → live 改配置无需重装即生效 |
| 代读不可用时**保持硬拒绝**、不得制造"发送成功但无人读图" | **符合** | `lib/seam.js:146-152`（不注入 → 闸门继续拒）；`lib/index.js:376-390` 判据=baseURL+model+credential 可解析；边界（配置可用≠运行可用）如实写在注释与 R6 |
| 失败要响 | **部分符合** | 见 D2（absent-service 降为 warn）与 D3（卡片未接，§4.6 下一批） |

---

## 3. 发现的缺陷

### 3.1 blocking

#### B-I1（🔴）缝的安装不受 fiber 生命周期保护：`apply()` 中途抛错 ⇒ **"闸门放行但插件未加载"**（= §4.5/B5 禁止的静默通路），且后续加载会被失败代的 wrapper 永久占位

**位置**：`lib/index.js:499`（首次安装）、`:550-551`（配置就绪后重装）——两处都在任何 try/catch 之外；`:552` 之后直到 `return async () => {…}`（`:751`）之间的所有代码（`:591 buildCaches → mkdirSync`、`:685 ctx.tools.register`、`:689 installAutoMode`、`:693 settings.watch`、`:735 ctx.inject`）只要能抛错，`apply()` 就**拒绝且不返回 disposer**；而缝是宿主服务上的**裸自有属性**，不是 `ctx.effect`，没有任何东西会去还原它。

**复现（本轮实测，临时目录脚本；令 ⑤ 的 `ctx.tools.register` 抛错，即 `:551` 之后的第一件事）**：

```text
apply() rejected with: tools service rejected the registration
disposer returned? undefined | marker present: true
gate answer AFTER the failed load: ["text","image"]
=> image prompt would be ADMITTED while the plugin is NOT loaded (no tool, no auto mode)
a later installSeam() reports: already (adopts the dead wrapper of the failed generation)
```

**为什么这是真的**：`resolveModelInfo` 被注入 `image` ⇒ session/subagent/ACP 三处闸门放行；而 bridge 侧一切（`vision_bridge_read` 工具、auto 注入）都没注册 ⇒ 模型只看到 `dsh-llm` 的 `[image omitted because this model accepts text only; attachment sha256:…]`，**没有任何人读这张图**，用户却看到消息发送成功。这正是 §1 目标 5 / §4.5 / review B5 明令禁止的那条路径，且要等到 DSH 重启才消失。

**触发概率不是"理论上的"**：`:591` 的 `buildCaches` 会 `mkdirSync(resolved.cache.persistDir, { recursive: true })`（`lib/index.js:557-558`）——权限不足 / 只读盘 / 磁盘满都会抛；`design.md` §12.6-17 正是把"启动时写宿主受限目录"登记为 🟡 风险。另需注意：`:499` 的**首次**安装此时 `seamOptions.reader` 仍为空，所以失败发生在 `:550` 之前时是 fail-closed（我实测：`apply()` 在 ③ 的 validate 抛错 → 残留的缝返回 `["text"]`，安全）；**危险区是 `:550` 之后的任何抛错**。

**同一根的第二个表现（误导性日志）**：settings.watch 里 `:719-721` 顺序是 `applySeamOptions → installCurrentSeam`，而 `installCurrentSeam` **第一行就是 `uninstallSeam()`**（`:404`）。若这次安装抛错，`:726-728` 的 catch 会打印 *"rebuild after settings change failed; previous runtime keeps serving"*——但缝已经被卸掉了，**"previous runtime keeps serving"是假的**（方向安全，日志失真）。

**修法（二选一或并用，都在一处）**：
1. 按本仓既有写法把安装挂到 fiber 上——`ctx.effect(() => { const r = installSeam(...); return r.restore; }, 'vision-bridge: runtime seam')`（同款用法见 `:685`）⇒ `apply()` 抛错/fiber 拆除时由 cordis 还原；
2. 在 `:499` 之后的整段包 `try { … } catch (error) { uninstallSeam(); throw error; }` 作为确定性双保险（顺序上先 uninstall 再 rethrow）。

**顺带的次级危害（复现已证）**：失败那一代的 wrapper 闭包的是失败那代的 `seamOptions`（reader 为空），而后续一次成功加载的 `installSeam` 会因 `marker.wrapped === raw.resolveModelInfo` 返回 `already` 并沿用它的 `restore` ⇒ 缝从此不再注入、功能要重启才恢复（方向仍是 fail-closed，但属于"装上了却永远不生效"）。

---

### 3.2 non-blocking

#### N-I1（🟡）自证路由不看 `seam.include` ⇒ 配了白名单就会得到**假 ✗**

`lib/index.js:465` 用 `pickTextOnlyModel(projectProviders(settingsReader.get, {}))` 挑自证路由，而生效判据是 `lib/index.js:414` 的 `seamRouteIncluded(seamOptions.include, …)`——**两边互不相干**。若白名单恰好不含"投影里第一个纯文本模型"，自证就去读一个被排除的路由。

**复现（本轮实测）**：投影里只有 `qax:glm-5.3`（纯文本），配置 `seam.include: ['zai-coding-cn:glm-5.3']`：

```text
B include=[zai-coding-cn:glm-5.3]  (projection only offers qax:glm-5.3)
   live? false | NOT-injecting warn: true
   warn line: vision-bridge: runtime seam installed but NOT injecting — self-check saw inputModalities=["text"] for qax:glm-5.3
   but the INCLUDED route really injects: ["text","image"]
```

缝其实正常注入，但 `seam.live=false` + 一条"NOT injecting"的 warn。影响：`seam.live` 正是 §4.6 卡片与 §4.7「缝 live 才让路」的判据 ⇒ 卡片会显示假 ✗；将来 §4.7 接上后，磁盘自愈会因此**不**让路（多做无害的磁盘动作）。方向安全（不是假 ✓），故非阻断。
**建议**：`include` 非空时从"被包含的路由"里挑自证目标；或把"自证路由被 include 排除"记为独立 reason（`excluded-by-include` ≠ `live:false`）。

#### N-I2（🟡）被装饰的方法带**每次调用的副作用**，而核心会**批量**调用它

- `lib/index.js:415 → readerAvailable() → ctx.credentials.resolve(...)`（`:382`）**每次调用**都执行一次凭证解析：实测 **5 次 `resolveModelInfo` ⇒ 5 次 `credentials.resolve`**。
- reader 不可用时 `lib/seam.js:149` **每次都 warn**：实测 4 次调用 ⇒ warn 从 1 涨到 5。

而 `dsh-llm` 的批量消费者确实存在：`buildModelCatalog` 对**每个 provider 的每个 model** 调一次 `ctx.llm.resolveModelInfo(provider.id, model.id)`（asar @16289331，R1 报告 N1 已录），一次 GUI 目录构建就是 N 次凭证解析 + N 行 warn。非阻断（不改变语义、方向安全），但建议：凭证结论做短 TTL 缓存 / 只在"允许→拒绝"跳变时打日志。

#### N-I3（🟡）`installSeam` 在不可扩展的服务上**抛错**（脱离它自己文档声明的三态契约），而调用点无守卫

`lib/seam.js:181-186` 的 `Object.defineProperty` 未包 try/catch。实测：

```text
preventExtensions -> THREW: TypeError: Cannot define property resolveModelInfo, object is not extensible
freeze            -> THREW: TypeError: Cannot define property resolveModelInfo, object is not extensible
```

`:499` 没有 try/catch ⇒ 未来内核若把服务实例冻结（R1 类变更），**整个插件加载失败**（连 tool 模式一起），而不是按 §4.5 降级成 `unsupported` + 红字。今天真实 `LlmRuntime` 是 `extensible:true`（R1 实测），故非阻断。
**建议**：把 `Object.defineProperty` 包进 try/catch → `{status:'unsupported'}`（或新增 `'readonly'` 态）。

#### N-I4（🟡）`ctx.get('llm')` 此刻为空时**不重试**（D2 的深层问题）

`installCurrentSeam()` 只在 `:499`、`:551`、以及 settings.watch（`:720`）被调用；没有 `ctx.inject(['llm'], cb)`（设计 §8-3a 恰恰点名了这个手段）。若 `apply()` 跑在 `llm` 服务就绪之前，缝整个进程期都不会安装（只有一行 warn），图片继续被硬拒。
**未断言**：我**没有**证据表明桌面版实际会出现"apply 时 llm 缺失"（cordis 的声明式 inject 会让插件等 `agents` 就绪，而 agent 运行时本身依赖 llm），因此按"方向安全 + 未证实的触发条件"记为非阻断。
**建议**：`ctx.inject(['llm'], () => installCurrentSeam())` 补一次后到重试，或在 §4.6 卡片把 `unsupported` 显示出来（缝状态目前对用户完全不可见）。

#### N-I5（🟡）§4.7 未接的当前后果（详见 §4 D3）

---

## 4. 三个裁决点

### D1 —— `lib/auto.js` 的 2 行改动：**理由真实、改动正确且充分；采纳（但请补写进交付说明）**

**理由真实（证据链完整）**：
- 判据读的是被装饰的方法：`lib/auto.js:124` → `resolveModelInfoUnseamed(...)`（改动前是 `llm.resolveModelInfo`）。
- 若读被装饰的方法，纯文本模型的答案会变成 `["text","image"]`（R1 实测；`tests/seam.test.mjs:301-307` 专门断言这一对：装饰读 `["text","image"]` / 未装饰读 `["text"]`）。
- 于是 `lib/auto.js:133` 的 `return !modalities.includes('image')` 变成 `false`，而 `:171-174` 收到 `false` 就 `entry.result={status:'skipped', gated:true}` 并**直接返回**——不发起任何 VLM 调用。
- 净效果：**恰好是被缝瞄准的那批纯文本会话**，图片既没被模型看见（占位符），也没被代读 ⇒ §4.5/B5 禁止的"发送成功但无人读图"。理由成立，**且这是本次改动里唯一一处"不改就一定静默回归"的地方**。

**改动正确**：`lib/seam.js:208-217` 走 `marker.original`（缝下面那一层）→ 拿到适配器真值；缝未安装时回退 `llm.resolveModelInfo`（`tests/seam.test.mjs:309-313`）；`llm` 缺失返回 `undefined`（`:134-137` 吞掉并保守假设需要桥）。`original` 在 `installSeam` 里捕获（`:130`）且 `restore` 只删自己的层，因此"别人叠在我们之上/缝未装"两种情况都不会误报。

**充分性（有没有遗漏同类读取点）**：本轮以 `resolveModelInfo|inputModalities` 全仓（`lib/` + `tests/`）grep 复核：

| 位置 | 用途 | 是否需要 unseamed |
|---|---|---|
| `lib/auto.js:124` | round-3 模态门禁（决定是否代读） | **需要**（已改） |
| `lib/index.js:478` | §4.5-2 自证 | **不能**改（它要读被装饰的那一层来证明注入生效） |
| `lib/server-routes.js:325` `vision: model.input.includes('image')` | 卡片 provider 投影 | 读的是 **settings 投影**，不经缝，无需改 |
| `lib/tools.js` | `vision_bridge_read` | 不按模态决策，无需改 |

⇒ **无遗漏**。`auto.test.mjs:59-61` 的 fake llm 仍按原契约提供 `resolveModelInfo`，全量 399/399 通过。

**流程意见**：越界本身该罚（writeScopes 是协调装置），但**回滚该改动会造成真实缺陷**，所以结论是"采纳 + 补记"：请 lead 在任务板/交付记录里把 `lib/auto.js` 补进 writeScopes 并注明"由 D1 裁决追溯授权"，避免下一轮审计把它当成未授权改动回滚。

### D2 —— `unsupported` 打 warn（服务存在却丢方法才升 error）：**可接受**

- **语义上成立**：两种情形确实不同——"宿主本来就没有 llm 注册表"是部署形态事实，"服务在、方法没了"才是 R1（内核改名/换代）的警报。实现把后者升 error（`lib/index.js:420-428`，判据 `llm !== undefined`），警报面没有丢。
- **理由的措辞需要修正**：任务卡转述的实现理由是"保住既有测试「apply() 不产生多余 error 行」的断言"。本轮 grep 未找到那条断言——现存的 error 计数断言只有 `tests/self-heal.test.mjs:124,134`（自愈失败路径）与 `tests/seam.test.mjs:295`（注入失败路径），且 apply 级测试的 `get('llm')` 都返回假 llm，"服务缺失"分支在测试里根本不被走到。所以：**接受这个分级，但要按代码注释里的那个（正确的）理由记录，而不是按测试约束记录**。
- **条件**：分级可接受的前提是"失败能被看见"。今天 `unsupported` 只有一行日志（卡片在 §4.6 下一批）⇒ 与 §4.5-1 的"卡片红字"要求之间还差一个可见面。若 §4.6 与本批同日交付则无问题；若延后，请把 N-I4（llm 后到不重试）一并解决，否则"`unsupported` 只写日志 + 永不重试"会让功能整场静默不工作。

### D3 —— §4.7（缝 live 时跳过磁盘自愈与行为探针）本批未接：**可以接受为下一批**，但必须带着下面两条一起走

我按代码把"未接"的当前后果核算了一遍：

1. **不会产生假 ✓（这是最关键的一条）**：客户端的 ✓ 条件是 `disk === 'patched' && runtime === 'dead'`（`lib/client.js:1453`），而桌面版上 `detectAdmissionPatch()` 走 `resolveNodeModulesDir()`（`lib/index.js:91-104`，回退 `<DSH_HOME>/profiles/web/node_modules`）在 asar 部署里必然找不到两文件 ⇒ `disk='unknown'` ⇒ 该行落在 `admissionUnknown`（`lib/client.js:1506-1516`）"准入补丁状态未知"，**不是 ✓**。所以 §4.7 担心的"把缝在跑误报成补丁就位"在当前 UI 判据下**不成立**——需要 disk 与 runtime **同时**满足才给 ✓。
2. **但有一处真实新后果（探针被打开的部署）**：缝 live 后探针的合成带图 prompt 会被**入账**（此前被闸拒绝 ⇒ 零残留），而 `cleanupScratchMessage` 在本部署**未接线**（`lib/index.js:314-316` 明说宿主无删除 API，§12.6-20 登记为残留）⇒ **scratch 会话里会真的留下一条合成 user/message**；同时 `runtime` 恒为 `dead`，`conflict`（disk=patched & runtime=live，§12.1 story-1 的信号）**再也不会触发**。三处都在同一批修（§4.7-2 "缝 live 时不跑探针"）。
3. 其余影响是"陈旧/无关"：桌面版上那行永远"未知"，而缝的真实状态在 UI 上**完全不可见**（§4.6 下一批）⇒ §1 目标 4「失败要响」目前只由日志承担。

**裁决**：接受为下一批，**条件**是 §4.6（卡片四行）+ §4.7（让路）**同批**交付且**排在功能对外可用之前**；否则请先把"探针被打开时的残留 + runtime 恒 dead"写进 `docs/VERIFY.md` 的已知偏差，避免有人开着 `VISION_BRIDGE_ADMISSION_PROBE=1` 把 `dead` 当成磁盘证据。

---

## 5. 汇总

| 项 | 判定 |
|---|---|
| §4.2 硬约束（10 条） | 全部符合 |
| §4.4 接线（5 条） | 4 条符合；**1 条偏离（B-I1：缺 fiber 生命周期的兜底）** |
| §4.5 前置条件/降级（4 条） | 3 条符合；1 条部分（D2 可见面 + D3 卡片未接） |
| 现有测试 | 24/24、399/399 独立复跑通过 |
| D1 auto.js 越界 | **采纳**（理由真实、无遗漏读取点；建议补 writeScopes 追溯记录） |
| D2 日志分级 | **可接受**（附理由措辞修正 + 可见性条件） |
| D3 §4.7 未接 | **可接受为下一批**（附两条条件） |
| blocking | 1（B-I1） |
| non-blocking | 5（N-I1…N-I5） |

**最小收敛路径**：修 B-I1（把安装挂到 `ctx.effect` 或给 `:499` 之后的整段加 try/catch + uninstall + rethrow），回归 `node --test`；N-I1/N-I3 是几行级改进，建议同批；N-I2/N-I4 可随 §4.6/§4.7 那批一起做。

VERDICT: FAIL
