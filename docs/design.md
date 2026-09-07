> 本文件为设计文档**唯一权威**(原 2026-09-04 快照,含 2026-09-05/2026-09-07 勘误与 §10 增订;原内部权威 spec 自 2026-09-07 起冻结为历史存档,后续修订只进本文件)。路径已脱敏为相对/占位形式。

# dsh-vision-bridge 设计:会话截图按模型能力自动分流

- 日期:2026-09-04
- 状态:已评审(双独立对抗评审),设计经用户确认
- 评审来源:架构评审(拦截面/时序/inject)+ 库集成评审(vision-bridge 包装/缓存/适配器),全文见附录 A/B;多模型会诊通道故障,由两个独立上下文评审子代理替代
- 修订记录:2026-09-04 设计评审 R1(7 项发现:3🔴4🟡)全按建议处置修订;详见各节内嵌〔评审#n〕标注
- 修订记录:2026-09-05 启动事故勘误——inject 服务名 systemPrompt(驼峰)、profile 禁手动同名 loader 行、file: 依赖改动后必须 pnpm install(已内嵌 §5.2/§5.8)
- 目标仓库:插件 plugins/dsh-vision-bridge;引擎库 vendor 自 github.com/shenhuanageshei/vision-bridge(vendor 上游,公开仓)

## 1. 目标与非目标

**目标**:任意 DSH 会话都能发截图。模型声明含 image 模态 → 截图原样内联直发;纯文本模型 → 会话截图转交视觉引擎(VLM)代读。触发方式可配置:tool(模型自主调用)/ auto(自动预描述注入)/ both(默认)。

**非目标**:不改任何 node_modules 核心包;不改附件持久化格式;不复制 vision-toolkit 的视觉工程工具链;不做 modlens 的任意路径全文 OCR 替代;客户端 UI 不改。

## 2. 运行时事实(全部经评审实证,行号为本机 node_modules 实测)

1. **投影是派发时瞬态副本**:`dsh-llm/lib/index.js:1684-1690` 仅当 `modelInfo.inputModalities !== undefined` 且不含 image 时,对请求副本调 `projectImagesForTextModel`(`lib/types/content.js:158-165`);durable 事件的 `ImageBlock.attachment` 保留完整 ref ⇒ "模型引用前缀 → 工具回扫事件取全量 ref"成立。
2. **双占位符形态**:`textOnlyImageText`(`content.js:47-50`)`[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`(仅 attachmentId 第 8-16 位 8 个 hex);`offloadedImageText`(`content.js:73-79`)"image omitted to fit request image limits"(含全 attachmentId 与可选只读路径)。解析器必须兼容两种。
3. **改写型拦截面全部不可行**:adapter 包装同路由抛 `DUPLICATE_ADAPTER`(`dsh-llm/lib/index.js:1272`);`llm/stream` 中间件 `next()` 无参、请求 frozen(`cordis/lib/index.js:317-325`、`dsh-agent-loop/lib/invariant.js:17`),且 agent-loop 重建不变量要求派发消息与 `deriveMessages()` JSON 全等(`invariant.js:26-28`);session-controller 是外部 API 面非变换缝。
4. **会话事件访问**:`session.snapshotEvents()` 全量原始日志(append-only、deep-frozen);`session.events` 在 dsh-session 0.1.2-rc.1 已不存在(vision-toolkit `lib/exposure.js:42` 的 `session.events ?? []` 为死代码实证)。compaction 是 shadow 协议不改写原始日志(`dsh-compaction/lib/types/types.d.ts:27-30`),压缩后事件仍可解析;fork 子会话复制父事件,须全量扫而非 `ownEvents()`;resume/constructor 种子不发事件,须 `agent/created` 回填。
5. **注入缝**:`agent/pre-step` waterfall 是官方消息替换缝(`dsh-agent/lib/types/runtime-types.d.ts:229-245`,`PreStepDecision={kind:'enter',messages}`,消费点 `dsh-agent-loop/lib/index.js:506-513`);`PromptContext`(`dsh-system-prompt/lib/types/index.d.ts:69-77`)每次 assembly 求值;`system-prompt/assemble` waterfall 不可加 section(section 在 waterfall 后恢复)。
6. **取图**:`attachments.readImage(ref)` 返回校验字节,`readImageRequest(ref)` 返回按预算缩放的请求版字节(`dsh-attachment/lib/types/index.d.ts:58/73`);`imageHostPath` 对非宿主文件后端可 undefined(`index.d.ts:62-65`)。
7. **contentHasImage 递归 tool-result**(`content.js:88-91`):工具返回的截图也产生占位符,扫描须含 `tool/result` 事件。
8. **工具执行上下文**:`defineTool({execute:(args,exec)})`,`exec.agent` 可取当前 Agent;事件监听 `ctx.on('agent/created'|'session/event'|'tools/result', …)` 可用。
9. **cordis 严格注入**:未声明服务运行时抛 `cannot get property "x" without inject`;inject 名单错误=插件静默永不加载;`ctx.get()` 免注入读;settings `applies:'live'` 等拓扑变化会重启插件 fiber,缓存须可重建。
10. **凭证**:DSH CredentialRef(环境变量风格名),经 `ctx.credentials.resolve` 解析,默认名可共享(如 `VISION_API_KEY`)。
11. **挂载**:纯 cordis 包走 profile `cordis.patch.yml` insert 行(`- insert: [{id, name, config?}]`,配置 HMR 实时生效);用户覆盖行必须同 id。

## 3. 前提(零开发,先决)

`profile/settings.yaml` → `llm-pi-ai.providers.zai-coding-cn.models`:给真正多模态的模型声明

```yaml
input:
  - text
  - image
```

声明后运行时投影不再命中,截图原样内联(pi-ai 自带像素/字节预算)。未声明的模型继续走占位符+代读路径。

## 4. 架构总览

```
用户粘贴截图 → attachment 服务持久化(durable ImageBlock 含全量 ref)
  ├─ 模型声明 image → 运行时原样内联(原生直读)
  └─ 文本-only → 运行时投影为占位符(模型视角)
        ├─ tool 模式:模型调 vision_bridge_read(ref=8hex 前缀)
        │     → snapshotEvents() 全量扫(user/message + tool/result)
        │     → 前缀匹配全量 ref(多命中返回候选)
        │     → attachments.readImageRequest() 字节直读
        │     → VisionBridge.analyze(question) → 结构化描述
        └─ auto 模式:session/event(user/message 含图,新到)
              → 异步 analyze(当前消息文本,超时放行)
              → 缓存(attachmentId+questionHash)
              → agent/pre-step waterfall 追加 <vision-context>(同轮可见)
```

## 5. 详细设计

### 5.1 库工程化(M1,先决)

vision-bridge 库现状缺 package.json/tsconfig 且 .js specifiers 无 dist,不可被加载。补齐:

