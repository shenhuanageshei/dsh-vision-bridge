# 独立评审报告：design-v4-runtime-seam（运行时服务缝）

> 评审人：design-reviewer（独立复核，只读）。
> 评审对象：`docs/design-v4-runtime-seam.md`（设计稿 v4，未实现）。
> 证据源：本次评审从 `D:\DSH-Desktop\resources\app.asar` 直接抽取/实测的内核源码与运行时行为（DSH desktop 0.1.7-rc.2；`@deepseek-ai/dsh-llm` 0.1.7-rc.2；`@deepseek-ai/cordis` 4.0.4）。
> 证据纪律：**每个关键结论都给出「文件 + 函数名 + 片段」**；凡能实测的（cordis 服务可写性/装饰可还原性）都在本机用 asar 内的真实模块跑过，并给出实测输出。
> 本报告是唯一写入产物；未修改任何源码、未跑安装/构建/重启。

---

## 1. 结论

**不通过（FAIL）**。

**方案的地基是成立的**：F1–F5 五条关键假设经独立复核**全部为真**——闸门与投影确实是两条互不调用的路径，装饰 `llm.resolveModelInfo` 确实能让两个准入闸放行、而投影照旧把图换成占位符；而且「装饰是否可行」这个问题**本次评审已用 asar 里的真实 cordis 4.0.4 + 真实 LlmRuntime 实测给出答案：可行**。方案方向正确，值得推进。

**但设计的实现骨架（§4.2）有两个经实测确认的错误**，会直接击穿方案自己写下的两条硬承诺（「插件停用即恢复原样」「失败要响，绝不静默」）；另有三处设计缺口（live 配置、§12 关系、新增的「无人读图」静默路径）未处置。

因此：**方向通过，本稿实现细节不通过**；B1–B5 必改后可重新送审（改动量不大，B1/B2 是几行代码 + 一条断言）。

---

## 2. 逐条复核（F1–F5）

### F1 主会话准入闸 —— **成立（一致）**

**证据（`dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`，本次评审读的是抽取副本 `session-controller.index.js`，行号与该副本一致）**：

```js
// session-controller.index.js:850  SessionController.prompt(request)
async prompt(request) {
  ...
  const hasImage = request.content.some((part) => part.type === "image");   // :861
  const admit = async () => {                                              // :862
    try {
      if (hasImage) {                                                      // :870
        const current = this.agents.selectionFor(agent).current;           // :871
        const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model); // :872
        if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
          throw new RemoteError("session/attachment-invalid",
            `Model "${current.model}" does not support image input.`,
            { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });                  // :873
      }
      const admission = resolvePromptFileReceipts(request.content, (receiptId) => this.ctx.fileUploads.resolve(agent, receiptId));
      ...                                                                  
    }
  };
  return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit();  // :898
}
```

与文档 §3.1 引文一致（文档省略了 `hasImage` 外层判断与 `:898` 的序列化包装，属节选，非失真）。

**独立补充（文档未写、对本方案有增量）**：
1. 图片准入被 **`agents.serializeImageAdmission(agent, admit)` 串行化**（:898）——装饰是同步读写一个方法引用，不引入新的并发面；这一点反而说明「装饰」比「改内核条件」的并发风险更低。
2. 同一个包内还有**第二个 `resolveModelInfo` 消费者**：`session-controller.index.js:505-506` `const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);`（`requireModel` 路径）。同包内多消费者 ⇒ 装饰点选在服务方法上是正确的（一次生效），但也意味着**影响面不止文档列的两处闸门**（见 Q1/N1）。
3. 全 asar 原始字节扫描确认了**同一段代码在 asar 内有多份拷贝**（@16304511 的压缩版与 @16827976 的可读版），且都与本副本逐字一致 —— 说明该副本确实是桌面版实际加载的代码。（扫描方式见文末「证据方法」。）

### F2 子代理准入闸 —— **成立（一致）**

**证据（`dsh-subagent/lib/index.js`，抽取副本 `subagent.index.js`）**：

```js
// subagent.index.js:1977-1986
/** Refuse image content for a child whose fixed model accepts text only. */
async assertImageCapable(agent, signal) {
  const { provider, model } = agent.options;
  if (provider === void 0 || model === void 0) return;
  const llm = this.ctx.get("llm");
  /* v8 ignore next -- without an LLM registry, delivery defers to projection. */
  if (llm === void 0) return;
  const info = await llm.resolveModelInfo(provider, model, signal);
  if (info.inputModalities !== void 0 && !info.inputModalities.includes("image"))
    throw new SubagentError(`Model "${model}" does not support image input.`, "MODEL_DOES_NOT_SUPPORT_IMAGES");
}
```

调用点两处：`deliverFollowup` (`subagent.index.js:1830-1831`)、`submitMaterialized` (`:1952-1953`)。错误经 `rejectPrompt()` (`:74-78`) 映射为 `RemoteError("subagent/attachment-invalid", …, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" })`，与文档 §7 的 E4 观测点一致。

