# 设计方案 v4.1：运行时服务缝（Runtime Service Seam）

> 目标：让 dsh-vision-bridge 在 **DSH 桌面版（0.1.7-rc.2 / app.asar 内核）** 上恢复"任何模型都能收图"的能力，
> 且**不再修改 DSH 本体任何文件**。
>
> 状态：设计稿 v4.1（未实现）。v4.1 依独立评审 `docs/review-design-v4.md`（VERDICT: FAIL）的 B1–B5 必改项修订，
> 逐条响应见 §10。前置实验已由该评审完成并落成单测（§7 E1）。
> 关联：docs/design.md §5.4（旧的"改内核源码"策略，本方案将其替换）、§12（启动自愈 + 行为探针，处置见 §4.7）。

---

## 0. 一页结论

DSH 里与"图片能力"有关的判定**走两条互不相交的代码路径**：

| | 谁在用 | 读什么 |
|---|---|---|
| **闸门**（查询型） | session controller 的 prompt 准入、subagent 的 assertImageCapable、ACP 的 assertImageRoute | `llm.resolveModelInfo(provider, model)`（同进程服务方法） |
| **投影**（请求型） | LlmRuntime.adapterStream 决定要不要把图换成文字占位符 | `adapter.prepareCall().model` → `normalizeModelInfo`（`LlmRuntime.prepareCall` 的 prepared 路径同样不经服务方法） |

**只要让"闸门"看到 `inputModalities` 含 `image`，"投影"就会照旧把图片替换成
`[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]` 占位符。**

于是本插件的全部诉求，从"改内核源码"降级为"**在内存里装饰一个服务方法**"：
不改文件、不碰 app.asar、不碰 node_modules；**停用即恢复原样**（该承诺由 §7 的 E5/E5b 断言，还原经真实实例的自有属性删除实现，见 §4.2）。

---

## 1. 背景与目标

### 现状（2026-09-25 实测）

- 桌面版内核位于 `D:\DSH-Desktop\resources\app.asar\dsh\`，**不是**任何 profile 的 node_modules；
  宿主进程命令行可证：`DeepSeek Harness.exe --expose-internals <app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js <app.asar>\dsh <DSH_HOME>\profiles\desktop ...`。
- 宿主 `lib/main.js` 的 `resolveDesktopPaths / readDesktopRuntime` 区域注释称该树为 **immutable Desktop resource tree**（本次由 lead 直接抽取核实；评审声明其未抽取该文件，不改变结论）。
- 现有的 `scripts/patch-admission-gate.mjs` 按目录写文件，够不到 asar；且其 `DEFAULT_NM` 推导仍是 `<DSH_HOME>/profiles/web/node_modules`（web 代际，评审已核实），桌面版上指向一个不含核心包的目录。
- 结果：准入闸保持原样，纯文本模型（如 `zai-coding-cn:glm-5.3`，`input: []` ⇒ `["text"]`）发送带图 prompt 时抛
  `session/attachment-invalid` / `reason=MODEL_DOES_NOT_SUPPORT_IMAGES`，图片永不入账。

### 目标

1. 纯文本模型也能发图：图入账 → 运行时投影成占位符 → 插件代读（tool / auto 双模式照旧）。
2. **零内核改动**：不写 app.asar、不写 `node_modules`、不写 `~/.dsh` 之外的任何系统目录。
3. 跨代际一致：便携版（0.1.6 / 0.1.7-web）与桌面版同一份代码。
4. 失败要响：机制失效时**显式报警并降级**，绝不静默装作成功。
5. **不得制造"发送成功但无人读图"的静默路径**（v4.1 新增，见 §4.5 B5 处置）。

---

## 2. 为什么必须换机制

旧策略（design.md §5.4）把准入条件惰性化：

```js
// dsh-api-session-controller/lib/index.js — prompt() 内（评审已逐字核对）
if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) {
  throw new RemoteError("session/attachment-invalid",
    `Model "${current.model}" does not support image input.`,
    { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}
```

它要求**磁盘上的内核源码可写**。在便携版成立，在桌面版不成立。

结论：**策略必须从"改源码"迁移到"改运行时状态"。**

---

## 3. 关键发现：闸门与投影是两条独立路径（评审已实测确认）

### 3.1 闸门（查询型）

```js
// session-controller：prompt() 内，图片准入被 agents.serializeImageAdmission(agent, admit) 串行化
const current = this.agents.selectionFor(agent).current;
const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) throw ...

// dsh-subagent：assertImageCapable()
const llm = this.ctx.get("llm");                     // inject 豁免读，与 ctx.llm 落到同一个实例
const info = await llm.resolveModelInfo(provider, model, signal);
if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) throw ...

