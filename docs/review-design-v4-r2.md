# 第二轮核销报告：design-v4.1 修订稿

> 评审人：design-reviewer。本轮为**核销复核（verification round）**，不做全量重评。
> 对象：`docs/design-v4-runtime-seam.md`（v4.1，363 行，含 §10 逐条响应表）。
> 上一轮：`docs/review-design-v4.md`（VERDICT: FAIL，B1–B5 + N1–N10）——**本轮未改动该文件**。
> 本轮唯一写入产物：本文件。未改源码、未跑安装/构建/重启。

---

## 1. 结论

**通过（PASS）**。

B1–B5 五条 blocking **全部核销为「已处置」**；N1–N10 十条建议**全部在稿中落地**；上一轮唯一未验证项（宿主 `lib/main.js` 的 immutable 注释）本轮由我**独立核实**为真。
新增 blocking：**无**。
新增非阻断观察：2 条（N11 求值时机/属性保真；N12 两处 API/文件名引用精度）——均不影响 §4.2 骨架的正确性，也不阻塞实现。

最关键的一条：v4.1 §4.2 的骨架**不是纸面修改**。我把它**逐字复刻**后，在 asar 内的**真实 cordis 4.0.4 + 真实 `LlmRuntime`** 上跑了一遍（含 E5/E5b/E7/E8 与 R5 多插件场景），**全部通过**。

---

## 2. 逐条核销表

### 2.1 §4.2 骨架复核实测（本轮 B1/B2 的共同证据）

方法同上轮：`run_code`（Electron node）动态 import
`file:///D:/DSH-Desktop/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js` 与 `.../dsh-llm/lib/index.js`，
`new Context()` + `new LlmRuntime(ctx)`，再**逐字复刻 v4.1 §4.2 的 `installSeam`**（含 `CORDIS_ORIGINAL`、`SEAM_MARK`、`restore` 的两个 `delete`、以及 `already` 的行为自证）。实测输出：

```text
baseline: ["text"]
R-B1 install: installed -> ["text","image"]
R-B1 raw own prop exists: true | guard holds: true          ← 守卫在真实实例上恒成立
R-B2 second install: already
     shadow enumerable: true (prototype method was enumerable:false)   ← 见 N11
E5  restore: own prop gone: true | behavior: ["text"] | mark cleared: true
E5b re-install after restore: installed -> ["text","image"]           ← 不再是 already 假阳性
     already returns working restore: already true
     restore #2 -> ["text"] | mark cleared: true
     restore twice is safe: ok
R5  outer decoration preserved: true | value: ["text","x-other"]      ← 不破坏别人的装饰
final baseline: ["text"]
E7  excluded route: ["text"] | included route: ["text","image"]
E8  undefined inputModalities stays undefined: true | keys: provider,id,name
```

### 2.2 B1–B5

| # | 判定 | 依据（v4.1 章节） | 复核证据 / 说明 |
|---|---|---|---|
| **B1** 还原守卫恒 false ⇒ restore 空操作 | **已处置** | §4.2（`const raw = llm?.[CORDIS_ORIGINAL] ?? llm`、`restore` 用 `delete raw.resolveModelInfo`）；§4.2 要点第 1 条；§0 末句改条件句 | 实测：`inst.resolveModelInfo === SEAM_MARK.wrapped` 为 **true**（守卫成立）；`restore()` 后 `Object.hasOwn(inst,'resolveModelInfo') === false` 且行为回到 `["text"]`；E5/E5b 已在 §7 落位。与上轮我给出的修法一致，且经实测通过。 |
| **B2** `restore()` 不清标记 ⇒ `already` 假阳性 | **已处置** | §4.2 `delete raw[SEAM_MARK]`；`already` 判据为 `raw[SEAM_MARK]?.wrapped === raw.resolveModelInfo`（行为自证）；§4.4 幂等条；§4.5 第 3 条；E5b | 实测：restore 后**再装返回 `installed`**（v4 里返回 `already`）；`already` 返回的 `restore` 可正常工作；重复 restore 安全；`SEAM_MARK` 确被清除。§4.6 另加「标记残留」行，与 B2 要求的行为自证一致。 |
| **B3** `seam.mode/include` 未接 live 路径 | **已处置** | §4.3 三键表（`off` 标注 **live 生效**）；§4.4「live 更新」条（任一键变化 ⇒ restore → 重算 → 需要时重装，并明写「不允许出现配置说 off、进程里还装着」）；§7 **E6**；§8-3b | 设计层已定死语义与回归；落地位置指向 `lib/config.js`(`vol()`) + `settings.watch`，与本仓既有 live 面（`applies:'live'` + `settings.watch`）一致，可实现。 |
| **B4** 与 design.md §12 的关系未处置 / 探针误报 | **已处置** | §4.7 三条：①缝 live 时**跳过** `selfHealAdmissionGate`（记 info）；②缝 live 时**不跑** `probeAdmissionGate`，并写明「判据在缝生效后必然读作 `dead`」的机理；③磁盘补丁退役条件；§6 **R9**；§4.6 磁盘补丁行标注「已被缝取代」 | §4.7-2 的机理与我上轮实测/推断一致（探针挑「声明纯文本」的模型发合成带图 prompt，缝生效后闸不再拒 ⇒ 必读 gate-dead）。处置方向（跳过 + 卡片判据换成缝自证）与我的建议一致。落地的求值时机见 N11。 |
| **B5** 新增「发送成功但无人读图」静默路径 | **已处置** | §4.5 前置条件段：`seam.requireReader`（默认 true）代读不可用则**不安装**、保持硬拒绝；§4.3 三键之一；§1 目标 5；§6 **R6** 如实登记残缝；§4.6「代读可用性」行 | 处置到我要求的层次：把「代读可用性」变成缝的前置条件，并且**如实声明边界**（判据是「配置可用」而非「运行可用」；auto 仍会吞错；tool 模式失败可见）。这正是我要求「要么前置、要么显式提示」中的前者 + 提示。判据的 API 精度见 N12。 |