**与文档的差别（值得记进设计的证据表）**：F2 用的是 **`this.ctx.get("llm")`**（inject 豁免读），F1 用的是 `this.ctx.llm`（服务访问器）。两条读法在 cordis 里**最终都落到同一个 `Impl.value`**（证据见 F5），所以对装饰方案无影响 —— 但这一点必须有 F5 的证据兜住，否则「`ctx.get` 返回别的东西」就是致命疑问。本次已实测兜住（F5）。

### F3 图片投影 —— **成立（一致）**

**证据（`dsh-llm/lib/index.js`，抽取副本 `dsh-llm.index.js`）**：

```js
// dsh-llm.index.js:2284  LlmRuntime.adapterStream(options, prepared)
async *adapterStream(options, prepared) {
  ...
  const registration = prepared?.registration ?? this.registration(options.provider);
  const adapter = registration.adapter;
  let modelInfo;
  if (prepared === void 0) {
    const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal); // :2293
    modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);            // :2294
    ...
  } else {
    modelInfo = prepared.modelInfo;   // :2298  ← 来自 LlmRuntime.prepareCall，同样不经 resolveModelInfo
    ...
  }
  ...
  let projectedMessages = resolvedOptions.messages;
  if (projectedMessages.some((message) => contentHasFile(message.content)))
    projectedMessages = projectFilesToText(projectedMessages, (ref) => this.fileReadPath(ref));
  if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")
      && projectedMessages.some((message) => contentHasImage(message.content)))
    projectedMessages = projectImagesForTextModel(projectedMessages);                                // :2312
  ...
}
```

占位符文本与投影函数：

```js
// dsh-llm.index.js:559-561
function textOnlyImageText(ref) {
  return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
// dsh-llm.index.js:746-755
function projectImagesForTextModel(messages) {
  if (!messages.some((message) => contentHasImage(message.content))) return messages;
  return messages.map((message) => { const content = replaceImagesForTextModel(message.content);
    return content === message.content ? message : { ...message, content }; });
}
```

判定用的 `modelInfo` **只**来自 `adapter.prepareCall(...).model`（未 prepared）或 `prepared.modelInfo`（prepared，即 `LlmRuntime.prepareCall` 的产物）—— **两条路都不经过 `resolveModelInfo`**。F3 与文档一致，且比文档写得更强：**连 prepared 路径也确认了**（文档 §3.2 只写了未 prepared 那条）。

### F4 两条路径互不调用 —— **成立，但需要补一条「部分交叉」的注脚**

**证据**：

```js
// dsh-llm.index.js:2090-2105（查询型）
async resolveModelInfo(provider, model, signal) {
  return this.resolveModelInfoFor(this.registration(provider), model, signal);
}
async resolveModelInfoFor(registration, model, signal) {
  const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);  // ← adapter.resolveModel
  return this.normalizeModelInfo(registration, model, resolved);
}

// dsh-llm.index.js:2204-2207（请求型）
async prepareCall(config, signal) {
  const registration = this.registration(config.provider);
  const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);  // ← adapter.prepareCall
  const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
  ...
}
```

`resolveModelInfo` 走 `adapter.resolveModel`，`prepareCall` 走 `adapter.prepareCall`；前者不调用后者，后者不调用前者。**装饰 `LlmRuntime.resolveModelInfo` 不可能改变 `adapterStream` 的判定** —— 这就是方案的地基，**确认成立**。

**必须补的注脚（文档未写，不构成否决，但影响 R2/Q1 的完备性）**：

```js
// dsh-llm.index.js:2162-2168
async resolveCallConfig(config, signal) {
  return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
}
async resolveCallFor(registration, config, signal) {
  const info = await this.resolveModelInfoFor(registration, config.model, signal);   // ← 直连 resolveModelInfoFor
  return this.resolveCallWithInfo(config, info);
}
```

即：**存在第三条查询路径 `resolveCallConfig → resolveCallFor → resolveModelInfoFor`，它绕开被装饰的 `resolveModelInfo`**。今天它只返回 `.config`（不含模态），所以当前无消费者受影响；但设计必须把它记为「缝的覆盖边界 = 只覆盖调用服务方法 `resolveModelInfo` 的消费者」，否则 R4（未来内核改判定路径）的排查会漏掉这一类（详见 N2）。

**另一处需要点明的实现事实（增强 F4，而非削弱）**：适配器基类 `LlmAdapter.prepareCall` 其实会回调 `this.resolveModel`：

```js
// dsh-llm.index.js:1735-1740
async prepareCall(provider, model, signal) {
  return { model: await this.resolveModel(provider, model, signal),
           stream: (options) => this.stream(options) };
}
```

也就是说「同一份模型元数据」在 **adapter 层**是共享的（未覆写 `prepareCall` 的适配器：建议投影用的 modelInfo 与 `resolveModelInfo` 同源）。**但这不破坏方案**，因为缝装饰的是 **`LlmRuntime`（服务对象）的方法，不是 `adapter.resolveModel`**；`adapterStream` 取的是 `registration.adapter.prepareCall(...)`。设计若哪天改成去装饰 adapter，两条路就会一起被污染 —— 这一点值得在文档里写成「设计约束：只装饰 runtime 服务方法」。