// ACP：assertImageRoute / supportsAcpImagePrompts（v4.1 补，评审 N1）
if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) throw new AcpContentError(...)
```

三处都是**同进程服务方法调用**（插件既有代码 `ctx.get('sessionController').prompt(...)` 证明插件与 session controller 同容器）。

### 3.2 投影（请求型）

```js
// dsh-llm：LlmRuntime.adapterStream()
if (prepared === void 0) {
  const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
  modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
} else {
  modelInfo = prepared.modelInfo;                    // 来自 LlmRuntime.prepareCall，同样不经 resolveModelInfo
}
...
if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")
    && projectedMessages.some(m => contentHasImage(m.content))) {
  projectedMessages = projectImagesForTextModel(projectedMessages);   // → "[image omitted … sha256:xxxxxxxx]"
}
```

### 3.3 两条路径不交叉（本方案的地基）

```js
async resolveModelInfo(provider, model, signal) {          // 查询型
  return this.resolveModelInfoFor(this.registration(provider), model, signal);   // → adapter.resolveModel
}
async prepareCall(config, signal) {                        // 请求型（投影用它）
  const adapterCall = await registration.adapter.prepareCall(...);               // → adapter.prepareCall
  const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
}
```

**前者从不调用后者，后者从不调用前者** ⇒ 装饰前者不改变后者的结论。

**覆盖边界（v4.1 补，评审 N2）** —— 缝只覆盖"通过服务方法 `resolveModelInfo` 取模态的**同进程**消费者"：

- 直连内部解析器的路径 `resolveCallConfig → resolveCallFor → resolveModelInfoFor` 绕过装饰（今天只返回 `.config`，不含模态，无消费者受影响）；
- 远程面（`typert.remote-client`）只把 `listProviders / listConfigurableProviders / remoteDiscoverModels` 标为 `@Remote`，`resolveModelInfo` **不在远程面**——这正是本方案能生效的前提；
- 适配器基类 `LlmAdapter.prepareCall` 内部会回调 `this.resolveModel`（适配器层同源），**但缝装饰的是 LlmRuntime 服务方法，不是 adapter**。
  **设计约束：永远只装饰 runtime 服务方法，不得下沉到 adapter**，否则闸门与投影会一起被污染。

---

## 4. 方案主体

### 4.1 架构

```
  用户贴图 → 发送 ─▶ session-controller: prompt() ─┐
  子代理带图 ─────▶ subagent: assertImageCapable ──┤  读 llm.resolveModelInfo
  ACP 面 ────────▶ acp: assertImageRoute ──────────┘        │
                                                            │ ← 装饰点（本插件，同进程）
  LlmRuntime.adapterStream ◀── adapter.prepareCall().model ─┘   注入 image ⇒ 放行
      （不走装饰点）→ projectImagesForTextModel → "[image omitted … sha256:xxxxxxxx]"
```

### 4.2 装饰实现（v4.1 修正版骨架）

> v4（旧稿）的骨架有两个经评审实测确认的错误：还原守卫恒为 false、restore 不清标记。
> v4.1 采用评审实测通过的写法。

```js
// lib/seam.js（新增）
export const SEAM_MARK = Symbol.for('@dsh-external/dsh-vision-bridge/seam');
const CORDIS_ORIGINAL = Symbol.for('cordis.original');   // cordis 的实例真身标记

