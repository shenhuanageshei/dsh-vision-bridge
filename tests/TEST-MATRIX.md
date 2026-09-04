# 测试矩阵 — 设计 §7 验收标准 × 测试映射

运行：插件根目录 `node --test`（零依赖 node:test；递归含 vendor 测试）。
真实调用冒烟：`VISION_BRIDGE_SMOKE=1 VISION_BRIDGE_SMOKE_BASEURL=… VISION_BRIDGE_SMOKE_MODEL=… VISION_BRIDGE_SMOKE_KEY=… node --test tests/smoke.test.mjs`。

| 验收/故事 | 正常 | 边界 | 错误 | 用例（文件） |
|---|---|---|---|---|
| 验收2 文本-only 模型占位符 → tool 代读 | 8-hex 前缀解析→描述 | `latest` 默认；多命中候选列表 | 坏 ref/未知 ref → isError+可行动信息 | resolve.test.mjs（findImage 前缀/多命中/精确优先/latest）；tools.test.mjs（bad ref/unknown ref/ambiguous/无图会话） |
| 双占位符形态 | text-only 形态 | offloaded 形态 | — | resolve.test.mjs（stripPlaceholders 两种形态 + placeholderPrefixes） |
| 扫描范围：user/message + tool/result、fork 全量、compaction 影子 | user/message 图 | tool/result 嵌套图 | — | resolve.test.mjs（contentHasImage 对齐/fork 前缀/compaction 影子节点保留） |
| 验收4 resume/fork 后旧图可解析 | snapshotEvents 全量扫 | constructor seed 不发事件 → agent/created 回填 | — | auto.test.mjs（backfill 计数）；tools.test.mjs（事件数组即全量日志） |
| 验收3 auto 同轮注入 | fast path 注入 <vision-context> | slow path 超时放行 → PromptContext 一次性兜底 | failed path 只记日志 | auto.test.mjs（fast/slow/failed/sync-registration/multi-message/maxPerTurn） |
| 回合取消 → 在途调用中止（**仅附件读取**） | 附件读取中止：tool=exec.signal、auto=pre-step 联动 abort | 已取消回合孤儿分析中止 | — | auto.test.mjs + tools.test.mjs（取消断言覆盖 readImageRequest 的 signal）；adapter-wrapper.test.mjs（wrapper 自身的 fetch 级 signal 接线/退避期取消——直连调用可取消）。**已知边界**：经引擎 `analyze()` 公开 API 的 VLM HTTP 调用与重试退避**不可取消**（`AnalyzeParams` 不收 signal，包装层无法把信号传入引擎内部的 adapter.call；受不改库源码约束）——上游库为 analyze 增加 signal 透传后可根治 |
| 超限（字节/像素/每轮条数） | readImageRequest 策略透传（maxPixels/maxBytes） | — | maxPerTurn 截断告警 | settings-lifecycle.test.mjs（policy 断言）；auto.test.mjs（maxPerTurn cap） |
| 验收5 缓存不串答案 | 同图同问命中 | 同图异问必 miss；tool/auto 分 namespace | — | cache-backend.test.mjs（key 组成面/namespace 隔离/LRU/TTL/损坏降级）；tools.test.mjs（命中不再调 VLM） |
| 空 VLM 响应 | — | — | 视为失败不缓存 | adapter-wrapper.test.mjs（EmptyResponseError/不重试）；tools.test.mjs（空响应 isError） |
| 凭证错配/缺失 | per-operation resolve | — | 缺失 → 可行动错误不缓存 | settings-lifecycle.test.mjs（missing credential） |
| 验收6 fiber 重启可重建 | apply 全状态闭包内重建 | disposer 冲刷缓存 | 拒收保旧（watch 校验失败保旧代） | settings-lifecycle.test.mjs（register/validate/watch/disposer） |
| 验收7 设置即改即生效 | watch 重建 + live gate | mode 每事件/每步实时判定 | 校验失败拒收 | settings-lifecycle.test.mjs（update 拒收断言）；config.test.mjs（resolveConfig 校验面） |
| §5.6 适配器工程缺口 | signal 接线（库 bug 补修） | 2× 抖动退避重试（429/5xx/网络） | 4xx 不重试；3 次封顶 | adapter-wrapper.test.mjs（全矩阵） |
| 结构化 maxTokens≥2048 | structured 构造级开关 | — | — | adapter-wrapper.test.mjs（max_tokens 断言） |
| 真实调用冒烟（方法论） | 真 VLM 一问一答 | — | — | smoke.test.mjs（环境变量门控） |
| 引擎库（vendor）自身 | 108 用例随插件套件运行 | — | — | vendor/vision-bridge/tests/*.test.mjs（8 个 vitest 文件的 node:test 移植） |