### F5 装饰可行性（cordis 服务实例可写性）—— **成立，且「直接装饰有效」已被实测证实；但文档对它的推论错了**

三份证据。

**(a) 服务实例注册的是「实例本身」，不是每次新建的包装物。**
`dsh/node_modules/@deepseek-ai/cordis/src/service.ts` `Service` 构造器：

```ts
constructor(protected ctx: Context, name: string) {
  ...
  let self = this
  ...
  if (self[symbols.invoke]) { self = createCallable(...) }
  self.ctx = ctx
  self.name = name
  defineProperty(self, symbols.tracker, tracker)
  self.ctx.reflect.provide(name, self, this[symbols.check])   // ← 注册的就是 self
  return self
}
```
`dsh-llm.index.js:1801-1803`：`constructor(ctx) { super(ctx, "llm"); }` —— `LlmRuntime` 没有 `[Service.invoke]`，所以 `self === this`，注册进 reflect store 的就是这个实例。

**(b) `ctx.llm` / `ctx.get('llm')` 返回的是「每次新建的 traceable 代理」，但代理读写的都是同一个实例；实例本身可写。**
`dsh/node_modules/@deepseek-ai/cordis/src/utils.ts`：

```ts
export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) return Object.getPrototypeOf(value)
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)          // ← 每次调用 new Proxy(...)
}
function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      ...
      const desc = getPropertyDescriptor(target, prop)   // 原型链查找
      if (desc && 'value' in desc) innerValue = desc.value
      else { shadow = createShadow(ctx, target, tracker.property, receiver); innerValue = Reflect.get(target, prop, shadow) }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) return createTraceable(ctx, innerValue, innerTracker)
      else if (!tracker.noShadow && typeof innerValue === 'function') {
        shadow ??= createShadow(ctx, target, tracker.property, receiver)
        return createShadowMethod(ctx, innerValue, receiver, shadow)   // ← 每次读方法也新建一个 Proxy
      } else return innerValue
    },
    set: (target, prop, value, receiver) => {
      if (prop === symbols.original) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value, receiver)
      ...
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)      // ← 最终 CreateDataProperty 落到真实实例
    },
    ...
  })
  return proxy
}
```

**本次评审实测**（`run_code` 里直接 `import` asar 内的真实模块，只用 `new Context()`，不启动 DSH、不写文件；脚本与输出见文末「证据方法」）：

```text
# 真实 LlmRuntime（来自 asar 的 @deepseek-ai/dsh-llm）
proto chain: LlmRuntime -> TypertRemoteService -> Service
own props:   ctx,name,typertRemote,adapters,directory,discoveries
resolveModelInfo desc: { writable: true, enumerable: false, configurable: true, isFn: 'function' }
frozen: false  extensible: true  sealed: false
ctx.llm identity stable: false      # 每次读都是新代理
a[symbols.original] === inst: true  # 代理背后就是那一个真实实例
method identity stable:  false      # 每次读方法也是新代理 ← ★ 关键
```

结论：**没有冻结、没有不可写、没有代理导致赋值无效**。文档 §4.2 写的「`llm.resolveModelInfo = wrapped`」是**有效的**（实测：安装后 `ctx.llm.resolveModelInfo(...)` 返回 `inputModalities: ["text","image"]`，且自有属性落在真实实例上 `Object.hasOwn(inst,'resolveModelInfo') === true`）。

**(c) 跨上下文全局生效。**
`dsh/node_modules/@deepseek-ai/cordis/src/reflect.ts` `ReflectService.handler.get`：

```ts
get: (target, prop, ctx: Context) => {
  if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx)
  if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx))
  const error = new Error(`cannot get property "${prop}" without inject`)
  try {
    const def = target.reflect.props[prop]
    if (def?.type === 'accessor') return def.get.call(ctx, ctx[symbols.receiver], error)
    if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)
    return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
      ... const impl = fiber.store?.[prop]; if (impl) return getTraceable(ctx, impl.value) ...
    })
  } ...
}
```
`reflect.ts` `provide()`：`const impl: Impl = { name, value, fiber: this.ctx.fiber, check }; this.store[key] = impl; this.ctx.fiber.store![name] = impl;`
`reflect.ts` `get(): return getTraceable(this.ctx, this._getImpl(name, strict)?.value)`

⇒ 任何上下文读 `llm` 都返回**同一个 `impl.value`**（只是外面套了不同的代理）。实测：`root.extend()` 出的子上下文里 `[symbols.original] === root` 的那个实例（`true`）。

**并且**：本插件的既有代码已经在同容器内直连核心服务（`lib/index.js:271-290`：`ctx.get('sessionController').prompt(...)`），说明 session controller 与插件**同进程同 cordis 容器** ⇒ F1/F2 两处闸门读到的就是被装饰的那一个实例。**跨进程/远程边界不是本方案的风险**（另见 N2 的远程面边界）。