- `package.json`:`{name:"@ti-agent/vision-bridge", private:true, type:"module", engines:{node:"^22.19.0 || >=24.0.0"}, main/exports 指 dist, files:["dist"], scripts:{build:"tsc", test:"node --test"}}`;devDeps:typescript、@types/node(**不引入 vitest**〔评审#2:METHODOLOGY 要求零依赖 node --test;库自带 8 个 vitest 测试文件由 eng_coder 移植为 node:test〕)。src 仅依赖 node 内置模块(zod/express/MCP SDK 为 proxy 实验残留,不声明);测试框架统一 node:test,插件与验收测试同为 node:test。
- tsconfig 出 `dist/`;库源码 .js specifiers 保持不动。
- 以 **vendor** 方式复制进插件仓库(`vendor/vision-bridge`,记录来源 commit/日期);本地 file: 仅作开发桥,换机即断。

### 5.2 插件包结构与挂载(M2)

- 位置 `plugins/dsh-vision-bridge`,**该目录自身即独立 git 仓库根**(对齐 `plugins/dsh-preset-zombie-guard` 先例),单独推送 GitHub;不在 DSH-Portable 根做 git init。npm 包(type:module,main 指 lib/index.js);profile package.json 以 `file:../../../plugins/dsh-vision-bridge` 引入——**加入依赖后必须执行 profile `pnpm install`**(file: 依赖是复制不是链接:装包靠它;此后改插件源码也要重跑 install 或手动同步 `profile/profiles/web/node_modules/@dsh-external/` 副本,否则不生效)。挂载由插件自带 `cordis.patch.yml`(dsh.bundle.patch 组合层)自动完成,**profile `cordis.patch.yml` 禁止再写同名 insert 行**——两处同 id 会以 `duplicate loader entry id` 崩掉启动〔2026-09-05 勘误:此前"同 id 行合并为单实例"的判断有误,实际是重复崩溃;覆盖配置走 settings.yaml 的 `vision-bridge:` 键〕。仓库内放**短 README**(功能简介 + 指向权威设计文档 `docs/design.md(本仓内快照)` 的引用)与 vendor 来源注明(commit/日期),**不放设计文档全文副本**〔评审#6:单一权威,避免双头文档〕。
- 顶层 inject 最小清单:`['tools','settings','attachments','agents','systemPrompt','credentials']`;fs 等可选用 `ctx.get()`;apply 返回 disposer;fiber 重入时缓存/索引可重建。〔2026-09-05 勘误:服务名是驼峰 `systemPrompt`(对照既有插件),连字符写法会让插件永久 pending 并在 boot 断言时杀死进程——曾致启动事故〕

### 5.3 工具 vision_bridge_read(M2)

- 入参(v1):`{ ref?: string; question?: string }`。ref 为占位符内 8hex(大小写归一、可选 `sha256:` 前缀)或全 attachmentId 或 `latest`。**不收 `path`/`url`**〔评审#1:与"非目标:不做任意路径读图"冲突,且无越权/SSRF/允许列表策略;任意路径/URL 读图继续归 modlens,未来如需再单独设计〕。
- 解析:`exec.agent.session.snapshotEvents()` 全量扫 `user/message` 与 `tool/result` 的 image block;前缀匹配→多命中返回候选列表(不猜)。拒绝非会话附件来源的取图请求(无 path/url 通道,天然无遍历/SSRF 面)。
- 取图:`attachments.readImageRequest()`;调用库 `analyze({images:[bytes], userRequest: question ?? '', ...})`;basic/structured 模式按设置 `visionCapabilities`。
- 失败:isError + 可行动信息;输出附 UNTRUSTED disclaimer(VLM 输出是不可信证据)。

### 5.4 auto 模式(M3)

- 触发:`ctx.on('session/event')` 过滤新到 `user/message` 含图;`agent/created` 时仅做诊断计数(tool 模式每次现场全量扫,无需回填索引)〔评审#14 定版〕;fork 全量继承。
- **准入门禁与本地补丁(2026-09-05 live 定版)**:服务端 prompt 准入原本按会话当前模型拒带图消息(`dsh-api-session-controller/lib/index.js:751` 与 `lib/types/commands.js:301`,MODEL_DOES_NOT_SUPPORT_IMAGES)——这会使文本-only 会话的新图无法入账、auto 触发条件不可自然发生。**本部署已施加受控本地补丁**(`plugins/dsh-vision-bridge/scripts/patch-admission-gate.mjs`,幂等,带 .bak 备份,已应用于两个运行时副本):准入不再按当前模型拒图,图片照常入账,由运行时投影为占位符,进入桥的 tool/auto 路径。**DSH 更新会覆盖核心包,更新后必须重跑该脚本**(多模态会话仍被 round-3 模态门禁跳过,零浪费)。
- 分析:async analyze(userRequest=当前消息归一化文本,**先清洗 DSH 占位符**再 normalize;纯图传空走库回退);超时/失败吞掉只记日志,绝不阻塞回合。
- **同步登记在途 Promise**〔评审#3〕:监听器入口、任何 await 之前,按 `session + 事件序号` 同步登记 in-flight Promise(消除"pre-step 先于登记"竞态)。
- 注入:`agent/pre-step` waterfall——await 该 in-flight Promise(有界超时),以 `PreStepDecision{kind:'enter', messages:[…, <vision-context> UserMessage]}` 追加,**同轮可见**;并按进入消息实际携带的 attachment id 做**相关性匹配,只注入匹配结果**;超时/失败/无匹配一律放行,由 tool 模式兜底。每条 note 标注"该解读回答的是附图当时的问题"(重放防误导)。
- 兜底:PromptContext(`ctx.systemPrompt.context`)低风险互补,消费后剪除防每步 token 税。
- 明确不用:库 `injectIntoMessages`(与 pre-step 双重注入)、`system-prompt/assemble` waterfall(section 在其后恢复,不可加)。

### 5.5 缓存(M2/M3)

- key = `attachmentId(内容寻址) + questionHash + 已解析配置指纹`〔评审#5:指纹 = endpoint baseURL + model + language + outputFormat/capabilities + 提示词/schema 版本〕;tool 与 auto 分 namespace(修双层互污染)。设置变更 → 指纹变化 → 自然 miss,旧条目经 LRU(maxEntries)/TTL 老化,不主动清除。
- 同 key 在途去重;并发闸默认 2(可配);经库的 `CacheBackend` 插槽由插件提供异步去抖实现(不改库源码),持久目录 `<DSH_HOME>/vision-bridge/cache`〔路径令牌统一:`<DSH_HOME>` = profile 根,本机 `D:\DSH-Portable\profile`;全文及 VERIFY 均用此令牌〕,不与 modlens CLI 共目录。

### 5.6 适配器 wrapper(M2,插件层包库,不动库源码)

接线 `signal`(库内 bug:声明未接 fetch);重试 2× 抖动退避;空响应判失败不缓存;结构化模式 maxTokens ≥ 2048;`timeoutMs` 1000–600000 默认 60000;auto 失败只记日志,tool 失败返回 isError。

### 5.7 设置面(M4)

命名空间 `vision-bridge`,套 toolkit 模式(`ctx.settings.register(ns, Config, {base, applies:'live', validate})` + `settings.watch` 拒收保旧 + `resolveConfig` 启动大声失败):

```yaml
vision-bridge:
  mode: both            # tool | auto | both
  provider:
    baseURL: ""         # 留空 = 用首次运行从 toolkit 拷贝并本地固化的默认值
    model: ""
  credential: VISION_API_KEY   # CredentialRef,与 toolkit 同名共享凭证条目
  timeoutMs: 60000       # 1000..600000
  concurrency: 2
  cache:
    maxEntries: 256
    persistDir: ""       # 缺省 <DSH_HOME>/vision-bridge/cache
  maxImageBytes: 10485760
  maxImagePixels: 40000000
  visionCapabilities:
    outputFormat: auto   # auto | hanako | gemini | qwen | anchor
  language: zh
  autoMode:
    maxPerTurn: 3   # 语义:每条 user/message 事件最多分析的图片数(评审#15 定版)
```

Web 设置页由 settings 服务自动渲染〔**2026-09-07 勘误:此判断错误**。设置页并不自动渲染第三方命名空间——Plugins 设置页渲染的是「服务端 served 命名空间 ∩ 注册了 UI 卡片的命名空间」的**交集**,无卡片的命名空间不渲染(`dsh-client-ui-settings-plugins/lib/client.js:1099-1103`,原文 "A served namespace no card claims renders nothing")。设置界面必须由插件自带 **client 半侧**(package.json `dsh.client` 声明 + `exports["./client"]`)注册 `settings.plugin.item` 卡片或 `settings.section` 设置节(参照 vision-toolkit `lib/client.js:538-544`)。v0.1.1 无 client 半侧,故设置页不可见——补齐方案见 §10〕;首次运行显式拷贝 toolkit provider 默认值后本地固化,**不 live 读 toolkit 命名空间**(防 schema 漂移);凭证一律 CredentialRef,勿读 process.env。

### 5.8 受影响文件清单与命令〔评审#7〕

| 文件 | 动作 | 职责 |
|---|---|---|
| `plugins/dsh-vision-bridge/package.json` | 新增 | 插件清单(type:module,main=lib/index.js,exports,files,scripts) |
| `plugins/dsh-vision-bridge/tsconfig.json` | 新增 | tsc 编译配置 |
| `plugins/dsh-vision-bridge/cordis.patch.yml` | 新增 | 自挂载 insert 行(id: vision-bridge) |
| `plugins/dsh-vision-bridge/README.md` | 新增 | 简介 + 权威设计文档引用 + vendor 来源注明 |
| `plugins/dsh-vision-bridge/vendor/vision-bridge/**` | 新增(vendor) | 引擎库源码 + dist(+ 补 manifest/tsconfig;测试移植 node:test) |
| `plugins/dsh-vision-bridge/lib/index.js` | 新增 | apply/inject 清单/settings.register/watch/disposer/fiber 重入重建 |
| `plugins/dsh-vision-bridge/lib/config.js` | 新增 | 设置 schema + resolveConfig(启动大声失败) |
| `plugins/dsh-vision-bridge/lib/tools.js` | 新增 | vision_bridge_read 定义(§5.3) |
| `plugins/dsh-vision-bridge/lib/resolve.js` | 新增 | 双占位符解析/snapshotEvents 全量扫描/候选消歧 |
| `plugins/dsh-vision-bridge/lib/auto.js` | 新增 | session/event 监听+在途 Promise 登记+pre-step 注入+PromptContext 兜底(§5.4) |
| `plugins/dsh-vision-bridge/lib/cache-backend.js` | 新增 | 异步去抖 CacheBackend + 指纹 key(§5.5) |
| `plugins/dsh-vision-bridge/lib/adapter-wrapper.js` | 新增 | signal/重试/并发闸/空响应判失败/超时(§5.6) |
| `plugins/dsh-vision-bridge/tests/*.test.mjs` | 新增 | node:test 测试矩阵(§7) |
| `profile/settings.yaml` | 修改 | vision-bridge 设置段;多模态模型 `input:[text,image]` 声明(§3) |
| `profile/cordis.patch.yml` | 无需改动 | 插件自带 cordis.patch.yml 自挂载;**禁止手动加同名行**(duplicate loader entry id 崩启动,2026-09-05 事故) |
| `profile/profiles/web/package.json` | 修改 | 依赖行 `file:../../../plugins/dsh-vision-bridge` + bundles 数组 |

命令:库构建 `cd vendor/vision-bridge && npm run build`;插件测试 `node --test tests/`;安装 = profile `pnpm install` 后重启 DSH web;验证 = §7 验收清单逐条。

## 6. 生态边界(最终版)

- **modlens**:桥仅替代"会话附件代读"子角色;保留任意路径/URL 深读、全页 verbatim OCR(ocr.full_text+layout)、多 provider failover、guard/doctor、CLI(screenshot-look 依赖)。卸载是独立迁移决策(含 ~/.modlens 配置与 failover 链迁移)。
- **vision-toolkit**:保留,分工:桥=会话附件 ref 代读+auto 注入+会话级缓存;toolkit=工作区路径 VLM 工程操作+像素级 grounding+Artifacts。vision_glance/ground/detect/trace 与桥 tool 模式重叠由同一 provider/凭证缓解;像素类工具(crop/pixel_diff/dominant_colors/extract_foreground/html_screenshot/long_ocr)正交不重叠。

## 7. 验收标准

1. glm-5.3-flash 声明 image 后:贴截图 → 模型直接描述图片内容,无 UNSUPPORTED_CONTENT;
2. 文本-only 模型:贴截图 → 不报错,模型见占位符 → 调 vision_bridge_read → 依据描述正确回答;多命中时返回候选;
3. auto:贴图当轮模型可见 <vision-context>;超时不阻塞回合;失败仅日志;
4. compaction/fork/resume 后旧图经 tool 仍可解析(snapshotEvents 全量);
5. 双模式缓存不串答案(同图异问必 miss);
6. fiber 重启可重建、卸载 disabled 行 warn 不致命;
7. 设置页改 provider/mode 即时生效。

**测试矩阵〔评审#4,每条用户故事 × 正常/边界/错误,全部 node:test〕**:坏 ref/未知 ref → isError+可行动信息;附件读取失败;凭证错配/缺失;缓存文件损坏 → 降级重建不崩溃;回合取消 → 附件读取(readImageRequest)即时中止〔2026-09-07 对齐已验证边界:引擎 analyze() 不收 signal,VLM HTTP 调用与重试退避不可取消,待上游 signal 透传后根治,VERIFY §2.6 已记〕;超限(字节/像素/每轮条数);空 VLM 响应 → 视为失败不缓存;多命中 → 候选列表;另含一条**真实调用 smoke test**(方法论要求)。测试映射表随实现写入插件仓库 tests/,每条验收标准至少一个对应用例。

## 8. 实施里程碑

M1 库工程化(manifest+tsconfig+dist+vendor)→ M2 插件骨架+tool 模式(解析/取图/wrapper/缓存)→ M3 auto 模式(session/event+pre-step+PromptContext 兜底)→ M4 设置页+凭证 → M5 文档+screenshot-look 迁移说明。

## 9. 风险登记

| # | 级别 | 风险 | 缓解 |
|---|---|---|---|
| 1 | 🔴 | session.events 访问器失效 | 设计已改 snapshotEvents();验收 4 覆盖 |
| 2 | 🔴 | 库不可加载(缺 manifest/无 dist) | M1 先决;specifier 保持 .js+dist |
| 3 | 🟠 | 缓存双层分裂/互污染 | key=attachmentId+questionHash,分 namespace,去重 |
| 4 | 🟠 | 适配器 signal/重试/截断/空响应 | wrapper 层统一补齐 |
| 5 | 🟡 | auto 首轮失明 | pre-step 同轮注入+超时放行+PromptContext 兜底 |
| 6 | 🟡 | 8hex 碰撞/双占位符形态 | 双形态解析+多命中候选列表 |
| 7 | 🔵 | inject 静默 pending/fiber 重启/配置漂移 | 最小清单+ctx.get+可重建缓存+首次拷贝固化 |

## 10. 设置界面 + promptExtra(2026-09-07 增订,经用户确认)

> 背景:用户报告设置页无 vision-bridge 命名空间(§5.7 勘误所述根因),并要求把 prompt 附加指令做进设置 UI。用户已选定「附加指令 promptExtra」粒度(保留 8 段结构契约,不做 system 全量覆盖)与「Plugins 设置页卡片」形态。

### 10.1 需求(三层)

**总目标**:vision-bridge 的全部配置(含新增 promptExtra 附加指令)可在 DSH 设置 UI 中查看、修改并即时生效;指令影响 tool/auto 两模式的 VLM 代读输出;清空即回默认。

**功能用户故事**:
1. 作为用户,我打开 设置→插件 页,能看到 vision-bridge 卡片,显示当前生效配置(provider/credential/mode/language/outputFormat/timeoutMs/concurrency/autoMode.maxPerTurn/promptExtra),不必手改 settings.yaml。
2. 作为用户,我在卡片里改任一字段并保存,下一次工具调用/自动分析即用新值,无需重启 DSH(live 链路已存在,§5.7)。
3. 作为用户,我在 promptExtra 写附加指令(如「优先转录图中中文文字;省略坐标」),代读输出遵循该指令;改指令后同图同问不命中旧缓存;清空回默认。
4. 作为用户,我填了非法值(超长指令/非法 baseURL 等),保存被拒并看到原因,旧配置继续生效(既有 refuse-and-keep-old 链路)。

**非功能**:零新增运行时依赖;client 半侧纯 JS(no JSX/no TS/无构建);写入全部走既有 settings 服务 validate/live 链路;promptExtra 纳入缓存指纹;en/zh 双语文案;不改核心包、不改 vendor 引擎;零依赖 node --test 为本仓 §5.1 沿用约定(本仓无 METHODOLOGY.md,系项目自持规范而非外部文件引用)。

### 10.2 运行时事实(本机实测,2026-09-07)

1. **client 半侧装载协议**:`window.__ModuleLoader__.load({id, factory:(require)=>{…}})`,factory 返回 cordis 风格插件对象 `{name, inject:[服务名], apply(ctx)}`;react 经 `require("react")` 注入;**浏览器半侧必须纯 JS,无 JSX/TS**(`dsh-cordis-client-runner/lib/client.js:55,169`);package.json `dsh.client={platform:'web',inject:[宿主包]}` + `exports["./client"]` 声明(参照 dsh-effort-switcher、@hytime/dsh-thinking-effort、vision-toolkit 三例)。
2. **设置页两账本交集**:Plugins 设置页经 ConfigurablePluginsTabController 枚举 `ctx.slots.entries('settings.plugin.item')` 且 `options.key` 命中 served 命名空间才渲染(`dsh-client-ui-settings-plugins/lib/client.js:1099-1153`);卡片为手写 React 控件;备选面 `settings.section`(vision-toolkit 先例 `lib/client.js:538-544`)。
3. **设置读写面**:`ctx.settingsScope.bind({namespace})` → scope 读取/原子写(`dsh-client-ui-settings/lib/client.js:944-1045`,set/unset/mutate);写入触发服务端 validate,拒绝即保旧(§5.7 既有行为,VERIFY §6.2 已验)。
4. **指令拼装点**:`lib/index.js:220-223` language 指令已追加在 userRequest 尾部;`AnalyzeParams` 无 system 钩子(vendor `types.ts:70-76`),promptExtra 沿用同一拼装点(用户已确认此取舍)。
5. **缓存指纹**:`configFingerprint`(`lib/config.js:184-192`)已含 baseURL/model/language/outputFormat/ENGINE_PROMPT_VERSION;promptExtra 加入同列。
6. **生效链路**:settings.watch → state.config 重建 → analyzeImage 每次调用实时读取(`lib/index.js:198-232`),tool/auto 共用,零额外接线。

### 10.3 方案

**A. 服务端 promptExtra**(改 `lib/config.js` + `lib/index.js`):
- schema:`promptExtra: z.string().default('')`;resolveConfig trim 后透传;校验:长度 ≤2000 字符(拒绝即走 refuse-and-keep-old)。
- 指令拼装:`userRequest = question + languageDirective + (promptExtra ? '\n\n' + promptExtra : '')`(空指令零字节变化,缓存键不因空值漂移——指纹对空值归一)。
- `configFingerprint` 纳入 `resolved.promptExtra`(空串与缺省同指纹)。

**B. client 半侧设置卡片**(新增 `lib/client.js` + package.json 声明):
- `window.__ModuleLoader__.load` 工厂,`require("react")`,React.createElement 手写控件(无构建步骤)。
- **inject/装载清单**〔依 §10.2 实测先例;错名 = 静默不加载,§2-9〕:package.json `dsh.client = {platform:'web', inject:['@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-settings','@deepseek-ai/dsh-client-locale']}`;返回插件对象 `inject:['slots','settingsScope','locale']`(服务名分别依 effort-switcher 的 `'slots'`、settings-plugins 的 `ctx.settingsScope`、toolkit 的 `ctx.locale` 三例实测)。实现首步断言:重启后 console 零 `cannot get property "x" without inject`,且卡片槽位实际出现在 Plugins 页。
- 注册 `settings.plugin.item` 卡片,key=`vision-bridge`;表单字段=§10.1 故事 1 全集,promptExtra 用 `<textarea>` 多行(带 2000 字符计数提示)。
- 交互:进入卡片加载当前值 → 本地草稿编辑 → 「保存」原子 `scope.mutate(ops)` → 服务端 validate;失败显示**保存失败提示并保留草稿**(公开 settingsScope 契约被拒时不回传具体原因——与宿主内置卡同构,具体原因见服务端日志 keeping previous 行〔§10.8 偏差记录〕),成功后刷新为生效值;「重置」放弃草稿回当前生效值。空 baseURL/model 输入框 placeholder 提示「留空=使用首运行固化默认」。credential 为纯文本输入(CredentialRef 名),不做密码框(名非密钥)。
- i18n:`ctx.locale.register('vision-bridge-ui', {en, zh})`;样式沿用宿主 CSS 变量(--dsw-alias-*),内嵌最小 css(参照 effort-switcher)。
- 失效面:插件 disabled 行 warn-skip 时命名空间不 served → 卡片自动不渲染(两账本交集语义),无需额外处理。

### 10.4 受影响文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `plugins/dsh-vision-bridge/lib/config.js` | 修改 | promptExtra schema/校验/指纹 |
| `plugins/dsh-vision-bridge/lib/index.js` | 修改 | 指令拼装(:220-223 处) |
| `plugins/dsh-vision-bridge/lib/client.js` | 新增 | 设置卡片(纯 JS module-loader 工厂) |
| `plugins/dsh-vision-bridge/package.json` | 修改 | `dsh.client` 声明 + `exports["./client"]` + files 增 lib/client.js |
| `plugins/dsh-vision-bridge/tests/*.test.mjs` | 修改/新增 | promptExtra 用例(schema 默认空/校验拒超长/指纹参与/拼装单测/auto 路径同拼装) |
| `plugins/dsh-vision-bridge/tests/TEST-MATRIX.md` | 修改 | §10 用例映射行(交付补列) |
| `docs/design.md` | 修改 | §5.7 勘误 + 本章节 |
| `docs/VERIFY.md` | 修改 | 新增 §8 设置界面人工验收清单 |
| 安装副本 + 重启 | 操作 | robocopy /MIR(排除 .git node_modules)→ 重启 DSH web → 刷新页面(client 清单变化) |

### 10.5 验收标准(映射 VERIFY §8)

1. 设置→插件 页出现 vision-bridge 卡片,字段齐全,当前值与 settings.yaml/生效日志一致;
2. UI 改 provider.model → 无重启,下一次 vision_bridge_read 走新模型(缓存 miss);
3. promptExtra 写「回答末尾附一行 MARKER-EXTRA」→ 代读输出含该标记;同图同问改指令后不命中旧缓存;清空后输出回默认;
4. 非法值(timeoutMs=5)保存被拒,卡片显示保存失败提示(原因不回传是 settingsScope 公开契约边界,见服务端日志 keeping previous),旧配置生效;promptExtra>2000 由客户端预拦截(禁存+提示),服务端拒绝路径保留(settings.yaml 直改可触发);
5. client 半侧加载零 console 错误;刷新页面卡片仍在;插件 disabled 时卡片消失且页面不崩;
6. `node --test` 全绿(含新增 promptExtra 用例)。

### 10.6 测试矩阵增补

| 验收条 | 正常 | 边界 | 错误 |
|---|---|---|---|
| §10.5-3 | 指令拼装单测:非空 promptExtra 出现在 userRequest 尾部 | 空串/纯空白归一为空,指纹与缺省一致 | — |
| §10.5-4 | resolveConfig 接受 ≤2000 字符 | 恰 2000 字符 | >2000 拒绝抛 TypeError;非法 UTF-16 孤项拒 |
| 缓存 | 指令变化 → configFingerprint 变化 | — | — |
| client | 卡片注册槽位/字段渲染(node 环境静态断言导出形状) | — | — |

### 10.7 风险登记(本章增补)

| # | 级别 | 风险 | 缓解 |
|---|---|---|---|
| 8 | 🟠 | `settings.plugin.item` 卡片契约非公开文档 API(由 settings-plugins 内部实现推断) | 实现时以运行时行为为准验证;备选面 `settings.section`(toolkit 同构先例)降级切换,卡片代码面改动局部 |
| 9 | 🟠 | client 服务名(inject 数组)猜错 → 插件静默不加载 | 以 effort-switcher/toolkit 实测声明为准;boot 后 console 无 "cannot get property" 即通过 |
| 10 | 🟡 | 纯 JS 手写 React 控件可维护性 | 字段控件极简(input/select/textarea + label),无复杂状态;样式靠宿主变量 |
| 11 | 🔵 | promptExtra 与 language 指令顺序耦合 | 固定顺序 language→promptExtra 并单测锁定 |

### 10.8 交付偏差记录(2026-09-07,偏差审计定案)

| # | 级别 | 偏差 | 处置 |
|---|---|---|---|
| 1 | 🟡 | §10.5-4 原文承诺「卡片显示错误原因」——公开 `settingsScope.mutate` 被拒时不抛错、不回传原因(`dsh-client-ui-settings/lib/client.js:1046-1049` 丢弃 response.error),宿主内置卡同构仅显示通用失败提示;交付照宿主同构实现但未先行修订设计措辞 | 定案:接受宿主契约边界,§10.3 B 与 §10.5-4 措辞已改为「保存失败提示 + 日志取因」;不为此越出 settingsScope 公开契约 |
| 2 | 🔵 | §10.4 清单漏列 `tests/TEST-MATRIX.md`(diff 实际包含) | 已补列 |
| 3 | 🔵 | client 静态测试为纯文本断言,弱于「断言导出形状」且对字面量重构脆弱 | 缓后:符合 §10.6「静态断言」字面约定;未来引入 client 测试基建时再升级为 stub loader 执行工厂取真实导出 |

## 11. 设置卡片重设计:Provider 联动 + 凭证三形态 + 连通验证 + 环境体检(2026-09-07 增订,经用户确认)

> 背景:§10 交付后用户实测提出三项可用性改进:①卡片改名「dsh-VisionBridge 视觉代读」②provider/model 从 DSH 已配置 provider 里选(手填兜底)③凭证从「猜引用名」改为「选/贴即用」。另加连通验证按钮与两项一键环境修复(准入补丁/modlens 冲突)。原型经 render_ui 三轮可视化呈现并获用户逐项确认。

### 11.1 需求(三层)

**总目标**:设置卡片从「懂配置的人才用得了」升级为「普通用户装完即用」:选 provider → 凭证自动就位 → 验证连通 → 环境体检一键修复 → 贴图即用,全程零命令行、零凭证知识。

**功能用户故事**:
1. 作为普通用户,我打开设置卡片,从下拉里选一个我认识的 provider(如 zai-coding-cn)→ 模型下拉只列该 provider 的 vision-capable 模型(👁 标识)→ Base URL 和凭证自动带出并验证 → 点「验证连通」看到 ✓ → 直接贴图用。
2. 作为自定义端点用户,我切到「自定义」→ 四字段解锁手填 → 验证连通 → 保存。
3. 作为新密钥用户,我在凭证下拉选「粘贴新 API Key…」→ 贴入密钥(如 sk-xxx)→ 保存时自动经 DSH 凭证服务创建凭证条目(默认名 VISION_API_KEY)→ 输入框清空,密钥不落本插件配置。
4. 作为换机器用户,我打开卡片看到「环境体检」区:准入补丁 ⚠ → 点「一键修复」→ 提示需重启;modlens 冲突 ⚠ → 点「一键关闭」→ 提示需重启;两项全 ✓ 时该区折叠为一行绿色摘要。
5. 作为用户,卡片标题显示「dsh-VisionBridge 视觉代读」,高级字段默认折叠(输出格式/超时/并发/每轮上限),首次只露出核心 5 字段。

**非功能**:纯 JS createElement(client 半侧协议不变);宿主 CSS 变量做色;新 inject 清单必须加 remote/settings 读取能力(错名=静默不加载);凭证密钥永远不落 vision-bridge 命名空间(仍只存 CredentialRef 名);体检不自动执行修复(用户点按钮才执行,带后果说明);node:test 零新依赖。

### 11.2 运行时事实(需新增验证的实现前提)

1. **providers 只读投影**:settings.yaml `llm-pi-ai.providers.*` 含 `apiKeyEnv`/`models[].input`——服务端可直接读并投影为「provider 下拉数据源」{id, baseURL 推断, models[{id, vision-capable}]};宿主 settings-plugins 内置卡(SubagentModelSelectionCard)已有同类消费先例(refreshCatalog 读 adapter catalog)。**实现前必须核实**:provider baseURL 是否可直接从 settings.yaml 读到(zai-coding-cn 无 baseURL 字段——api base 可能由 provider 适配器内置或另有配置;若读不到则下拉项只带 apiKeyEnv+models,baseURL 仍手填/留默认)。
2. **凭证创建 API**:宿主 dsh-credentials 支持 `credentials.create/resolve`(settings-plugins 内置 webSearch 卡经 `ctx.remote.credentials` 管理凭证——同构先例);client 半侧需注入 `@deepseek-ai/dsh-api-remotes`(含 remote.credentials 服务)。**实现前必须核实**:remote.credentials 的确切服务名与方法签名。
3. **连通验证路由**:插件已有 `ctx.inject(['webServer'])` 能力(modlens 同构)——注册 `POST /vision-bridge/test`:body {baseURL?, model?, credential?} → 服务端 resolveConfig → resolveCredential → 发 1×1 像素图 analyze → 返回 {ok, latencyMs, error?}。**凭证解析在服务端做,密钥永不下发到 client**。
4. **准入补丁检测**:读 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` 搜补丁 marker(patch-admission-gate.mjs 写入的 `if (false)` 或注释标记);幂等重跑=复用 scripts/patch-admission-gate.mjs 的 Node API(导出函数,非仅 CLI)。
5. **modlens 冲突检测**:①modlens 是否在已加载插件列表(服务端 ctx 插件注册表) ②`GET /modlens/paste?model=x` 是否 404(404=已禁用)。一键关闭=向 `profile/profiles/web/cordis.patch.yml` 追加/合并 `- id: modlens / config: {pasteToPath: false}` override 行(YAML 定点追加,先检查是否已有该行,幂等;写后提示重启)。
6. **client inject 增量**:需 `@deepseek-ai/dsh-api-remotes`(remote.settings/remote.credentials)与 webServer 路由对接 → `dsh.client.inject` 增至 `['@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-settings','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-api-remotes']`;插件对象 inject 增 `'remote'`(或具体 remote.settings/remote.credentials——以 settings-plugins 内置卡声明为准)。

### 11.3 方案

**A. 卡片结构(三组折叠+体检区)**:

```
dsh-VisionBridge 视觉代读          [已连接✓] [mode: both]
纯文本模型的会话截图由视觉模型代读…

┌─ ① 视觉引擎 ─────────────────────────────────┐
│ Provider [▼ zai-coding-cn]  模型 [▼ glm-5.3-flash 👁] [验证连通]
│ Base URL [https://api.zai…(自动带出,可改)]   凭证 [ZAI_CODING_CN_API_KEY ✓自动带出]
│ (凭证下拉:已存凭证列表 + 「粘贴新 API Key…」 + 「输入凭证条目名…」)
│ (选「粘贴新 API Key」展开 monospace 输入框 + 提示「保存时自动创建凭证条目,密钥不落配置」)
└───────────────────────────────────────────────┘
┌─ ② 触发与输出 ───────────────────────────────┐
│ 触发模式 [▼ both]  回答语言 [▼ zh]
│ 附加指令 [textarea…0/2000]  (修改后旧缓存自动失效)
└───────────────────────────────────────────────┘
▸ 高级设置(输出格式 · 超时 · 并发 · 每轮上限)
┌─ 环境体检 [重新检测] ─────────────────────────┐
│ ✓ 连通正常 — VLM 端点可达,凭证有效(延迟 45ms)
│ ⚠ 准入补丁未生效 — [说明折叠] [一键修复]
│ ⚠ modlens 粘贴冲突 — [说明折叠] [一键关闭]
│ (全 ✓ 时:✓ 环境就绪,无需操作)
└───────────────────────────────────────────────┘
                                    [重置] [保存]
```

**B. Provider 联动逻辑**:
- Provider 下拉数据:服务端投影(§11.2-1) → client 缓存;选项含每个 DSH provider + 「自定义」
- 选中 provider → model 下拉只列该 provider 的 vision-capable 模型(input 含 image,👁 标识)+ 全部模型(文本模型标灰仍可选——供 auto 模式用户理解能力);同时自动填 baseURL(若可读)+ credential(apiKeyEnv 对应条目名)
- 选中「自定义」→ 四字段解锁手填(紫色边框视觉区分,§10 原字段全保留)
- 写回语义不变:保存仍是 vision-bridge 命名空间的三字段(baseURL/model/credential)——provider 选择只是**填表辅助**,不新增配置字段(避免 schema 漂移)

**C. 凭证三形态**:
- 形态 1(联动):provider 选中自动带出 apiKeyEnv 条目名,后台静默验证(resolveCredential 成功=✓)
- 形态 2(选择):下拉列出 DSH 已存凭证条目(remote.credentials.describe),每项带来源 provider 说明
- 形态 3(贴密钥):选「粘贴新 API Key…」→ 展开 input → 保存时客户端调 remote.credentials.create(默认名 VISION_API_KEY,或用户改)→ 成功后 credential 字段写入条目名、密钥输入框清空
- **安全不变量**:vision-bridge 配置仍只存 CredentialRef 名;密钥经 DSH 凭证服务加密存储,不进本插件 settings、不进 client 内存持久层

**D. 连通验证按钮**:
- 位置:①视觉引擎组内,与 Base URL/模型同行
- 行为:点击 → 按钮禁用+「⏳ 验证中…」→ POST /vision-bridge/test(当前草稿的 baseURL/model/credential;若凭证框处于「贴密钥」态则先暂存密钥待保存时建条目,验证用临时 resolve)→ 展示 ✓ 连通(模型+延迟)/ ✗ 失败(具体原因:401 凭证错/404 端点错/超时/未知)
- 服务端 route:webServer scoped inject,注册/守卫与 modlens 同构;1×1 PNG 单次 analyze,不写缓存

**E. 环境体检+一键修复**:
- 检测(卡片挂载时自动跑一次,带 [重新检测]):
  - 连通 = D 的结果缓存
  - 准入补丁 = 服务端读核心包源码搜 marker(§11.2-4)
  - modlens 冲突 = 服务端查插件注册表 + fetch /modlens/paste(§11.2-5)
- 一键修复准入补丁:POST /vision-bridge/fix-admission → 服务端调 patch 脚本的导出函数(幂等,.bak 兜底)→ 返回 {applied, needsRestart: true} → 前端提示「已应用,重启 DSH web 后生效」
- 一键关闭 modlens:POST /vision-bridge/fix-modlens → 服务端向 profile 层 cordis.patch.yml 幂等追加 override 行 → 返回 {applied, needsRestart} → 同上提示
- 每项 ⚠ 附折叠的人话说明(非开发者可读),修复按钮只对 ⚠ 可见
- 全 ✓ 时区块缩为一行「✓ 环境就绪」

**F. i18n**:en/zh 双语增补(所有新标签/提示/说明文案);卡片标题 locale key `cardTitle` = 「dsh-VisionBridge 视觉代读」/ "dsh-VisionBridge Vision Read"。

### 11.4 受影响文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `plugins/dsh-vision-bridge/lib/client.js` | 大改 | 三组折叠布局+provider 联动+凭证三形态+验证按钮+体检区 |
| `plugins/dsh-vision-bridge/lib/server-routes.js` | 新增 | webServer scoped inject:/test /env-check /fix-admission /fix-modlens 四路由 |
| `plugins/dsh-vision-bridge/lib/index.js` | 修改 | 挂载 server-routes;可能暴露 providers 投影 |
| `plugins/dsh-vision-bridge/lib/config.js` | 不变 | schema 零新增(联动只是填表辅助) |
| `plugins/dsh-vision-bridge/scripts/patch-admission-gate.mjs` | 修改 | 导出可编程调用的 applyPatch 函数(保留 CLI 入口) |
| `plugins/dsh-vision-bridge/package.json` | 修改 | dsh.client.inject 增 @deepseek-ai/dsh-api-remotes;files 已含 lib |
| `plugins/dsh-vision-bridge/tests/*.test.mjs` | 新增/修改 | 服务端路由单测+client 静态断言更新+provider 投影单测 |
| `plugins/dsh-vision-bridge/tests/TEST-MATRIX.md` | 修改 | §11 映射行 |
| `docs/VERIFY.md` | 修改 | §9 人工验收清单 |
| 安装副本+重启 | 操作 | robocopy /MIR → 重启 DSH web → 刷新页面 |

### 11.5 验收标准(映射 VERIFY §9)

1. 卡片标题显示「dsh-VisionBridge 视觉代读」;三组折叠(高级默认收起);首次露出 ≤6 字段。
2. Provider 下拉列出 DSH 已配置 providers;选中后 model 下拉只列该 provider 模型(vision-capable 带 👁);Base URL 与凭证自动带出(可改)。
3. 选「自定义」→ 四字段解锁手填,紫色边框区分。
4. 凭证下拉含已存条目列表 + 「粘贴新 API Key…」;贴密钥保存后自动创建凭证条目(密钥不落 vision-bridge 配置)、输入框清空、credential 字段写入条目名。
5. 「验证连通」按钮:验证中态 → ✓(模型+延迟)/ ✗(具体原因)。
6. 环境体检:准入补丁/modlens 冲突检测正确;一键修复后提示需重启;全 ✓ 缩为一行。
7. 保存/重置/拒收保旧行为不回归(§10.5 1-4 全部仍过)。
8. `node --test` 全绿(含新增用例)。

### 11.6 测试矩阵增补

| 验收条 | 正常 | 边界 | 错误 |
|---|---|---|---|
| §11.5-2 | providers 投影含 id+models(vision 标识) | 空 providers 配置 → 下拉仅「自定义」 | — |
| §11.5-4 | 贴密钥 → remote.credentials.create 调用参数正确 | 密钥空/全空白 → 拒 | create 失败 → 显示原因,不写入 credential |
| §11.5-5 | /test 路由返回 ok+latency | 端点 404/超时/凭证 401 → 各自 error 码 | 路径非 POST → 405 |
| §11.5-6 | 补丁 marker 检测 true/false 正确 | 核心包路径不存在 → unknown | — |
| §11.5-6 | modlens 检测:未安装→✓;装了+404→✓;装了+200→⚠ | patch.yml 已有 override 行 → 幂等跳过 | YAML 写失败 → error 返回 |
| client | 静态断言:三组结构/provider 联动函数/凭证三形态控件/体检区 | — | — |

### 11.7 风险登记(本章增补)

| # | 级别 | 风险 | 缓解 |
|---|---|---|---|
| 12 | 🟠 | providers 投影读不到 baseURL(provider 适配器内置)→ 联动填不全 | 实现首步核实;读不到则该项留空+提示「手动填 Base URL」 |
| 13 | 🟠 | remote.credentials 服务名/签名猜错 → 静默不加载或调用失败 | 以 settings-plugins 内置 webSearch 卡实测声明为准;boot 断言 |
| 14 | 🟠 | 一键修复写 profile cordis.patch.yml 与用户手编冲突 | 幂等追加(先搜已有行);写前读全文+严格 YAML 校验;失败返回原文件不动 |
| 15 | 🟡 | patch 脚本改 export 影响 CLI 兼容 | 保留 CLI 入口不变;导出函数单独单测 |
| 16 | 🔵 | 体检自动跑 /test 造成多余 VLM 费用 | 体检的连通项只在用户点「验证连通」后缓存,挂载时只用上次缓存或跳过 |

## 附录 A:架构评审报告(全文)

（评审 A,只读,行号实测）

### ① 拦截面选择:同意"占位符+工具代读"为主面;adapter/中间件/session-controller 三条替代线全部否决

1. 投影点是 adapterStream 内部的"派发时瞬态投影":dsh-llm/lib/index.js:1684-1690 — 仅当 modelInfo.inputModalities!==undefined 且不含 image 时调 projectImagesForTextModel;投影只改请求副本(content.js:158-165),durable 事件里的 ImageBlock 原样保留(deriveMessages 复用 frozen durable event data — dsh-session/lib/index.js:1497-1499)。⇒ 会话事件里没有占位符文本,占位符只在模型视角,这正是"模型引用8位前缀→工具回扫事件取全量ref"成立的原因。
2. adapter 包装:否决。registerAdapter 对同 provider 抛 DUPLICATE_ADAPTER(dsh-llm/lib/index.js:1272),无法与 pi-ai 共存同路由;接管路由还破坏 replay-state 归属(forAdapter 1631-1652)。
3. LlmRuntime 中间件(llm/stream):否决"改写"用途。签名 'llm/stream'(this:LlmRuntime, options, next:()=>AsyncIterable<StreamChunk>)(dsh-llm/lib/types/index.d.ts:43;实现 index.js:1739);cordis waterfall 的 next() 无参、内层闭包捕获原始 options(cordis/lib/index.js:317-325)⇒ 只能观察/包装流,不能替换请求;请求冻结(dsh-agent-loop/lib/invariant.js:17)。强行"拦截后改写重发"会撞 agent-loop 重建不变量:invariant.js:26-28 要求派发 messages 与 session.deriveMessages() JSON 全等,改写即 fail,并使 assistant replay 状态退化(pi-ai/lib/index.js:2497-2499 onReplayDegrade)。
4. session-controller 钩子:否决。dsh-api-session-controller 是外部 API 面(prompt 准入/附件读取 lib/types/index.d.ts:127-133),非每请求变换缝。
5. 【致命修正】工具回扫必须用 session.snapshotEvents(),不能用 exec.agent.session.events:当前顶层 dsh-session 0.1.2-rc.1 的 Session 类没有 events 成员(全类 1228-1527 行核查;仅 snapshotEvents/ownEvents/deriveMessages);get events() 只在旧版 0.1.1-rc.2 存在。活体踩坑实证:dsh-vision-toolkit/lib/exposure.js:42 的 session.events ?? [] 在当前运行时恒为空,hasLoadedVisionSkill 的 durable-history 路径是死代码(插件靠 tools/result 活路径才工作)。
6. 取图建议改 readImage/readImageRequest 字节直读,弃 imageHostPath+processPathFromHostPath 依赖:imageHostPath 对非宿主文件后端可返回 undefined(dsh-attachment/lib/types/index.d.ts:62-65);readImage 返回校验字节(index.d.ts:58),readImageRequest 给按预算缩放的请求版字节(index.d.ts:73),VLM 成本更低。

### ② 8位哈希前缀解析:compaction 不改写原始日志;真正失效面在模型可见面

1. 前缀机制:textOnlyImageText 取 String(attachmentId).slice(7,15) 即 sha256 hex 前8字符(content.js:47-50);占位符无路径无 name。
2. compaction 是 SHADOW 不是改写:"actual surface replacement is performed by the immediately following user/message event that shadows the compacted range"(dsh-compaction/lib/types/types.d.ts:27-30;shadowedSeqs 权威集合 43-44)。append-only 原始日志 deep-frozen 不可改 ⇒ 扫 snapshotEvents() 时 compaction 后前缀解析仍成功。
3. 模型可见面会失去占位符:deriveMessages 按面投影,"a compaction replace deletes the shadowed nodes from the derivation"(dsh-session/lib/types/index.d.ts:264-268)。⇒ 失配方向与担心的相反:不是"事件找不到",而是"模型引用消失"(用户事后显式给 ref 仍可解析,算 feature)。
4. fork:子会话以父事件副本为种子(dsh-session index.d.ts:317-318),图片块随复制;扫描必须全量 snapshotEvents() 而非 ownEvents()(ownEvents 排除 fork 前缀,index.js:1350-1355)。
5. 歧义量化:8 hex=32bit,生日碰撞 n=100≈1.2e-6、n=2000≈4.5e-4/会话——低但非零;同图两附件同 id 同占位符(字节相同,无实质歧义)。工具须多命中返回候选列表,并归一化大小写/可选 sha256: 前缀。
6. 扫描范围不能只看 user/message:contentHasImage 递归走 tool-result(content.js:88-91),工具返回的截图嵌在 tool/result 事件里;解析器要一并扫。
7. 重启/resume:constructor seed 不发事件("constructor seeds do not emit" dsh-session index.d.ts:127),事件驱动索引必须在 agent/created 时用 snapshotEvents() 回填。

### ③ auto 模式:监听 session/event(user/message 过滤)选对;"动态提示段下一轮注入"有时序洞;更优替代是 agent/pre-step 瀑布

1. 监听事件:'session/event' firehose(声明 dsh-session/lib/types/index.d.ts:64),过滤 event.type==='user/message' 且 content 含 image block。所有新到消息都走它;种子历史不发,必须 agent/created 回填。
2. 时序洞确认:user/message 追加后 agent loop 立即 preStep→assemble(dsh-agent-loop/lib/index.js:502,每步一次 assemble),VLM 秒级延迟必然输给首次组装 ⇒ "下一轮注入"在无工具调用的首轮响应全盲,用户观感"它没看我的截图"。
3. 更优替代 A(同轮可见,推荐为主):'agent/pre-step' waterfall — 官方声明"Reject a proposed step or replace the messages that enter it"(dsh-agent/lib/types/runtime-types.d.ts:229-245;PreStepDecision={kind:'enter',messages} 见 50-57;agent-loop 消费点 index.js:506-513)。插件在此 await 缓存/在途的 VLM 分析,返回追加了 <vision-context> UserMessage 的 decision ⇒ 同轮即可见;带超时回退(超时放行,靠工具模式兜底)。
4. 更优替代 B(互补、低风险):PromptContext 注册 — ctx.systemPrompt.context({name,order,text}),"Dynamic model context materialized as a durable user-role snapshot"(dsh-system-prompt/lib/types/index.d.ts:69-77),每次 assembly 求值;AssembleContext 合并了 agent?: Agent ⇒ 单一全局注册即可按 agent.session.id 取各会话缓存。注意:不要走 system-prompt/assemble waterfall 注入 section——"A registered complete section is restored after this waterfall"(index.d.ts:19-22);注册 API(section/context/variable,index.d.ts:225/244/268)才是正道。
5. PromptContext 成本项:每步重渲染注入文本直到清除;须做消费后剪除/会话级失效,否则长会话每步都背 token 税。schema {{variable}} 是严格插值,纯 PromptContext 文本不涉变量则无此风险。

### ④ 纯 cordis insert 行挂载 + inject 严格声明清单

1. 行格式:- insert: [{id, name, config?, disabled?}](vision-toolkit cordis.patch.yml;profile 根 cordis.patch.yml:43-44 以同 id 覆盖 config)。id 是覆盖键,用户覆盖行必须同 id,错 id 会双实例。
2. 严格注入:活跃 fiber 上访问未声明服务直接抛 cannot get property "x" without inject(cordis/lib/index.js:675)。建议声明:tools、settings、attachments、agents、system-prompt、credentials(参照 pi-ai index.js:2479-2486 走 ctx.credentials.resolve + launchEnvironment 兜底链)。不要抄 vision-toolkit 的 subprocess/skills。
3. 静默 pending:声明式 inject 会让插件等全部服务就绪才 apply;名字打错/服务永不提供=插件无声不加载。收敛:顶层 inject 只放必需;可选用 ctx.inject([...],cb) 局部注入(pi-ai index.js:2501,2544)或 ctx.get() 免注入读(get 不走 inject 检查,cordis index.js:762)。
4. fiber 重启:settings applies:'live' + 服务拓扑变化会重启插件 fiber——模块级缓存必须可在 apply 重入时重建;监听器/工具经 ctx effect 注册随 fiber 自动清理(cordis index.js:335-345),apply 返回 disposer 收尾(vision-toolkit index.js:81-91 模板)。
5. 卸载残留:disabled 行 warn-and-skip 不致命(profile cordis.patch.yml:48-64 注释与实例)。
6. 跨插件配置继承风险:"默认继承 vision-toolkit 的 provider"= 读别人命名空间(dsh-vision-toolkit/lib/config.js:12)——其 schema 升级漂移会击穿你;且其 credential 是 CredentialRef 而非环境变量名(credentialRef('VISION_API_KEY') config.js:9,53)。建议:自有命名空间 + 首次运行逐字段拷贝默认值并本地固化;凭证一律走 credentials 服务引用。
7. 附带实证:exposure.js:42 就是"用了已移除 API + ?? 兜底吞错"的活案例——silently 死路径,零日志。

### 风险排序

1.【🔴 必改】ref 解析基于 exec.agent.session.events:该 API 已不存在,工具将 100% 解析失败。改 session.snapshotEvents()+ agent/created 回填。
2.【🔴 定调】放弃任何"中间件改写请求"形态:llm/stream 是冻结观察面,transform 线全封死——这正是"占位符+工具代读"应为主面的结构性理由。
3.【🟡 体验】auto"下一轮注入"首轮失明:改 agent/pre-step waterfall 同轮注入(超时回退),PromptContext 作低风险兜底;PromptContext 须消费后剪除。
4.【🟡 正确性】前缀解析四象限:只扫 user/message 不够;多命中消歧;compaction 后"模型不可见但事件可解析"是特性;fork 用全量日志而非 ownEvents。
5.【🔵 工程】inject 严格声明+静默 pending+fiber 重启+跨插件配置漂移:按④清单收敛;取图优先 readImageRequest() 字节直读。

总评:方向(占位符+工具代读为主、auto 为辅)与运行时结构吻合,予以同意;修正 events 访问器一处后,架构成立。

## 附录 B:库集成评审报告(全文)

（评审 B,只读,行号实测。**存档说明**:本附录为 2026-09-04 评审原文,其中 vitest/`vitest.config.ts` 等表述已被 §5.1 的 node:test 修订取代,仅作历史记录,不构成设计处方。）

### ① userRequest 契约 —— 收紧为"当前消息"

- AnalyzeParams={images,userRequest,sessionId,imagePaths?,targetModel?}(types.ts L70-76);8 段提示词含 user_request/user_request_answer,单问题作用域(prompts.ts L47-48),空请求有回退(prompts.ts L54)。多图每张用同一 userRequest 串行分析(vision-bridge.ts L114-125)。
- 结论: auto 模式 userRequest=当前 user 消息归一化文本(纯图粘贴传空走回退);不要取最近 N 条——缓存 key 含 userRequest(utils.ts L38),滑动窗让 key 每轮漂移,缓存全 miss+重复计费。
- 新发现(关键): DSH 对无 image 模态模型是"整条历史逐请求投影"占位符(dsh-llm/lib/index.js L1684-1690),旧图占位符每轮重现是常态。因此 auto 只由"新 user/message 图片事件"驱动;旧占位符重问一律走 tool 模式。fork 改 sessionId 使盘缓存 key "sessionId::imagePath"(vision-bridge.ts L328/342)miss;更优: 持久层改用内容寻址完整 attachmentId+问题哈希。
- 占位符契约缺口: 双形态(content.js L47-50 / L73-79)都要处理,前缀撞车返回候选列表;utils.normalizeUserRequest 只剥 [attached_image:...](utils.ts L17-22),DSH 的 "[image omitted...]" 不会被剥,插件必须先清洗否则污染缓存 key。
- 注入路径二选一: 库 injectIntoMessages 前置到 user 消息文本(vision-bridge.ts L130-177,幂等 guard L144);与"动态提示段注入"并存会双重注入。

### ② 缓存语义 —— 双层分裂是真问题

- 分析层 key=SHA256(mimeType+base64+归一化请求+provider:id)(utils.ts L28-42),同图异问 miss 正确;key 不含 capabilities/prompt 模式(小坑)。
- 主要缺陷: by-path 盘缓存完全不含问题(vision-bridge.ts L328)→ 重启/fork 后同图异问命中旧答案;且 _analyzeImage 只要传 imagePath 就写 by-path(L223-226)——tool 模式的回答会变成 auto 日后注入的"该图 note",双模式互相污染。更优: auto 按 attachmentId+问题哈希分 namespace;tool 只写分析 LRU 不写 by-path,或 key 加 questionHash。内存 _noteByPath 查找忽略 sessionId(L337)。
- FileCacheBackend 每次 set 同步全量重写 JSON(cache.ts L116-119、L150-164):与 CLI 同盘缓存目录会读改写竞态+阻塞事件循环;建议异步去抖写/按 key 分片+写时合并。

### ③ 适配器进程内调外部 VLM —— 工程缺口需补

- 超时: 两适配器内建 AbortController 默认 120s(openai-compatible.ts L48-49、anthropic.ts L57-58);auto 模式 120s 太长,插件应传配置 timeoutMs(建议默认 60000、上限 600000,对齐 toolkit config.ts L57/L89)。
- Bug: CallOptions.signal 声明了但两适配器都没接到 fetch(adapters/types.ts L9 vs openai L59 / anthropic L69)→ agent 销毁/回合中断无法取消在途调用;库内接线或插件包一层。
- 无重试: 429/5xx 立即抛(openai L62-64);建议插件层 2 次抖动退避;auto 模式失败必须吞掉只记日志,tool 模式返回 isError+可行动信息。
- 并发: analyze 对多图串行(vision-bridge.ts L114-125),最坏 N×timeout;建议插件级 in-flight 闸(toolkit 先例 concurrency 默认 4 上限 16)+同 key 在途去重。
- maxTokens 默认 1024(openai L45/anthropic L35)易截断结构化 JSON → extractJsonObject 兜底再失败 → formatInvalidStructuredNote 塞原始文本(formatters.ts L241-248);结构化模式建议 2048+。空响应 content||''(openai L68)会把空 note 缓存并注入——空响应应视为失败不缓存。
- VLM 输出是不可信证据: vision-context 注入与原始回显都要带 disclaimer(toolkit 先例 UNTRUSTED_EVIDENCE_NOTE, tools.ts L34)。anthropic 拼 baseURL+"/v1/messages"(L61)与 openai "/chat/completions"(L52)语义不同,schema 描述写清。anthropic.supportsImages 缺省 false(openai 缺省 true)不对称值得留意。

### ④ 缺 package.json 的最小补齐清单 —— 属实,阻塞项

- 根目录实测只有 docs/.tmp/dist/src/tests/node_modules: package.json、tsconfig.json、vitest.config.ts 全缺;node_modules 里 zod/express/@modelcontextprotocol/sdk 是 proxy/MCP 实验残留,src 十个文件只 import node:crypto/fs/path,"零运行时依赖"成立——不要声明它们。
- 最小清单: package.json{name,version,private:true,type:'module',engines node^22.19||>=24,exports,files,scripts{build:tsc,test:vitest run}} + devDeps{typescript,vitest,@types/node} + tsconfig。
- specifier 策略: A) 保持 .js 相对导入(现状)→ 必须 tsc 出 dist 再被插件消费;B) 改 .ts specifiers + toolkit 式 tsconfig(allowImportingTsExtensions+rewriteRelativeImportExtensions)。现状两头不靠,按现样 file: 引入必然 ERR_MODULE_NOT_FOUND。〔设计定稿:选 A〕
- file: 可移植性: plugin_install 走 pnpm 打包安装,file: 指向 profile 外路径本机可装、换机/注册表安装即断;file: 仅作本地开发桥,正式化应 vendor 进插件仓库或发包;files 字段必须含 dist。

### ⑤ Web 设置 provider schema —— 套 toolkit 成熟模式

- 模板=dsh-vision-toolkit/src/config.ts: ctx.settings.register(ns, Config, {base, applies:'live', validate})(toolkit src/index.ts L41-45) + settings.watch 原子换代、拒收保旧(L97-105) + resolveConfig 启动大声失败(config.ts L102-156)。
- 凭证照抄: credential 是 DSH CredentialRef,config.ts L53 默认 'VISION_API_KEY',L111 credentialRef() 校验,运行时 ctx.credentials.resolve 每次解析(runtime.ts L760/1711)。"继承 toolkit provider"更稳做法是默认 credential 名同名 'VISION_API_KEY'(零跨插件耦合共享同一凭证条目),baseUrl/model 继承做成显式开关。
- 桥特有字段: mode 'auto'|'tool'|'both'(默认 both)、cache{maxEntries:256, persistDir:<profile>/vision-bridge/cache}、timeoutMs(1000..600000 默认 60000)、concurrency(默认 2)、maxImageBytes/Pixels 对齐 toolkit、visionCapabilities{outputFormat 'auto'|hanako|gemini|qwen|anchor, boxOrder}、language 'zh'|'en'、autoMode 注入上限与标注策略。

### ⑥ modlens / vision-toolkit 删留边界 —— 两条表述需修正

- "桥可完全替代 modlens 读图角色": 反对"完全"。modlens 具备: 任意 path/URL 读图(SKILL.md L49)、全页 verbatim OCR(ocr.full_text+layout 顺序区域+语义+主色)、多 provider failover 链(L25-28)、guard/doctor 诊断、独立分层配置 ~/.modlens;而桥 visible_text 是"重要 OCR"选择性摘要+3200 字符截断(prompts.ts L44、formatters.ts L6),多模型 fallback 明确非目标(spec L157)。条件同意: 替代"会话附件代读"子角色成立;建议保留 modlens 承担"任意路径/URL 深读+全文 OCR"直到桥证明 OCR 等价;卸载 modlens 是独立迁移决策。注: screenshot-look skill 本身已走 vision-bridge CLI。
- "vision-toolkit 正交可保留": 部分同意。正交成立: crop/pixel_diff/dominant_colors/extract_foreground/html_screenshot/long_screenshot_ocr(PIL 本地确定性);不成立: vision_glance(tools.ts L175-196 明说 "with the configured vision model")与 ground/detect/trace(ground.py L31-38 走 VLM)与桥 tool 模式在工作区图片上重叠。结论: 保留 toolkit,但边界改写为分工(桥=会话附件 ref+auto 注入+会话级缓存; toolkit=工作区路径 VLM 工程操作+像素级 grounding+Artifacts),并落实 provider 配置继承,否则双 VLM 栈漂移。

### 风险排序 Top5

1(红) 占位符契约缺口: 双占位符形态+8hex 前缀碰撞+normalizeUserRequest 不剥 DSH 占位符 → 认错图/缓存 key 污染。
2(红) 库现状不可被插件加载: 缺 package.json/tsconfig 且 .js specifiers 无 dist——一切前提。
3(橙) 缓存双层语义分裂: 分析层(含问题) vs by-path 盘层(不含) → fork miss、重放注旧答案、tool/auto 互污染;同步全量重写竞态。
4(橙) 适配器工程缺口: signal 未接线不可取消、无重试、120s 默认超时、maxTokens 1024 截断 JSON、空响应被缓存、无并发闸/去重。
5(黄) 生态边界表述过强: modlens 非"可完全替代",toolkit 非完全正交 → 改为分工+继承配置。

总评: auto/tool 双模式、复用 toolkit provider、Web 设置模式方向正确,同意推进;先决: 补齐包工程并定 specifier 策略,修正占位符契约与缓存双层语义后再实现。