/**
 * Install the seam on one llm service instance.
 * Idempotent per RAW instance; returns { status, restore }.
 */
export function installSeam(llm, { include, logger } = {}) {
  const raw = llm?.[CORDIS_ORIGINAL] ?? llm;             // ★ 一律对真实实例操作
  if (typeof raw?.resolveModelInfo !== 'function') return { status: 'unsupported' };

  // 幂等 + 行为自证（不能只看标记：见评审 B2）
  if (raw[SEAM_MARK]?.wrapped === raw.resolveModelInfo) {
    return { status: 'already', restore: raw[SEAM_MARK].restore };
  }

  const original = raw.resolveModelInfo;
  const wrapped = async function (provider, model, signal) {
    const info = await original.call(this, provider, model, signal);
    if (!include(provider, model, info)) return info;
    if (info.inputModalities === undefined) return info;      // 未声明 = 不拦；逐字段保持原样
    if (info.inputModalities.includes('image')) return info;
    return { ...info, inputModalities: [...info.inputModalities, 'image'] };
  };

  const restore = () => {
    if (raw.resolveModelInfo !== wrapped) return;             // 不是最外层就不动（不破别人的装饰）
    delete raw.resolveModelInfo;                              // 暴露原型方法
    delete raw[SEAM_MARK];                                    // ★ 清标记（评审 B1/B2）
  };
  // 保真（评审 N11a）：宿主原型方法不可枚举，赋值经 cordis set trap 会变成 enumerable:true
  Object.defineProperty(raw, 'resolveModelInfo', { value: wrapped, writable: true, configurable: true, enumerable: false });
  raw[SEAM_MARK] = { wrapped, restore };
  return { status: 'installed', restore };
}
```

要点：

- **只对真实实例操作**：`ctx.llm` / `ctx.get('llm')` 每次返回**新的** traceable 代理，
  且**每次读方法也返回新的 shadow-method 代理** ⇒ `llm.resolveModelInfo === wrapped` 永不成立（评审实测）。
  故一切读写与还原都经 `[Symbol.for('cordis.original')]` 落到真实实例，还原用 `delete`。
- **已证实可行**：真实 cordis 4.0.4 + 真实 `LlmRuntime` 实测：实例 `frozen:false / extensible:true`，
  `resolveModelInfo` 是原型方法（writable/configurable），赋值产生自有属性并全局生效。
- **保持签名** `(provider, model, signal)` 与 async 语义；返回**新对象**，不改写适配器返回的原对象。
- **`inputModalities === undefined` 不动**——那种适配器闸门本来就不拦，且 ACP 的"未声明即拒"语义也要求保持原样。
- **不再需要 `internal/get` 兜底**（v4 的那段叙述基于错误前提，已删除）。若将来直连装饰被证明不可用，
  再按 `internal/get` waterfall 方案另行设计——注意其 `seen` 去重按代理语义同样命不中，只能靠真实实例打标。

### 4.3 生效范围与配置

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `seam.mode` | `auto` / `off` | `auto` | `auto` = 安装装饰；`off` = 卸载（**live 生效**，见 §4.4） |
| `seam.include` | 字符串数组，元素形如 `"provider:model"` | `[]` = 全部 | 只对这些路由注入；空 = 对所有"已声明为纯文本"的模型生效 |
| `seam.requireReader` | `true` / `false` | `true` | 代读不可用时**不装缝**，保持硬拒绝（B5 处置） |

- `include` 语法与校验：元素必须匹配 `^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$`；非法元素**整体拒绝并保留旧值**
  （沿用本仓 `lib/config.js` 的 refuse-and-keep-old 语义，由 `internal/config` 拦截），不静默丢弃。
- 默认 `[]`（全部）的理由：对已认图模型注入无副作用（`includes('image')` 分支提前返回），对纯文本模型注入正是本插件的意义。
- **ACP 面决策（评审 N1）**：缝会让纯文本模型在 ACP 面被"如实广告"为收图模型。
  本批**接受**该语义（与两个核心闸门一致），并在 §6 风险表登记；需要规避的用户可用 `seam.include` 收窄。

### 4.4 生命周期、live 更新与幂等

- 安装时机：`apply()` **最先**执行（先于任何可能触发 prompt 的路径）。
- **live 更新（v4.1 补，评审 B3）**：`seam.mode` / `seam.include` / `seam.requireReader` 均为**可热改**配置，
  接入既有的 `settings.watch` 路径：任一键变化即 `restore()` → 按新配置重新计算 → 需要时重新 `installSeam()`。
  **不允许**出现"配置说 off、进程里还装着"的静默不一致。
- 卸载：fiber dispose 时 `restore()`；`restore()` 幂等、且只在"我仍是最外层"时动作。
- 幂等：以**真实实例**上的 `SEAM_MARK.wrapped === raw.resolveModelInfo` 作行为自证；
  标记存在但函数不是我们那一层 ⇒ 视为"未装"，按未装处理（评审 B2）。

### 4.5 探测、降级与前置条件（不许静默）

`installSeam` 返回三态，并在安装后**立刻自证**：

1. `unsupported`：`ctx.get('llm')` 为空或没有 `resolveModelInfo` → error 日志 + 卡片红字，不冒充成功。
2. `installed`：对**自证路由**跑一次真实解析，断言返回值 `inputModalities` 含 `image`；通过 ⇒ `seam.live = true`。
   自证路由的取法写死（评审 N11b）：复用 `lib/index.js` 的 `pickTextOnlyModel(providers)`（从设置的 providers 投影里挑一个已声明为纯文本的模型）；
   取不到时本态记 `unknown`（不冒充 ✓），沿用 design.md §12.2 B 的既有语义。
3. `already`：仅在行为自证通过时返回；否则按未装处理（B2）。

**前置条件（v4.1 补，评审 B5）**：当 `seam.requireReader` 为 `true`（默认）且**代读不可用**时缝**不注入**
（保持"硬拒绝"的旧行为——用户立刻知道这条消息没进去，而不是得到一条"成功但没人看过图"的消息）。

- **求值时机（评审 N11b 定死）**：`requireReader` 是 `wrapped` 内的**调用时谓词**（不是安装时快照）——
  因此 §8-3a「apply() 最先装缝」与 §4.7-1「缝 live 才跳过自愈」的既有调用顺序都不必改动，
  且 live 配置变化（§4.4）自动生效；被谓词挡下的调用记一行 warn（含路由与原因），不静默。
- 代读可用性的判据（**不联网**）：`provider.baseURL` 与 `provider.model` 非空，且凭证已配置——
  用本仓既有先例 `credentialRef(name)` + `ctx.credentials.resolve()`（`lib/index.js` 凭证段），
  不新造 `credentials.describe(ref)` 的用法（评审 N12a：`describe` 实际收的是 `refs` 数组）。
- 如实声明的边界：这是"**配置可用**"而非"**运行可用**"。配置完好但 VLM 调用失败时，
  auto 模式仍会吞掉错误（design.md §5.4）；这是本方案已知残留缝隙，登记于 §6 R6。
  缓解：tool 模式下模型调用失败对用户可见；体检区显式提示"代读配置可用但未验证连通"。

### 4.6 设置卡片

体检区改为**四行**（v4.1 依评审 N6 修订）：

| 行 | 判据 | 文案 |
|---|---|---|
| 运行时缝 | `seam.live === true` ⇒ ✓ / `installed` 未自证 ⇒ 中性 / `unsupported`·`degraded` ⇒ ✗ + 原因 | 任何模型都能收图（本会话即可验证） |
| 标记残留 | `SEAM_MARK` 在但行为自证失败 | 明确报"标记在、缝不在"，并提供"重装" |
| 代读可用性 | §4.5 的配置判据 | 未配置时说明"已按设计保持硬拒绝" |
| 磁盘补丁（遗留） | 仅便携版/旧内核展示 | 桌面版标注"对本部署不适用"，并说明已被缝取代 |

### 4.7 与 docs/design.md §12 的关系（v4.1 补，评审 B4）

§12 的**磁盘自愈**与**行为探针**必须随缝一起处置，否则探针会把"缝在跑"误报成"闸已失效/补丁就位"：

1. **磁盘自愈（`selfHealAdmissionGate`）**：当缝 `live` 时**跳过**，并记一行 info
   （"seam live — admission disk patch not needed"）；未 live 时维持原行为。桌面版上原本的 not-found 静默分支改为显式 info。
2. **行为探针（`probeAdmissionGate`）**：缝 `live` 时**不跑**——该探针的判据（是否出现 `MODEL_DOES_NOT_SUPPORT_IMAGES`）
   在缝生效后必然读作 `dead`，会给出与磁盘状态无关的错误结论。卡片上缝 live 时该行的判据改为"缝行为自证"。
3. **磁盘补丁的退役条件**：当缝在**全部**目标代际（桌面版 + 便携版）都能自证 `live` 后，`patch-admission-gate.mjs` 与 §12 整体退役；
   本批先做第 1、2 条，退役登记为后续工作。

---

## 5. 备选路线与取舍

| 路线 | 做法 | 优点 | 致命点 | 结论 |
|---|---|---|---|---|
| **A 运行时缝（本方案）** | 装饰 `LlmRuntime.resolveModelInfo` | 零落盘、零内核改动、闸门与投影天然分离、跨代际；可写性已实测 | 依赖未文档化的服务方法名 | **采用** |
| B 改模型配置 + llm/stream 中间件 | profile 里给 `input` 加 `image`，再用中间件自己投影 | 只用公开配置面 + 官方 `llm/stream` 扩展点 | message 被 `deepFreeze`、`options` 可能冻结，且 waterfall 的 `next` 由宿主以闭包捕获原 options（改参数无效）⇒ 必须深拷贝 + 防递归，脏且易碎 | 保留为兜底 |
| C 本地反向代理 | baseURL 指向插件自建的 OpenAI 兼容代理 | 对内核完全无侵入 | 要自建 SSE 流式转发/中止/错误透传/多协议 | 备选 |
| D 继续改内核 | 直接改 app.asar 内字节 | 与旧策略同构 | 每次桌面版升级被覆盖；动的是宿主不可变资源树 | 仅作应急 |

---

## 6. 风险清单（v4.1 重写）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | `resolveModelInfo` 是内部方法名，未来改名 | 缝静默失效 | §4.5 三态 + 行为自证；失败显式报警；升级后跑体检 |
| R2 | **额外消费者被误导**（评审 N1 重写）：<br>① ACP `assertImageRoute`/`supportsAcpImagePrompts` ⇒ 纯文本模型被"如实广告"为收图模型<br>② `buildModelCatalog`（浏览器模型目录）经查**不复制** `inputModalities` ⇒ GUI 安全<br>③ compaction `compactIfNeeded` 只用 `context`/`defaultMaxTokens`，**不读模态**（v4 的举例错误，已纠正）<br>④ deepseek/pi-ai 适配器读各自 catalog，不经缝 | ① 语义变化；②③④ 无影响 | ① 本批接受并用 `seam.include` 提供收窄；②③④ 写入证据表以避免误判 |
| R3 | 直连装饰在别的部署形态失效（代理/派生实例） | 缝不生效 | §4.5 行为自证兜底；`unsupported` 显式报警 |
| R4 | 未来内核把投影判定也改走 `resolveModelInfo`，或改走 `resolveCallConfig → resolveModelInfoFor` | 图直发上游（上游报错） | §3.3 的覆盖边界写进设计；体检加"请求侧是否出现原图"的观测；必要时启用路线 B |
| R5 | 多插件先后装饰同一方法 | 互相覆盖 | 还原只在"我仍是最外层"时动作（经真实实例判定）；`SEAM_MARK` 用包名命名空间 |
| R6 | **"发送成功但无人读图"**（评审 B5） | 用户以为图被处理了 | §4.5 的 `seam.requireReader` 前置条件 + 体检区显式提示；auto 失败吞错是已知残留缝隙 |
| R7 | live 配置与运行态不一致（评审 B3） | 静默假象 | §4.4：三键接入 `settings.watch`，改即生效 |
| R8 | `SEAM_MARK` 残留造成 `already` 假阳性（评审 B2） | 缝永久静默失效 | `already` 必须行为自证；`restore()` 清标记；E5b 回归 |
| R9 | 与 §12 探针互相干扰（评审 B4） | 体检给出错误结论 | §4.7 的处置：缝 live 时跳过自愈与探针 |

覆盖边界（评审 N2）：缝只覆盖同进程、经服务方法 `resolveModelInfo` 取模态的消费者；直连 `resolveModelInfoFor` 的内部路径与远程面不受影响。
并发（评审 F1）：图片准入被 `serializeImageAdmission` 串行化；缝的装卸是同步属性读写，`wrapped` 无共享可变状态 ⇒ **未发现新增并发面**。

---

## 7. 验证计划（v4.1 扩充）

**E1 可行性与还原（自动化单测，非一次性探针）** —— 评审已给出确定答案，直接落成 `tests/seam.test.mjs` 第一组用例：
装 → 断言行为（`["text","image"]`）→ 断言还原守卫命中 → 还原 → 断言回到基线（`["text"]`）→ 再装。
（评审 N3：不要再搭临时打印插件。）

**E2 端到端（纯文本模型）**：`zai-coding-cn:glm-5.3` 会话贴图 → 发送成功 → 会话日志出现含 image block 的 `user/message`
→ 模型上下文出现 `[image omitted … sha256:xxxxxxxx]` → `vision_bridge_read` 返回结构化描述。

**E3 多模态回归**：`glm-5.3-flash` 贴图 → 原生内联；并断言装缝前后返回的 modelInfo **逐字段相同**。

**E4 子代理路径**：给纯文本子代理发图 → 不出现 `subagent/attachment-invalid`。

**E5 卸载还原**：停用插件 → 同会话再贴图 → 恢复 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
**E5b 停用→再启用**（抓 B2）：必须正常重装，不得报 `already` 假阳性。

**E6 live 生效**（抓 B3）：`seam.mode=off` / `include` 收窄后**不重启**即生效。
**E7 include 反向断言**：被排除的路由**仍然**被拒（证明白名单非装饰）。
**E8 未声明模态不变式**：`inputModalities === undefined` 的适配器在装缝前后返回值逐字段相同。
**E9 多面不回归**：装缝后浏览器模型目录与 ACP 面各跑一次冒烟（对应 R2）。
**E10 跨代际**：E2–E5 在便携版与桌面版各跑一遍（目标 3 的验收）。

---

## 8. 实施步骤（v4.1 调整）

> 评审 Q4：B4/B5 的决策前移到写码前；步骤 3 拆成 3a/3b。

0. **决策先行**：§4.7（与 §12 的关系）与 §4.5（`requireReader` 前置条件）——本稿已给出结论，实现时照此落地。
   **顺序定死（评审 N11b）**：`requireReader` 做成 `wrapped` 内的调用时谓词，故 `apply()` 的既有顺序
   （⓪ 自愈 → ①–④ 设置面 → 装缝）保持不变；自证路由用 `pickTextOnlyModel`，取不到记 `unknown`。
1. **E1 单测**：`tests/seam.test.mjs` 第一组用例（装/自证/还原/再装）。
2. `lib/seam.js`：修正版装饰 + 还原 + 行为自证幂等 + 三态。
3. **3a** 接线（无配置面）：`apply()` 最先安装；读取走 `ctx.get('llm')`（**不扩严格 `inject`**，评审 N5），
   需要时可局部 `ctx.inject(['llm'], cb)`；dispose 还原。此步即可跑 E1/E2/E5。
4. **3b** 配置面：`lib/config.js` 加三键（`vol()` = live）+ `resolveConfig` 校验（非法 `include` 整体拒绝）+ `settings.watch` 驱动装卸（E6/E7）。
5. **4** 体检区改版（§4.6 四行，独立提交，便于二分定位）。
6. E2–E10 验证，结果写入 `docs/VERIFY.md`。
7. 文档：`docs/design.md` §5.4 改写、§12 加退役登记；README 已知限制更新。
8. 交付件（评审 N7）：`tests/TEST-MATRIX.md` 映射行、`CHANGELOG.md` 条目、`package.json` version `0.1.1 → 0.2.0`。

**本批不做**：`patch-admission-gate.mjs` 的删除（§4.7-3 退役登记为后续）、`lib/client.js` 之外的卡片重构。

---

## 9. 开放问题

- Q1：`seam.include` 之外是否还需要"按会话临时关闭"的逃生开关？
- Q2：路线 C（反向代理）是否值得作为"完全无侵入"的长期形态并行推进？
- Q3：磁盘补丁（§12）何时正式退役——缝在便携版上也自证 live 之后？
- Q4：ACP 面接受"纯文本模型被广告成收图模型"，是否需要按 provider 默认收窄？

---

## 10. 修订记录（v4.1，逐条响应评审 docs/review-design-v4.md）

| # | Action | Detail |
|---|---|---|
| B1 | Fixed | §4.2 改为对真实实例操作（`[Symbol.for('cordis.original')]`）+ 还原用 `delete`；采用评审已实测通过的写法；§0 的"停用即恢复"改为条件句并挂 E5/E5b（原守卫 `===` 恒 false） |
| B2 | Fixed | `restore()` 同时删除 `SEAM_MARK`；`already` 必须行为自证（§4.2/§4.4/§4.5）；新增 E5b 回归 |
| B3 | Fixed | §4.3/§4.4 定死三键为 live，接入 `settings.watch` 驱动装卸；新增 E6 |
| B4 | Fixed | 新增 §4.7：缝 live 时跳过磁盘自愈与行为探针，给出探针误报机理与磁盘补丁退役条件 |
| B5 | Fixed | 新增 `seam.requireReader`（默认 true）：代读不可用则不装缝、保持硬拒绝；体检区加"代读可用性"行；R6 登记残留缝隙 |
| N1 | Fixed | §6 R2 按评审实测表重写（ACP 为真正额外消费者；compaction 不读模态；GUI catalog 安全） |
| N2 | Fixed | §3.3 增补"覆盖边界"段（`resolveCallConfig → resolveModelInfoFor`、远程面、只装饰 runtime 不碰 adapter） |
| N3 | Fixed | §7 E1 改为自动化单测；删除 §4.2 基于错误前提的 `internal/get` 兜底叙述 |
| N4 | Fixed | §7 补 E5b / E6 / E7 / E8 / E9 / E10 |
| N5 | Fixed | §8-3a：读取走 `ctx.get('llm')`，不扩严格 `inject` |
| N6 | Fixed | §4.6 改为四行（含"标记残留"与"代读可用性"） |
| N7 | Fixed | §8 补 `tests/TEST-MATRIX.md`、`CHANGELOG.md`、`package.json` 升版 |
| N8 | Fixed | §0 末句改为可验证条件句（挂 E5/E5b） |
| N9 | Fixed | §4.3 补 `include` 语法与 refuse-and-keep-old 校验、三键落地位置 |
| N10 | Fixed | `SEAM_MARK` 改用包名命名空间；`restore()` 一并清理 |
| N11 | Fixed | (a) 影子属性改用 `Object.defineProperty(..., enumerable:false)`（§4.2）；`restore()` 的 `delete` 语义不变。(b) `requireReader` 定为 `wrapped` 内的调用时谓词、自证路由写死用 `pickTextOnlyModel`、`apply()` 既有顺序不变（§4.5/§8-0） |
| N12 | Fixed | (a) 凭证判据改用既有先例 `credentialRef(name)` + `ctx.credentials.resolve()`（§4.5）。(b) `internal/config` 更正为 `lib/config.js`（§4.3） |
| Q5 未验证项 | Fixed | §1 补上宿主 `lib/main.js` immutable 注释的核实来源（lead 直接抽取） |