**文档 §4.2 的推论错了（这是 B1/B2 的根因）**：文档假设「`ctx.get('llm')` 拿到的是每次新建的代理对象（导致直接赋值无效）」。**前半句为真，后半句为假** —— 赋值有效，但**「读回来的东西」每次都是新代理**，这会让文档自己写的两句守卫语义失效。

---

## 3. 必改项（blocking）

> 每条都给「实测输出 + 应当怎么改」，且 B1/B2 的修法本次已实测验证过。

### B1（🔴）§4.2 的还原守卫 `if (llm.resolveModelInfo === wrapped)` 恒为 false ⇒ `restore()` 是空操作，插件停用不还原

**为什么**：F5(b) 已证实「读方法」每次返回新的 `createShadowMethod` 代理，所以 `llm.resolveModelInfo === wrapped` 永远不成立。

**实测（本次，代码逐字取自文档 §4.2 骨架）**：

```text
install status: installed
A.  read-back through NEW proxy === wrapped: false
A2. captured proxy's own read === wrapped:       false      ← ★ 守卫永不命中
B.  landed on raw instance: true | inst own prop: true
C.  idempotence via SEAM_MARK on fresh proxy: already
D.  seam behavior: {"provider":"zai-coding-cn","id":"glm-5.3","name":"glm-5.3","inputModalities":["text","image"]}
E.  after restore, modalities: ["text","image"]              ← ★ 还原无效
F.  seam still installed? true
```

**影响**：文档 §4.2「dispose 时只在本插件仍是最外层时还原」、§4.4「fiber dispose 时还原」、§7 的 **E5「卸载还原…证明还原有效」**、§1 目标 2「插件停用即恢复原样」、§6 R5 的缓解措施 —— **全部落空**。装饰会永久留在进程里，且因为 B2 的缘故连「重装」都做不了。

**修法（本次已实测通过）**：守卫与还原都对**真实实例**做，用 `delete` 暴露原型方法：

```js
const raw = llm[symbols.original] ?? llm;          // cordis Symbol.for('cordis.original')
const original = raw.resolveModelInfo;
const restore = () => { if (raw.resolveModelInfo === wrapped) delete raw.resolveModelInfo; };
raw.resolveModelInfo = wrapped;
```

实测输出（同一脚本换成修法版）：

```text
status: installed
installed -> ["text","image"]
guard hits (raw own prop === wrapped): true
restored  -> ["text"]            ← 还原生效
own prop gone: true
```

### B2（🔴）`restore()` 不清 `SEAM_MARK` ⇒ restore 之后再 install 报 `already`，缝**永久静默失效**

**实测**（直接接着 B1 的脚本）：

```text
idempotent status after restore (reinstall): already      ← ★ 标记还在，但缝已经没了
```

**为什么是 blocking 而不是理论风险**：本插件的 fiber 会重入，而且 `apply()` 是被反复调用的入口（`lib/index.js:11-15` 头注原文：「The plugin fiber can restart at any time — all state is (re)built inside apply, nothing module-level」；`lib/index.js:512` 的 `settings.watch` 就是常态路径）。一次 fiber 重启 = 先 `restore()`（B1 之下还没生效，即便修好 B1 也会留下标记）→ 再 `installSeam()` → 返回 `already` → **缝不再安装**，而 §4.5 把 `already` 定义为「说明已装，直接复用」⇒ 体检区很可能显示 ✓（或至少中性），用户贴图却再次被拒。这正是文档 §4.5 与 §1 目标 4 反复谴责的「静默装作成功」。

**修法**：`restore()` 同时 `delete raw[SEAM_MARK]`；且 `already` 必须**行为自证**（真实实例上确实存在自有属性 `resolveModelInfo === 我们那一层`），不能只凭标记存在就宣称已装。

### B3（🔴）`seam.mode` / `seam.include` 写进了 live 设置面，但设计从未把缝的生命周期接进 live 更新路径

**证据（仓库内）**：
- `lib/config.js:44-91`：每个「卡片可改」的字段都用 `vol()` 标记（`const vol = (schema) => schema?.volatile ? schema.volatile() : schema`），即**声明为 live**；`lib/index.js:355-357` 以 `applies: 'live'` 注册；
- `lib/index.js:512-542`：`settings.watch` 在 **不重启 fiber** 的情况下把新配置应用到运行态（`state.config = resolvedNext`、重建 cache/gate/bridge）。

文档 §4.3 新增 `seam.mode: auto|off`（「`off` = 完全不动运行时」）与 `seam.include`（白名单收窄），§4.4/§8 只写了「`apply()` 最先安装 + dispose 还原」。**后果**：用户把 `seam.mode` 改成 `off`，当前进程里缝**仍然装着**（且按 §4.6 卡片可能照旧显示 ✓），要么重启才生效、要么永远不生效——两者都没有在文档里声明。这与 §4.5 的「不许静默」直接冲突。

