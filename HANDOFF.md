# dsh-vision-bridge 交接文档(HANDOFF)

> 交接时间:2026-09-07。给接手模型:先读完本文件再动手;仓库内 docs/design.md 是权威设计(含全部运行时事实的文件:行号证据),docs/VERIFY.md 是验收清单。

## 任务目标
DeepSeek Harness(DSH)web GUI 里,任何模型的会话都能 Ctrl+V 粘贴截图:
- 多模态模型 → 图片原生内联直读(已通,活体验证);
- 纯文本模型 → 图片入账后由运行时投影为占位符,dsh-vision-bridge 插件调 VLM 代读(tool / auto 双模式)。

## 环境与位置(本机)
- DSH portable 根:D:\DSH-Portable(web GUI http://127.0.0.1:3080;进程=node.exe 跑 dsh-web-launch.mjs;会话持久化,重启后自动恢复)
- 插件仓库(独立 git,已发布 GitHub:github.com/shenhuanageshei/dsh-vision-bridge,公开):D:\DSH-Portable\plugins\dsh-vision-bridge(master=c3b0d0c;local-history 分支=完整开发历史,含本机真实路径,勿推送)
- 安装副本(file: 依赖是复制不是链接;插件源码改动后必须同步这里,否则不生效):D:\DSH-Portable\profile\profiles\web\node_modules\@dsh-external\dsh-vision-bridge
- 权威设计文档:仓库 docs/design.md(快照)/ D:\DSH-Portable\docs\superpowers\specs\2026-09-04-dsh-vision-bridge-design.md(内部权威)
- bundled node:D:\DSH-Portable\node\node\node.exe(v24,node --test 零依赖可跑;zstd 可用)
- 注意:pnpm 不在 PATH(此前修复用的是某处自带 pnpm,位置未定位);改插件源码后同步安装副本用 robocopy /MIR(排除 .git 与 node_modules)或定位到 pnpm 再 install

## 已完成且验证过(勿重做)
1. 多模态声明:profile\settings.yaml 里 glm-5.3-flash / glm-5v-turbo 已声明 input:[text,image] → 截图原生内联直读,活体验证通过。
2. 插件 v0.1.1 已发布 GitHub(v0.1.1 tag/release;v0.1.0 坏发布已删):tool 模式 vision_bridge_read(仅收 {ref?,question?})、auto 模式(pre-step 同轮注入 + PromptContext 兜底 + 消费后剪除)、round-3 模态门禁(多模态会话零 VLM 浪费)、209 测试全绿(node --test)。
3. 服务端准入补丁(关键,已生效):核心包 dsh-api-session-controller 原本按会话当前模型拒带图 prompt(MODEL_DOES_NOT_SUPPORT_IMAGES),已惰性化为 if(false):
   - 副本1:profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js(原 :751 附近)
   - 副本2:同包 lib\types\commands.js(原 :301 附近)
   - 两处均有 .bak-vision-bridge 备份;重应用脚本:插件仓 scripts/patch-admission-gate.mjs(幂等)
   - DSH 更新会覆盖核心包 → 更新后必须重跑该脚本 + 重启 DSH
4. auto 迟到注入 + PromptContext 兜底:活体验证通过(9/5,vision-context 真实出现,UNTRUSTED 声明、一次性消费均正确)。

## 原卡点已解决(2026-09-07 活体取证结论)

**结论:当前代码无插件侧缺陷;§2 全链路已在全新浏览器页面活体验证通过。用户遇到的"粘贴完全无响应"是长期未刷新的 GUI 标签页内的陈旧客户端状态,硬刷新页面即恢复。**

### 活体取证证据链(2026-09-07 11:40–12:10,CDP 实挂全新 Chrome + token URL)
1. 全新页面 + 合成粘贴(DataTransfer 携带 file:image/png)→ PASTE_COMMAND 消费(defaultPrevented)→ 缩略图出现。客户端链路 PASTE_COMMAND→intakeFiles→intakeImages→addImages→createDraftImages 全部健康(dsh-client-ui-conversation/lib/client.js:14773-14787/15429-15440/16214-16223)。
2. **真实键盘 Ctrl+V**(CDP Input.dispatchKeyEvent,注意 modifier 位 Ctrl=2 而非 4)+ OS 剪贴板位图(PowerShell STA SetImage)→ paste 事件 items=[file:image/png] → 缩略图真实出现。
3. **§2 全链路**(文本-only 模型 glm-5.3 会话):粘贴 120×60 PNG → user/message 真实入账 image block(sha256:53c42ca9…)→ 模型 reasoning 原文引用占位符 "image was omitted because this model accepts text only" → 显式 tool/call vision_bridge_read{ref:"53c42ca9"}(seq 1491)→ tool/result 带 [UNTRUSTED EVIDENCE…] 头结构化描述且正确读出图中文字 PASTE-TEST-A(seq 1492)→ 模型正确作答。auto 模式 vision-context 同轮注入亦在同一会话首轮验证成功。
4. **glm-5.1(用户原始失败模型)粘贴同样成功**:切模型后粘贴,imageIds 2→3,缩略图出现。
5. 全量 node --test:209 pass / 0 fail。

### 根因定性(用户标签页为何全静默)
- 用户 GUI 标签页跨多日未硬刷新(9/3 20:54 客户端包 dsh-client-ui-conversation 更新、9/5-9/7 多次服务端重启/插件更新),页内运行的是陈旧 JS + 可能楔死的输入机状态;其失败期间会话日志零新增(粘贴未达服务端)与"客户端本地静默"一致。**修复动作 = 刷新 GUI 页面(F5)**。
- 取证中发现两个上游客户端静默分支(非本插件范围,已记录,不改核心包):
  - `shell.addImages` 在 input.phase=adjudicating/submitting 时返回 false,包装层静默 releaseDraftImages 且 return null,无任何 toast(client.js:11645-11651 + 16214-16223);
  - `maxImagesPerMessage=3` 超限时仅弹约 3s 的 toast,图片静默不入账(client.js:15434);草稿按会话持久化,滞留 3 张旧图后新贴图全部"看似无响应"。
- 间歇复现过一次"切模型后立即粘贴静默失败"(约 15s 内),与上述 phase/投影过渡窗口吻合;静置后恢复。

### 已排查证据链(9/7 前一段排查,结论已被上文取代但保留供追溯)
- 客户端粘贴处理器存在:dsh-client-ui-conversation\lib\client.js 的 PASTE_COMMAND handler(@547464 附近)→ clipboardData.items 过滤 kind==="file" → handlers.intakeFiles(files);无模型条件。
- intakeImages(@583597 附近)首行:if (addImages === void 0 || files.length === 0) return; —— 唯一静默返回点;其余分支最多 toast 报错(非静默)。
- addImages 由 inputHub inject 按 sessionId 提供(@615205 附近),sessionId 有值时恒有 addImages,无模型条件;inputHub.shell 本身也无模型条件。
- 服务端准入两副本均已打补丁(全 node_modules 枚举:仅这 2 处是准入闸;其余命中=错误码翻译/子代理路径/pi-ai 投影前置,均为正确行为)。
- 运行进程(9/7 09:42 启动)已加载补丁后代码(补丁落盘 9/6 11:33,早于启动);服务器日志无任何拒绝记录;粘贴尝试时段无任何会话日志新增 → 粘贴没有到达服务端,失败在客户端。

### 首要怀疑(按顺序)
1. composer 锁死:intakeImages 与 pasteText 都在 gate.current.machineBusy || gate.current.locked 时静默返回(client.js @584973 键映射)。glm-5.1 测试会话可能卡在一个僵死 running turn(早前被准入拒绝的发送可能把 turn 状态卡住)。验证:该会话输入框是否显示停止按钮/不可输入?→ 刷新页面 / 中断运行回合 / 新建会话再试。新会话可直接粘贴 = 此因坐实。
2. 若新会话仍无响应:用 CDP 浏览器调试实挂 GUI(localhost:3080,注意 401 鉴权),在 PASTE_COMMAND handler 与 intakeImages 处下断点,定位真实返回路径;或检查 addImages 是否为 undefined(inputHub.inject 的 sessionId 是否为空)。
3. 剪贴板 MIME:让用户用 Win+Shift+S 新抓像素再贴(排除复制文件引用导致的 kind!=="file")。

## 修复完成的判定
docs/VERIFY.md §1-§7 逐条(§1/§3 迟到路径已活体验证;§2 是当前卡点;其余常规)。

## 约束与坑
- 不改 node_modules 其它核心包逻辑(准入补丁除外;已登记,更新后重应用)
- 插件源码改动 → 同步安装副本 → 重启 DSH web 才生效
- package.json 曾因「limit:5 有界读+整文件写回」被截断(5821602 事故,已修复于 6ed206f)——对 JSON 做字段级修改时用定点替换,改完用 node 严格解析验证
- 不推送 local-history 分支;GitHub 是公开仓;凭证只走 CredentialRef 名,绝不落明文