### 2.3 N1–N10（及上轮未验证项）

| # | 判定 | 依据（v4.1 章节） | 说明 |
|---|---|---|---|
| **N1** R2 事实纠错（ACP / compaction / GUI） | **已处置** | §6 R2 重写（四小条）；§0 表格增 ACP；§3.1 增 ACP 片段；§4.3「ACP 面决策」条 | 四条与我上轮实测表逐条对应：ACP 是真正额外消费者且**被显式决策接受**（并给了 `seam.include` 收窄手段）；`buildModelCatalog` **不复制** `inputModalities` ⇒ GUI 安全；compaction **不读模态**；适配器内部不经缝。 |
| **N2** 缝的覆盖边界 | **已处置** | §3.3「覆盖边界」段（`resolveCallConfig → resolveCallFor → resolveModelInfoFor` 绕过；远程面不含该方法；**设计约束：永远只装饰 runtime 服务方法**）；§6 R4 | 三条都在，且最后那条「不得下沉到 adapter」是我上轮点出的关键约束，已写成可执行的设计约束。 |
| **N3** E1 改自动化单测、删错误前提的兜底 | **已处置** | §7 E1（`tests/seam.test.mjs` 第一组用例，装/自证/守卫/还原/再装）；§4.2 要点末条（`internal/get` 兜底叙述已删，改为「若将来直连装饰不可用再另行设计」，并保留 `seen` 命不中的提醒） | E1 的断言序列正好覆盖 B1/B2 两个回归点。 |
| **N4** 验证矩阵补齐 | **已处置** | §7 E5b / E6 / E7 / E8 / E9 / E10 | 六条与我列的一一对应，措辞可执行（E7 明确「被排除的路由仍然被拒」；E8 明确「逐字段相同」；E10 明确跨代际）。本轮已实测其中 E7/E8 的骨架级行为（见 §2.1）。 |
| **N5** 用 `ctx.get('llm')`，不扩严格 inject | **已处置** | §8-3a（「读取走 `ctx.get('llm')`（**不扩严格 `inject`**），需要时可局部 `ctx.inject(['llm'], cb)`」）；§4.5-1 | 与本仓「可选/后置服务一律 `ctx.get`」的既有风格一致。 |
| **N6** 卡片态补「标记残留」「代读可用性」 | **已处置** | §4.6 四行表 | 四行齐全，判据均为行为/事实而非标记；并含遗留磁盘补丁行的对代际说明。 |
| **N7** 交付件清单 | **已处置** | §8-8（`tests/TEST-MATRIX.md` 映射行、`CHANGELOG.md`、`package.json` `0.1.1 → 0.2.0`）；§8-7（design.md §5.4 改写 + §12 退役登记、README） | 与 design.md §12.3 的 house pattern 对齐。 |
| **N8** §0 末句改条件句 | **已处置** | §0 末句：「…**停用即恢复原样**（该承诺由 §7 的 E5/E5b 断言，还原经真实实例的自有属性删除实现，见 §4.2）」 | 已从「无条件承诺」变为「挂断言的条件承诺」，且指明了实现机制。 |
| **N9** §4.3 配置面落地细节 | **已处置** | §4.3（`include` 语法 `^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$`、非法元素**整体拒绝并保留旧值**、默认 `[]` 的理由）；§8-3b（`lib/config.js` 三键 + `vol()` = live + `resolveConfig` 校验 + `settings.watch` 驱动装卸） | 落地位置明确。文件名引用 `internal/config` 与本仓 `lib/config.js` 不一致，见 N12（纯引用精度）。 |
| **N10** SEAM_MARK 命名与清理 | **已处置** | §4.2 `Symbol.for('@dsh-external/dsh-vision-bridge/seam')`；`restore` 内 `delete raw[SEAM_MARK]`；§4.4 幂等条 | 包名命名空间已加；清理已在 `restore` 内（实测：mark cleared: true）。另：`CORDIS_ORIGINAL = Symbol.for('cordis.original')` 与 shipped cordis 的 `symbols.original` **字面一致**，且经实测可用。 |
| **上轮未验证项**：宿主 `lib/main.js` 的 immutable 注释 | **已处置（本轮独立核实为真）** | §1 现状第 2 条；§10 末行 | 我在 asar 中定位到：`@116501474` 「Descriptor at the root of the **immutable Desktop resource tree**」（`lib/types/runtime-tree.js` 区域）、`@116501030` `resolveDesktopPaths` 的「`@returns immutable desktop path set`」（`lib/types/paths.js` 区域）、`@116502010` `readDesktopRuntime(root)`。经 asar 索引反查，**这三处同属根级 `/lib/main.js`**（该 bundle 用 `//#region <原文件>` 标注原路径）⇒ §1 把来源写成 `lib/main.js` 是**准确的**，上轮的「未验证」项就此核销。 |