**修法（二选一，必须在文档里定死）**：(a) 在 `settings.watch` 里驱动缝的 install / uninstall / 重装（`include` 变化即重装）；或 (b) 明确声明这两个键**不 live**（不给 `vol()`）、卡片上标注「需重启」，并把该语义写进 §4.3/§4.6/§7。

### B4（🔴）与 `docs/design.md` §12（启动自愈 + 行为探针）的关系未处置，且探针一旦遇上缝就会给出**错误结论**

**证据（仓库内 `lib/index.js`）**：

```js
// :328-338  apply() 最前，无条件执行（桌面版也跑）
try { await selfHealAdmissionGate({ logger }); } catch (error) { ... }

// :250-259  探针只挑「声明为纯文本」的模型
export function pickTextOnlyModel(providers) {
  ... if (model?.vision === false && typeof model.id === 'string' && model.id !== '') return { provider: provider.id, model: model.id };
}

// :271-290  探针经同容器服务真发一次带图 prompt
export function buildAdmissionProbeDeps(ctx, settingsGet) {
  if (!admissionProbeEnabled()) return {};
  const controller = () => { try { return ctx.get('sessionController'); } catch { return undefined; } };
  return { promptRemote: async ({ sessionId, content }) => { ... return service.prompt({ sessionId, content, requestId: '...' }, AbortSignal.timeout(10000)); }, ... };
}
```

§12.2 B 的判定是「拒绝码 `MODEL_DOES_NOT_SUPPORT_IMAGES` ⇒ 闸活着（gate-live）；入账 ⇒ 闸死了（gate-dead）」。**缝装上以后，被探针选中的那个「纯文本模型」的 `resolveModelInfo` 也会报告 `image` ⇒ 闸不再拒绝 ⇒ 探针必然读到 `dead`**，与磁盘补丁是否真的存在无关。于是：
1. 探针从「磁盘补丁的运行期真相」退化成「缝是否装着的镜像」，体检区那条准入行会**把「缝在跑」误报成「闸已失效/补丁已就位」**——正是 design.md §12.4-5 立誓根除的「UI 回显≠服务端真相」；
2. `selfHealAdmissionGate()` 在桌面版仍无条件执行（虽然够不到 asar，会走 not-found 静默），在便携版/混合部署下则可能**同时**存在「磁盘闸被惰性化」+「运行时缝」两条通路 —— 二者叠加的双重放行没有在设计里被评估。

文档 §8.6 只写「§12 自愈降级为遗留兼容」，**没有说探针怎么办、磁盘补丁在缝可用时是否还该写**。必须在本设计中给出处置（建议：缝 live 时不再写磁盘补丁 / 探针判定改为「缝状态 + 磁盘状态」两维并在 UI 上分开表达，或按 §4.6 的措辞彻底移除该行但显式声明 `selfHealAdmissionGate` 的退役条件）。

### B5（🔴）新增了一条「无人读图」的静默路径，而设计的目标 4 恰恰禁止静默

**逻辑链（都能在仓库内证到）**：
- 缝的生效范围是 §4.3 的「`include = []` ⇒ 对所有声明纯文本的模型生效」——**它不检查本插件的代读能力是否可用**（provider/credential 未配置、VLM 调用失败等）；
- auto 模式失败是**吞掉只记日志**（design.md §5.4：「超时/失败吞掉只记日志,绝不阻塞回合」）；
- 缝生效前的行为是**硬拒绝**（`MODEL_DOES_NOT_SUPPORT_IMAGES`，用户立刻知道这条消息没进去）；
- 缝生效后的行为是**发送成功**，模型看到 `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`（`dsh-llm.index.js:559-561`）。

⇒ 在「缝已装但代读不可用」的部署里，用户的截图变成**没有任何人看过的占位符**，而 UI 是一条成功消息。文档 §4.5 的自证只证明「模态注进去了」，§4.6 的卡片三态也只描述缝自身的状态 —— **没有任何一处覆盖这个新失败面**。这与 §1 目标 4（「失败要响…绝不静默装作成功」）与 §4.5 的立誓直接矛盾。

**最低要求**：把「代读可用性」变成缝的前置条件（不可用则不装/不生效），或在体检区与消息侧给出**显式**提示；并把它登记进 §6 风险表。

---

## 4. 建议项（non-blocking）

### N1（🟡）§6 R2 的事实依据是错的：compaction 不读模态；真正的额外消费者是 ACP

文档 R2 写「其他『查询型』消费者（如 **compaction-image-offload**）按模型能力决策…」。全 asar 扫描（`inputModalities` 关键字，见文末方法）得到的真实消费者是：

