# VERIFY — dsh-vision-bridge 人工验收清单（设计 §7 七条）

权威依据：`docs/design.md(本仓内快照)` §7。
接线已写好但**本交付不重启 DSH web、不执行 profile pnpm install**（硬约束⑦）——以下第 0 步完成后逐条人工验证。

## 0. 安装与挂载（先决）

1. ```powershell
   cd <DSH_HOME>\profile
   pnpm install
   ```
   （`@dsh-external/dsh-vision-bridge` 经 `file:../../../plugins/dsh-vision-bridge` 进 profile 依赖闭包。**这一步不可省**——2026-09-05 曾因加了依赖没跑 install,启动即 `cannot resolve profile bundle` 三连崩;且 file: 依赖是复制不是链接,此后每次改 `plugins/dsh-vision-bridge/` 源码都要重跑本步(或手动同步 `profile/profiles/web/node_modules/@dsh-external/` 副本)才生效。挂载由插件自带 cordis.patch.yml 完成,**不要再往 `profile/cordis.patch.yml` 手动加同名 insert 行**(duplicate loader entry id 同样崩启动);覆盖配置走 settings.yaml 的 `vision-bridge:` 键。）
2. 重启 DSH web。
3. 启动日志检查：无 `cannot get property "x" without inject`；无 `vision-bridge` 相关 error/warn（除预期的 info 行
   `vision-bridge: first run — froze provider defaults …` 或 `configuration applied live`）。
4. 首运行固化检查：`<DSH_HOME>\vision-bridge\provider-defaults.json` 生成（本 profile 已在 settings.yaml 显式给出
   provider，固化文件内容与之一致）。
5. 设置页（Web → Settings）出现 **vision-bridge** 命名空间，字段与 §5.7 一致（mode/provider/credential/timeoutMs/
   concurrency/cache/maxImageBytes/maxImagePixels/visionCapabilities/language/autoMode）。
6. 缓存目录 `<DSH_HOME>\vision-bridge\cache\` 在首次分析后出现 `tool.json` / `auto.json`。

## 1. 多模态模型声明 image 后原样直读

1. settings.yaml 中 `llm-pi-ai.providers.zai-coding-cn.models` 的 `glm-5.3-flash` 与 `glm-5v-turbo` 已声明
   `input: [text, image]`（本次交付已完成；重启后生效）。
2. 会话选择 glm-5.3-flash，粘贴一张截图并发问"这张图里有什么？"
3. 预期：模型直接描述图片内容；会话不出现 `UNSUPPORTED_CONTENT`；请求管线无 vision-bridge 工具调用。
4. 反向确认：切到未声明 image 的模型（如 glm-5.1）重复粘贴，模型消息里出现
   `[image omitted … attachment sha256:xxxxxxxx]` 占位符（投影生效）。

## 2. 文本-only 模型：tool 模式代读 + 多命中候选

1. **服务端准入规则**：当前模型不支持图像时，带图 prompt 会在服务端被拒
   （`MODEL_DOES_NOT_SUPPORT_IMAGES`，dsh-api-session-controller:751），因此文本-only 会话**无法直接附图**。
   正确步骤：
   a. 把会话模型切到支持图像的模型（如 glm-5.3-flash），用回形针附件按钮附图并发送；
   b. 把会话模型切回文本-only 模型（如 glm-5.1）；
   c. 发送文字问题（如"刚才那张图里的报错是什么？"）——历史图投影为占位符，进入桥的 tool 模式。
   （另：web 客户端输入框暂不支持 Ctrl+V 直接粘贴图片，与模型无关；附图一律用回形针按钮。）
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

> 定位说明：受服务端准入规则（见 §2）与 auto 模态门禁（round-3）双重约束，auto 的触发条件在常规流程中不可自然发生，
> 现实定位为**防御性兜底**（上游准入策略放开或程序化注入图片时生效）；文本-only 会话的主路径是 §2 的 tool 模式。
> 本节步骤用于在约束放宽后回归验证，也可用注入桩在单测层验证（tests/auto.test.mjs 已覆盖）。

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

1. Web 设置页改 `provider.model` → 无需重启，下一次工具调用/自动分析即用新模型
   （缓存指纹随 model 变化，自然 miss）。
2. `mode` 在 tool ↔ auto ↔ both 间切换 → 立即生效（gate 每事件/每步实时判定）：
   切到 tool 后贴图不再触发自动分析；切回 both 恢复。
3. `provider.credential` 指向另一已配置凭证名 → 下一次调用即用新凭证（per-operation resolve，无重启、无缓存）。

## 附：自动化测试

- 插件根：`node --test`（196+ 用例；含 vendor 引擎库 108 例）。
- 真实调用冒烟：设置 `VISION_BRIDGE_SMOKE=1`、`VISION_BRIDGE_SMOKE_BASEURL`、`VISION_BRIDGE_SMOKE_MODEL`、
  `VISION_BRIDGE_SMOKE_KEY` 后运行 `node --test tests/smoke.test.mjs`。
- 用例 × 验收映射：`tests/TEST-MATRIX.md`。