---

## 3. 新增 blocking

**无。**

按任务纪律，本轮未扩大范围找新问题；§4.2 骨架已在真实运行环境实测通过（含 E5/E5b/E7/E8/R5），未发现会导致实现返工或静默失效的高置信度新缺陷。

---

## 4. 新增非阻断观察（不影响 PASS）

**N11（🔵）两处「求值时机 / 属性保真」的小精度问题，实现前定死即可**
1. **影子的可枚举性**：`raw.resolveModelInfo = wrapped` 经 cordis 的 `set` trap 走 `CreateDataProperty`，产生的自有属性是 **`enumerable: true`**，而原型方法的原文是 `enumerable: false`（实测见 §2.1）。若希望与原方法逐项保真（避免任何 `Object.keys`/`{...instance}`/`structuredClone` 类代码意外看到它），可用
   `Object.defineProperty(raw, 'resolveModelInfo', { value: wrapped, writable: true, configurable: true, enumerable: false })`；
   `delete` 还原的写法不变。**不阻塞**——`LlmRuntime` 实例本就有 `ctx/name/adapters/…` 等自有属性，多一个枚举属性在当前消费者中未见影响（本轮全 asar 扫描未见对 llm 实例做枚举/克隆的代码）。
2. **`requireReader` / `seam.live` 的求值时机**：§8-3a 要求缝在 `apply()` **最先**安装，而 §4.5 的 `requireReader` 判据需要 resolved config（`provider.baseURL/model/credential`），后者来自 ①设置面 + ②`ensureFrozenDefaults` + ④`resolveConfig`（`lib/index.js:340-361`）；同时 §4.7-1 要求「缝 live 时跳过磁盘自愈」，而 `selfHealAdmissionGate()` 当前是 ⓪ 就执行、且**刻意**放在设置面之前（`lib/index.js:328-338` 注释：某些内核上 `settings.register` 会抛，写在其后会让修复永不执行）。三者构成一个顺序张力。实现前建议二选一定死：
   - (a) 把 `requireReader` 从「安装前置条件」改为 `wrapped` 内的**调用时谓词**（安装只依赖 `ctx.get('llm')`，故可留在 ⓪），或
   - (b) 把磁盘自愈的调用移到 ④ 之后（并保留其「永不抛、永不阻塞启动」的性质）。
   同理，§4.5-2 的「对**当前会话模型**跑一次真实解析」在 `apply()` 时可能还没有会话——建议把自证路由来源写死（例如取配置默认路由，或 `llm.listProviders()/listModels()` 中第一个声明为纯文本的路由；本仓 `pickTextOnlyModel` 已有同款取法可复用，`lib/index.js:250-259`）。
   **不阻塞**：这是两行级别的实现选择，不影响 B3/B4/B5 的处置成立。

**N12（🔵）两处引用精度**
1. §4.5 的判据写作 `ctx.credentials.describe(ref)`，但该服务的方法签名是 **`describe(refs)`（数组）**，返回描述行 `{configured, source?, writable}`（本仓已在 `lib/server-routes.js:37-49` 记录该契约、`lib/client.js:926` 也按数组调用）；服务端本仓的既有先例是 **`credentialRef(name)` + `ctx.credentials.resolve()`**（`lib/index.js:417-428`，未配置时抛出可读错误）。建议实现时二选一并写明。
2. §4.3 写「沿用本仓 `internal/config` 的 refuse-and-keep-old 语义」——本仓该模块的实际路径是 **`lib/config.js`**（§8-3b 里写对了）。纯引用笔误，不影响语义。

---

## 5. 核销总表（一屏）

| B1 | B2 | B3 | B4 | B5 | N1 | N2 | N3 | N4 | N5 | N6 | N7 | N8 | N9 | N10 | 上轮未验证项 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已处置 | 已核实为真 |

未核销 blocking：0；新增 blocking：0；新增非阻断观察：2（N11、N12）。

**建议**：N11 的两点（可枚举性、求值时机）在 §8 步骤 0「决策先行」里各补一句即可，不必再送一轮评审。

VERDICT: PASS