| 消费者 | 证据 | 缝装上后的行为 |
|---|---|---|
| session prompt 闸 | `session-controller.index.js:872-873` | 放行（本方案目的） |
| subagent `assertImageCapable` | `subagent.index.js:1978-1985` | 放行（本方案目的） |
| **ACP `assertImageRoute` / `supportsAcpImagePrompts`** | asar @14310465 / @14311681：`if (info.inputModalities === void 0 \|\| !info.inputModalities.includes("image")) throw new AcpContentError(...)`；注释原文 `/** Determine whether initialization may truthfully advertise inline image prompts. */` | **把纯文本模型「如实地广告」成收图模型** —— 文档完全没提 |
| `buildModelCatalog`（浏览器模型目录） | asar @16289331 | **不复制 `inputModalities`**（只投影 `reasoning`）⇒ GUI 选择器不被误导，这条**是安全的**，值得写进文档以缩小 R2 |
| compaction `compactIfNeeded` | asar @46555166：只用 `info.context` / `info.defaultMaxTokens` | **不读模态**，R2 的举例不成立 |
| deepseek / pi-ai 适配器内部 | asar @50082748 / @50134275 / @50306325 | 读的是**适配器自己的 catalog**，不经缝，不受影响 |

建议：按上表重写 R2，并把「ACP 广告语义」升级成一个**显式的验收决策**（我们是接受它，还是要按 provider 收窄 `seam.include` 以避开 ACP 面）。另建议核对一句：ACP 的 `assertImageRoute` 用的是 `info.inputModalities === void 0 || !includes`（未声明即拒），比两个核心闸更严 —— 缝只在「已声明为纯文本」时注入，对「未声明」的模型不会替 ACP 放行，这一点文档的 §4.2 分支恰好是对的，值得写进证据。

### N2（🟡）把「缝的覆盖边界」写进设计，而不是留给未来踩坑

`resolveModelInfo` 不是唯一查询入口：`resolveCallConfig → resolveCallFor → resolveModelInfoFor`（`dsh-llm.index.js:2162-2168`）直连解析器、绕开装饰；远程面（`dsh-llm/lib/typert.remote-client.js` 等）也只有 `listProviders / listConfigurableProviders / remoteDiscoverModels` 是 `@Remote` 装饰的，`resolveModelInfo` **不在远程面**（这也是本方案能生效的前提：闸门是**同进程**服务调用）。建议在 §3.3 明写：「缝只覆盖通过服务方法 `resolveModelInfo` 取模态的**同进程**消费者；直连 `resolveModelInfoFor` 的内部路径与远程面不受影响（今天无消费者受影响）」。这条同时是 R4 的正确排查面。

### N3（🟡）E1 已经不需要「临时插件打印」了 —— 改成自动化单测，并按实测结论直接定案

E1 的三个问题本次已有确定答案：`llm` 实例**不冻结**、`resolveModelInfo` 是**原型方法**（`writable/configurable`）、赋值后**新代理能读到包装后的函数**（但 `=== wrapped` 不成立）。建议把 E1 落成 `tests/seam.test.mjs` 的第一组断言（装 → 断言行为 → 断言 B1 那个守卫命中 → 还原 → 断言基线 → 再装），而不是一次性的探针脚本；探针结论也应回写 §4.2，删掉那段基于错误前提的「兜底」叙述（`internal/get` 那条路在直连可用的情况下不必启用；顺带一提，它的 `seen` 去重按 F5(b) 永远命不中，只能靠 `SEAM_MARK` 兜——而那正是 B2 的坑）。

### N4（🟡）补齐验证矩阵

现有 E1–E5 缺以下回归（每条都能挂到已确认的风险上）：
- **E5b 停用→再启用**：抓 B2（`already` 假阳性）；
- **E6 live 生效**：`seam.mode=off` / `include` 收窄后**不重启**的即时效果（抓 B3）；
- **E7 `include` 收窄的反向断言**：被排除的路由必须**仍然**被拒（证明白名单不是装饰性配置）；
- **E8 「未声明模态」不变式**：`inputModalities === undefined` 的适配器在装缝前后返回值**逐字段相同**（文档 §4.2 承诺「未声明 = 不拦；保持原样」）；
- **E9 多面不回归**：装缝后浏览器模型目录（`buildModelCatalog`）与 ACP 面各跑一次冒烟（对应 N1）；
- **E10 跨代际**：E2–E5 在便携版（0.1.6/0.1.7-web，磁盘补丁在）与桌面版（0.1.7-rc.2，asar）各跑一遍 —— 这是 §1 目标 3 的验收本身。

### N5（🟡）接线方式建议：用 `ctx.get('llm')`，别急着扩 strict `inject`

文档 §8.3 说「`inject` 增补 `llm`」。但本插件顶层 `inject` 是**严格声明**（`lib/index.js:41`），house rule 明确警惕严格 inject 的「静默 pending」（design.md 附录 A④-3：「名字打错/服务永不提供=插件无声不加载…`ctx.get()` 免注入读」），而本插件对可选/后置服务确实一律走 `ctx.get`（`:275` `ctx.get('sessionController')`、`:549` `ctx.inject(['webServer'], …)`）。建议缝的读取走 `ctx.get('llm')`（`undefined` 即 §4.5 的 `unsupported` 态），需要时再用 `ctx.inject(['llm'], cb)` 局部注入。

### N6（🔵）§4.6 卡片态需要给「已装但未自证」与「标记在但缝不在」各一行

按 B1/B2 的教训：卡片判据必须是**行为自证**（`seam.live`）而不是标记；`already` 单列一态时要能区分「真的装着」与「标记残留」。B5 的前置条件也应有一行（例如「缝已生效，但视觉代读未配置」）。

### N7（🔵）§8 的文件清单漏了本仓的交付纪律件

`design.md` §12.3 的 house pattern 是「改哪些文件 + 测试矩阵 + VERIFY + CHANGELOG」。§8 只列了 `lib/seam.js`、接线、卡片、`design.md`/`README`/`VERIFY.md`。建议补：`tests/seam.test.mjs`（新）、`tests/TEST-MATRIX.md`（映射行）、`package.json` version `0.1.1 → 0.2.0`（现 `package.json:3` 为 `"version": "0.1.1"`）、`CHANGELOG.md`。

### N8（🔵）把 §0 的那句硬承诺改成「可验证的条件句」

§0 原文：「不改文件、不碰 app.asar、不碰 node_modules，**插件停用即恢复原样**」。前三句本次证据支持（缝只在内存里改一个自有属性），第四句在 B1/B2 修好并落入 E5/E5b 之前**不应作为承诺出现**。建议写成「停用即恢复（由 E5/E5b 断言，还原经真实实例的自有属性删除实现）」。

### N9（🔵）§4.3 的配置面少了落地细节

`vision-bridge:` 的键要真正可用，需要落在 `lib/config.js` 的 schemastery（`vol()` 决定是否 live，见 B3）、`resolveConfig` 的解析/校验（非法 `include` 项应走 refuse-and-keep-old）、以及 `lib/client.js` 的草稿渲染 + i18n（卡片是从 `Config` 自动渲染的）。另外 `include` 的语法（`provider:model`、空数组 = 全部、非法项如何报错）需要定义。

### N10（🔵）`Symbol.for('dsh-vision-bridge.seam')` 的落点与清理

B1 的修法之后，这个 symbol 属性会落在**真实实例**上（实测：`inst` 自有属性）。两点：命名建议加包名（`@dsh-external/dsh-vision-bridge/seam`）以免与其他插件撞；`restore()` 必须把它一并删除（B2）。

---

## 5. 对评审问题的回答（Q1–Q5）

### Q1 风险表（§6 R1–R5）是否完备？—— **不完备**

- **R2 的事实基础是错的**（N1）：compaction 不读模态；真正没被列出的消费者是 ACP（`assertImageRoute` / `supportsAcpImagePrompts`，后者注释原文就是「truthfully advertise」）。GUI 模型目录这条经查是安全的，但文档没写，读者无法区分。
- **漏：live 配置语义**（B3）——「声明了 `off` 却关不掉」是静默失败，不是小瑕疵。
- **漏：`SEAM_MARK` 残留造成的 `already` 假阳性**（B2）——恰好由本插件自身的 fiber 重入常态触发。
- **漏：与 §12 磁盘补丁/探针的互相干扰**（B4）——探针会给出错误结论。
- **漏：新增的「成功发送但无人读图」路径**（B5）。
- **漏：缝的覆盖边界**（N2：`resolveCallConfig → resolveModelInfoFor` 绕过；远程面不含该方法）。
- **并发**：本次复核**未发现新增并发风险**——闸门侧图片准入被 `serializeImageAdmission` 串行化（F1），缝的装/卸是同步的属性读写，`wrapped` 是纯异步函数无共享可变状态；建议在文档里把这条「为什么并发不是风险」写出来，而不是留白。
- **多插件冲突（R5）**：方向对，但「还原前检查我是否仍是最外层」在 F5 的代理语义下**当前写法恒为 false**（B1）；修法见 B1，且应补一条「两个插件先后装饰 → 先还原者不得破环后装者」的显式断言。

### Q2 验证计划（§7 E1–E5）是否可执行、漏了什么？—— **可执行，但漏了关键回归且其中一条已被本次评审提前完成**

可执行性：E1–E5 的观测点都能在仓库既有设施里落地（`vision_bridge_read`、会话日志、体检区、`session/prompt`）。缺项见 N4（E5b/E6–E10）。另有两条表述需要修正：E1 的前提假设已被证伪（见 Q3/N3）；E3 只验证「多模态模型不被替换」，还应加「装缝前后多模态模型行为逐字段不变」的等价断言。

### Q3 是否同意「先做 E1 探针再写实现」？—— **同意顺序，不同意形态**

同意「先把缝的可行性钉死再写实现」。但**E1 已经被本次评审做完**（静态证据：`cordis/src/utils.ts getTraceable/createTraceable`；实测证据：真实 `LlmRuntime` + cordis 4.0.4 的六项读数）。所以：(1) 不要再花时间搭临时打印插件，把 E1 直接写成 `tests/seam.test.mjs` 的第一组用例（N3）；(2) E1 必须**扩充**——原 E1 问的三问都答「可行」，但真正的杀手问题是它没问的：**「装完以后，那个还原守卫读得到自己装的那一层吗？」**（答案：读不到 ⇒ B1）。把「装 → 断言守卫命中 → 还原 → 断言语义回到基线 → 再装」做成断言，等价于把 B1/B2 变成回归测试。

### Q4 实施步骤（§8）的顺序与切分是否合理？—— **顺序合理，两处切分要调**

顺序（E1 → seam.js → 接线 → 卡片 → E2–E5 → 文档 → 版本）是对的。要调两处：
1. **把 B4/B5 的决策前移到步骤 1 之前**：`seam` 何时生效（与 §12 关系）、代读不可用时怎么办 —— 这两条会改变 seam.js 的接口（是否需要前置条件参数），先定再写，否则会返工；
2. **步骤 3 拆成 3a/3b**：3a = 只装缝（无配置面，固定 auto），3b = 配置键 + live 接线（B3）。这样 3a 就能单独跑 E1/E2/E5，回滚面小。步骤 4（卡片改版）建议独立一次提交，便于二分定位。
另外步骤 6 的文件清单按 N7 补齐。

### Q5 与 `docs/design.md` §5.4 / §12 的关系处理是否得当？—— **§5.4 得当，§12 不得当**

- §5.4（旧内核补丁策略）在本稿里被替换、并明确了脚本够不到 asar 的原因，本次复核**证实其事实基础**：`scripts/patch-admission-gate.mjs:27-33` 的 `DEFAULT_NM = <DSH_HOME>/profiles/web/node_modules`（回退 `D:/DSH-Portable/profile/profiles/web/node_modules`），目标两文件为 `@deepseek-ai/dsh-api-session-controller/lib/index.js` 与 `lib/types/commands.js`；`lib/index.js:83 resolveNodeModulesDir` 的兜底同源。→ 与文档 §1 的描述一致。
- §12（启动自愈 + 行为探针）被一句「降级为遗留兼容」带过，**但没有处置 §12 的核心资产**：`selfHealAdmissionGate()` 仍无条件跑（`lib/index.js:335`），`probeAdmissionGate` 的判定在缝装上以后会**必读 dead**（B4）。这不是「兼容」，是「两个机制同时作用于同一个判定点、其中一个给出错误读数」。必须在 §8.6 里把「磁盘补丁 + 探针」的退场条件、以及缝 live 时的替代判据写清楚。
- 一处**未验证项**如实记录：文档 §2 引述宿主注释「immutable Desktop resource tree」（`lib/main.js: resolveDesktopPaths / readDesktopRuntime`）本次**未核实**（未抽取该文件）。它不改变本方案的结论（改内核这条路在 asar 场景下本就够不到），但既然写进了设计，建议补证据或标注来源。

---

## 证据方法（可复现）

1. **内核源码**：三份预抽取副本（`session-controller.index.js` / `subagent.index.js` / `dsh-llm.index.js`）为 UTF-16LE 文本，已核对与 asar 原始条目**首尾逐字一致**（差异仅为 CRLF），行号可直接引用。其余内核/依赖源码用 `node C:\Users\magic\AppData\Local\Temp\dsh-asar-extract.mjs <asar> "dsh/node_modules/@deepseek-ai/<pkg>/<path>" <maxBytes>` 抽取。
2. **全 asar 消费者扫描**：`node -e` 直读 `D:/DSH-Desktop/resources/app.asar`（117,445,671 字节），`Buffer.indexOf` 扫 `resolveModelInfo` / `inputModalities`，打印 ±260 字节窗口并去重 —— 本报告 N1 的表即由该扫描得出（附字节偏移）。
3. **运行时行为实测**：在 `run_code`（Electron node，具备 asar 读取能力）里用 `file:///D:/DSH-Desktop/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js` 动态 import 真实 cordis 4.0.4，以及 `.../dsh-llm/lib/index.js` 的真实 `LlmRuntime`，`new Context()` + `new LlmRuntime(ctx)` 后复现文档 §4.2 骨架，读 `Object.isFrozen/isExtensible`、原型链、属性描述符、代理同一性，并验证修法（`[symbols.original]` + `delete`）。**未启动 DSH、未写任何文件、未跑安装/构建/重启**，不改变宿主状态。
4. **未能验证项**（如实声明）：宿主 `lib/main.js` 的「immutable Desktop resource tree」注释；`internal/get` waterfall 对**其它上下文**读取的实际投递行为（本次简易探针在子上下文注册监听器观测到 0 次触发，因取样方式可能不成立，**不作结论**）——该项在直连装饰已被证实可用的前提下不影响方案。
5. **仓库侧**：`docs/design.md`（§5.4 / 附录 A / §12 全文）、`docs/design-v4-runtime-seam.md`、`scripts/patch-admission-gate.mjs`、`lib/index.js`、`lib/config.js`、`package.json`、`cordis.patch.yml`。

VERDICT: FAIL
