window.__ModuleLoader__.load({
    id: "@dsh-external/dsh-vision-bridge",
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        const react = require("react");

        // Browser half of dsh-vision-bridge (design §10.3B + §11): one card in
        // the Plugins settings page over the `vision-bridge` settings
        // namespace — three groups (vision engine / trigger & output /
        // collapsed advanced), provider linkage against the projected
        // llm-pi-ai providers, the three credential forms (linked /
        // stored-entry / paste-new-key), a connectivity probe, and the
        // environment-check panel with its two one-click fixes. Plain
        // JavaScript only — no JSX, no TypeScript, no build step. The factory
        // body has zero side effects; everything mounts in apply(ctx).

        const name = "@dsh-external/dsh-vision-bridge";
        // Only faces BOTH generations provide are declared: a declared face a
        // generation never provides keeps this fiber pending forever (the
        // 0.1.7 break this batch fixes). Every settings face is instead read
        // lazily through `ctx.get` (see `readService` below).
        const inject = ["slots", "locale"];

        const SETTINGS_NS = "vision-bridge";
        const LOCALE_NS = "vision-bridge-ui";
        // The 0.1.6-only card slot — last rung of the ladder; 0.1.7 has no such
        // slot (registering it there throws), so it must never be assumed.
        const LEGACY_SLOT_NAME = "settings.plugin.item";
        const CARD_ID = "vision-bridge";
        // A keyed `plugins.row.config` cell is keyed by the package name, a "#"
        // separator and the row id; the bundle patch mounts this plugin as the
        // `vision-bridge` row.
        const ROW_KEY = name + "#" + CARD_ID;
        // `plugins.item` is a list slot: `id` picks the cell, `order` its rank
        // (the official card precedent agent-loop uses 20).
        const CARD_ORDER = 40;
        // Wake-up for lazily read services: `ctx.get` offers no arrival event,
        // so a late service is discovered by a bounded poll (implementation
        // decision — the design fixes lazy per-operation resolution, not how a
        // late arrival is noticed).
        const WAKEUP_INTERVAL_MS = 500;
        const WAKEUP_ATTEMPTS = 40;
        const MAX_PROMPT_EXTRA = 2000;
        const DEFAULT_CREDENTIAL_NAME = "VISION_API_KEY";
        const CUSTOM_PROVIDER = "__custom";
        const PASTE_CREDENTIAL = "__paste";
        const MANUAL_CREDENTIAL = "__manual";

        const css = `
.dvb-card{display:grid;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-fg-primary,#26231f)}
.dvb-card h3{margin:0;font-size:13px}
.dvb-card p{margin:0;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.5}
.dvb-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dvb-badge{padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);border:1px solid var(--dsw-alias-border-subtle,#dedbd5);font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}
.dvb-badge-ok{background:rgba(72,143,84,.12);border-color:rgba(72,143,84,.35);color:#2f6d3a}
.dvb-headrow{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.dvb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.dvb-field{display:grid;gap:4px;align-content:start}
.dvb-field label{font-size:11px;color:var(--dsw-alias-fg-muted,#77736d)}
.dvb-field input,.dvb-field select,.dvb-field textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:inherit;font:inherit}
.dvb-field textarea{resize:vertical;min-height:64px}
.dvb-field[data-invalid=true] input,.dvb-field[data-invalid=true] textarea{border-color:#c34f4f}
.dvb-wide{grid-column:1/-1}
.dvb-count{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}
.dvb-hint{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.4}
.dvb-hint-error{color:#c34f4f;font-weight:600}
.dvb-error{padding:8px 10px;border-radius:8px;background:rgba(205,72,72,.1);color:#aa3939}
.dvb-muted{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:var(--dsw-alias-fg-muted,#77736d)}
.dvb-group{display:grid;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px}
.dvb-group-head{font-size:11px;font-weight:600;letter-spacing:.02em}
.dvb-group-engine[data-custom="true"]{border-color:#8a7ce8}
.dvb-group-engine[data-custom="true"] input,.dvb-group-engine[data-custom="true"] select{border-color:#8a7ce8}
.dvb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dvb-actions button{padding:6px 14px;border-radius:999px;border:0;background:#6758d4;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.dvb-actions button:disabled{opacity:.55;cursor:default}
.dvb-actions .dvb-reset{background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:var(--dsw-alias-fg-primary,#26231f);border:1px solid var(--dsw-alias-border-subtle,#dedbd5)}
.dvb-mini{padding:4px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:var(--dsw-alias-fg-primary,#26231f);font:inherit;font-weight:600;cursor:pointer}
.dvb-mini:disabled{opacity:.55;cursor:default}
.dvb-cred-mark{font-size:10px;font-weight:600}
.dvb-cred-ok{color:#2f6d3a}
.dvb-cred-miss{color:#a05a16}
.dvb-mono{font-family:ui-monospace,Consolas,monospace}
.dvb-adv-toggle{display:flex;gap:6px;align-items:center;padding:4px 2px;border:0;background:none;color:var(--dsw-alias-fg-muted,#77736d);font:inherit;font-size:11px;cursor:pointer}
.dvb-env{display:grid;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px}
.dvb-env-head{display:flex;gap:8px;align-items:center;justify-content:space-between}
.dvb-env-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dvb-env-row .dvb-row-text{flex:1;min-width:200px}
.dvb-ok{color:#2f6d3a}
.dvb-warn{color:#a05a16;font-weight:600}
.dvb-unknown{color:var(--dsw-alias-fg-muted,#77736d)}
.dvb-explain{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:var(--dsw-alias-fg-muted,#77736d);line-height:1.5;font-size:11px}
.dvb-fixmsg{font-size:11px}
.dvb-testline{font-size:11px;line-height:1.4}
@media(max-width:720px){.dvb-grid{grid-template-columns:1fr}}
`;

        function installStyles() {
            const id = "@dsh-external/dsh-vision-bridge/client";
            const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`);
            if (existing !== null) return () => { };
            const tag = document.createElement("style");
            tag.dataset.plugin = "@dsh-external/dsh-vision-bridge";
            tag.dataset.pluginCss = id;
            tag.textContent = css;
            document.head.appendChild(tag);
            return () => { tag.remove(); };
        }

        const en = {
            cardTitle: "dsh-VisionBridge Vision Read",
            description: "Session screenshots are read by a vision-language model for text-only chats (tool, auto, or both).",
            badgeConnected: "Connected ✓",
            groupEngine: "Vision engine",
            groupTrigger: "Trigger and output",
            groupAdvanced: "Advanced (output format · timeout · concurrency · per-turn cap)",
            provider: "Provider",
            providerCustom: "Custom",
            customModeHint: "Custom endpoint — fill Base URL, model and credential by hand.",
            providerBaseURL: "Base URL",
            providerModel: "Model",
            providerPlaceholder: "Leave empty = first-run frozen default",
            baseURLManualHint: "This provider declares no Base URL in settings.yaml — fill it in manually.",
            testConnection: "Test connection",
            testing: "⏳ Testing…",
            testOk: "✓ Connected",
            testFail: "✗ Failed",
            testLatency: "latency",
            testErrorAuth: "credential rejected (401)",
            testErrorEndpoint: "endpoint not found (404)",
            testErrorTimeout: "timed out",
            testErrorUnknown: "unknown error",
            testErrorNetwork: "route unreachable",
            credential: "Credential reference",
            credentialHint: "Stored DSH credential name holding the API key (a name, not the key itself).",
            credentialConfigured: "configured",
            credentialNotConfigured: "not configured",
            credentialSourceLabel: "source",
            credentialFromProvider: "provider",
            credentialPasteOption: "Paste a new API key…",
            credentialManualOption: "Enter a credential name…",
            credentialKeyName: "Entry name",
            credentialKeyLabel: "API key",
            credentialKeyPlaceholder: "sk-…",
            credentialPasteHint: "Saving stores it through the DSH credential service; the key never lands in this plugin's settings.",

            credentialEmptyKey: "Paste the API key first, or choose a different credential option.",
            credentialWriteFailed: "Credential write failed",
            credentialCheckOk: "✓ configured",
            credentialCheckMissing: "✗ not configured",
            mode: "Mode",
            modeHint: "tool: the model calls vision_bridge_read. auto: analyze pasted images and inject same-turn. both: both.",
            language: "Answer language",
            promptExtra: "Extra instructions",
            promptExtraHint: "Appended to every vision read; empty = none. Changing it invalidates cached answers.",
            promptExtraTooLong: "Keep it within 2000 characters.",
            outputFormat: "Output format",
            timeoutMs: "Timeout (ms)",
            concurrency: "Concurrency",
            maxPerTurn: "Auto images per message",
            save: "Save",
            saving: "Saving…",
            savedFlash: "✓ Saved",
            reset: "Reset",
            saveRejected: "The save was rejected (likely an invalid value); the previous configuration keeps serving. Your draft is kept.",
            invalidDraft: "Fix the highlighted fields before saving.",
            invalidNumber: "Enter a number, or leave empty for the default.",
            readOnly: "Settings are read-only right now.",
            loading: "Loading configuration…",
            settingsUnavailable: "This kernel does not expose a settings surface — edit the profile row configuration instead.",
            credentialsUnavailable: "Credential service unavailable — stored credentials cannot be listed or written right now.",
            envTitle: "Environment check",
            envRecheck: "Re-check",
            envLoading: "Checking…",
            envFailed: "Check failed — retry.",
            envReady: "✓ Environment ready — nothing to do.",
            connRow: "Connectivity",
            connUnverified: "unverified — press “Test connection”.",
            connOk: "endpoint reachable, credential valid",
            admissionOk: "Admission patch active",
            admissionMissing: "Admission patch not applied",
            admissionUnknown: "Admission patch state unknown",
            admissionLive: "Disk repaired — takes effect after a restart",
            admissionLiveExplain: "This DSH process loaded the core admission gate before the repair landed, and an already-loaded module keeps running its old code. The disk state is clean, so the NEXT start is fixed — restart the DSH web GUI to pick it up.",
            admissionUnverified: "Admission patch on disk — runtime state unverified",
            admissionUnverifiedExplain: "The patch marker is on disk, but this deployment has no runtime probe wired (VISION_BRIDGE_ADMISSION_PROBE), so the gate the running process holds could not be observed. The card therefore does not claim ✓.",
            admissionExplain: "By default, text-only sessions reject messages that carry images, so pasted screenshots would never enter the chat log. The local admission patch lets them in — the runtime then turns them into placeholders this bridge reads. A DSH core update overwrites the patch; re-apply it here afterwards.",
            seamRow: "Runtime seam",
            seamLive: "Runtime seam live — every model can receive images",
            seamLiveExplain: "The plugin decorates the in-process llm.resolveModelInfo service method, so the admission gate lets a text-only model’s image prompt through; the runtime still turns the image into the standard placeholder this bridge reads. Nothing is written to disk, and disabling the plugin restores the stock behaviour.",
            seamUnproven: "Runtime seam installed — behaviour not self-verified",
            seamUnprovenExplain: "The decoration is in place, but this deployment could not prove it works (no text-only route to probe, the route was excluded by seam.include, the reader is not configured, or the check timed out). That is deliberately NOT a ✓ — the server reason is shown next to the label.",
            seamOff: "Runtime seam disabled (seam.mode = off)",
            seamOffExplain: "The seam is switched off, so the stock admission gate applies again: text-only sessions reject messages that carry images. Clear seam.mode (or set it to auto) to restore the bridge.",
            seamUnsupported: "Runtime seam unavailable",
            seamUnsupportedExplain: "The llm service was not found, or it refuses the decoration (frozen instance, or no resolveModelInfo method). Image prompts from text-only models keep the stock hard rejection. Nothing is written to disk either way.",
            seamUnknown: "Runtime seam state unknown",
            seamReason: "reason: ",
            markerRow: "Marker residue",
            markerOk: "Marked and behaviour agree — no residue",
            markerResidue: "Marker present — behaviour self-proof failed",
            markerResidueHint: "the mark is there, the seam is not proven live",
            markerResidueExplain: "A mark from an earlier installation can outlive the seam itself — the \"already installed\" false positive this row exists for. The host surface exposes no \"reinstall seam\" action, so recover by reloading the plugin or restarting DSH; the next load installs over the residue.",
            markerAbsent: "Seam not installed — nothing left behind",
            readerRow: "Reader availability",
            readerOk: "Reader configuration available — connectivity not verified",
            readerOkExplain: "Endpoint, model and credential are set, so the seam is allowed to inject. This is configuration availability, not connectivity: the first real read may still fail, and auto mode logs that instead of blocking the turn.",
            readerMissing: "Reader not configured — the seam keeps the hard rejection",
            readerMissingExplain: "The vision credential is not configured, so the seam deliberately does NOT inject (seam.requireReader): a pasted screenshot is rejected up front instead of being sent to a model that nobody will read it for.",
            readerEndpointUnset: "Credential ok — endpoint/model left to the frozen first-run defaults",
            readerUnknown: "Reader configuration unchecked",
            readerUnknownExplain: "The credential service does not report on this reference here (unavailable, or no check has run yet), so availability cannot be claimed either way.",
            readerOff: "Not applicable — the runtime seam is off",
            readerDisabled: "Precondition disabled (seam.requireReader = false)",
            readerDisabledExplain: "With the precondition off the seam injects even when no reader is configured: a screenshot can be accepted while nothing reads it.",
            legacyRow: "Disk patch (legacy)",
            legacySuperseded: "Not applicable to this deployment — superseded by the runtime seam",
            legacySupersededExplain: "This deployment’s core packages live in an immutable resource tree (app.asar), so the local disk patch cannot be applied — and it is no longer needed: the runtime seam does the job in memory. The disk patch stays for portable / older kernels.",
            modlensOk: "No modlens paste conflict",
            modlensConflict: "modlens paste conflict",
            modlensUnknown: "modlens state unknown",
            modlensExplain: "The modlens plugin can take over image pastes (turning them into temp-file paths) before this bridge ever sees them. One-click-off disables only the paste takeover — modlens keeps its other abilities. Takes effect after a DSH web restart.",
            fixAdmission: "Fix now",
            fixModlens: "Turn off",
            fixApplied: "Applied — restart the DSH web GUI for it to take effect.",
            fixAlready: "Already in the desired state.",
            fixFailed: "Action failed",
            explainToggle: "Details",
        };

        const zh = {
            cardTitle: "dsh-VisionBridge 视觉代读",
            description: "纯文本模型的会话截图由视觉模型代读（tool / auto / both 三种触发模式）。",
            badgeConnected: "已连接 ✓",
            groupEngine: "视觉引擎",
            groupTrigger: "触发与输出",
            groupAdvanced: "高级设置（输出格式 · 超时 · 并发 · 每轮上限）",
            provider: "Provider",
            providerCustom: "自定义",
            customModeHint: "自定义端点——Base URL、模型与凭证均手动填写。",
            providerBaseURL: "Base URL",
            providerModel: "模型",
            providerPlaceholder: "留空 = 使用首运行固化默认",
            baseURLManualHint: "此 Provider 未在 settings.yaml 声明 Base URL——请手动填写。",
            testConnection: "验证连通",
            testing: "⏳ 验证中…",
            testOk: "✓ 连通",
            testFail: "✗ 失败",
            testLatency: "延迟",
            testErrorAuth: "凭证无效或未配置（401）",
            testErrorEndpoint: "端点不可达（404）",
            testErrorTimeout: "请求超时",
            testErrorUnknown: "未知错误",
            testErrorNetwork: "路由不可达",
            credential: "凭证引用名",
            credentialHint: "DSH 凭证条目名（存 API Key 的名字，不是密钥本身）。",
            credentialConfigured: "已配置",
            credentialNotConfigured: "未配置",
            credentialSourceLabel: "来源",
            credentialFromProvider: "来自",
            credentialPasteOption: "粘贴新 API Key…",
            credentialManualOption: "输入凭证条目名…",
            credentialKeyName: "条目名",
            credentialKeyLabel: "API Key",
            credentialKeyPlaceholder: "sk-…",
            credentialPasteHint: "保存时经 DSH 凭证服务自动创建条目，密钥不落本插件配置。",

            credentialEmptyKey: "请先粘贴 API Key，或改选其它凭证方式。",
            credentialWriteFailed: "凭证写入失败",
            credentialCheckOk: "✓ 已配置",
            credentialCheckMissing: "✗ 未配置",
            mode: "触发模式",
            modeHint: "tool：模型调用 vision_bridge_read；auto：贴图自动代读并当轮注入；both：两者兼用。",
            language: "回答语言",
            promptExtra: "附加指令",
            promptExtraHint: "附加在每次代读请求之后；留空 = 无。修改后旧缓存答案自然失效。",
            promptExtraTooLong: "请控制在 2000 字符以内。",
            outputFormat: "输出格式",
            timeoutMs: "超时（毫秒）",
            concurrency: "并发上限",
            maxPerTurn: "每条消息自动分析上限",
            save: "保存",
            saving: "保存中…",
            savedFlash: "✓ 已保存",
            reset: "重置",
            saveRejected: "保存被拒绝（可能是非法值）；旧配置继续生效，草稿已保留。",
            invalidDraft: "请先修正标红的字段再保存。",
            invalidNumber: "请输入数字，留空使用默认值。",
            readOnly: "当前设置只读。",
            loading: "正在读取配置…",
            settingsUnavailable: "此内核不暴露设置面——请直接改 profile 行配置。",
            credentialsUnavailable: "凭证服务不可用——暂时无法列出或写入凭证条目。",
            envTitle: "环境体检",
            envRecheck: "重新检测",
            envLoading: "正在检测…",
            envFailed: "检测失败，请重试。",
            envReady: "✓ 环境就绪，无需操作。",
            connRow: "连通",
            connUnverified: "未验证——点「验证连通」。",
            connOk: "端点可达，凭证有效",
            admissionOk: "准入补丁已生效",
            admissionMissing: "准入补丁未生效",
            admissionUnknown: "准入补丁状态未知",
            admissionLive: "已修复磁盘，重启后生效",
            admissionLiveExplain: "本次启动在修复落盘之前就已加载核心准入闸，而已加载的模块会继续运行旧代码。磁盘已是干净态，所以下一次启动必然修复——重启 DSH web 即可生效。",
            admissionUnverified: "准入补丁已写入磁盘——运行时状态未验证",
            admissionUnverifiedExplain: "补丁标记已在磁盘上，但本部署未接运行时探针（VISION_BRIDGE_ADMISSION_PROBE），无法观测正在运行的闸，因此不显示 ✓。",
            admissionExplain: "默认情况下，纯文本模型会话会拒收带图消息，粘贴的截图根本进不了会话记录。本地准入补丁放行图片入账，运行时把它们转成占位符，再由本插件代读。DSH 更新核心包会覆盖补丁，届时在这里重新应用即可。",
            seamRow: "运行时缝",
            seamLive: "运行时缝已生效——任何模型都能收图",
            seamLiveExplain: "插件在进程内装饰了 llm.resolveModelInfo 服务方法，准入闸因此放行纯文本模型的带图消息；运行时照旧把图片换成标准占位符，再由本插件代读。全程不写磁盘，停用插件即恢复原样。",
            seamUnproven: "运行时缝已安装——行为自证未通过",
            seamUnprovenExplain: "装饰已就位，但本部署无法证明它生效（没有可探测的纯文本路由、该路由被 seam.include 排除、代读未配置，或自证超时）。这里刻意不显示 ✓——具体原因就显示在标签旁。",
            seamOff: "运行时缝已关闭（seam.mode = off）",
            seamOffExplain: "缝已关闭，回到内核自带的准入闸：纯文本会话重新拒收带图消息。把 seam.mode 清空（或设为 auto）即可恢复。",
            seamUnsupported: "运行时缝不可用",
            seamUnsupportedExplain: "没找到 llm 服务，或它拒绝被装饰（实例被冻结、没有 resolveModelInfo 方法）。纯文本模型的带图消息继续被硬拒绝；两种情况下都不写磁盘。",
            seamUnknown: "运行时缝状态未知",
            seamReason: "原因：",
            markerRow: "标记残留",
            markerOk: "标记与行为一致，无残留",
            markerResidue: "标记在、行为自证未通过",
            markerResidueHint: "标记在，但缝未自证生效",
            markerResidueExplain: "早先某次安装留下的标记可能比缝本身活得更久——这正是本行要防的「报 already 其实没装」假阳性。宿主面没有提供「重装缝」动作，请重新加载插件或重启 DSH 恢复；下一次加载会在残留之上重新安装。",
            markerAbsent: "缝未安装，没有可残留的东西",
            readerRow: "代读可用性",
            readerOk: "代读配置可用——未验证连通",
            readerOkExplain: "端点、模型与凭证都已填写，因此允许缝放行。这是「配置可用」而不是「运行可用」：第一次真实调用仍可能失败，auto 模式会把失败记进日志而不阻塞回合。",
            readerMissing: "代读未配置——缝按设计保持硬拒绝",
            readerMissingExplain: "视觉凭证未配置，因此缝刻意不注入（seam.requireReader）：粘贴的截图会被当场拒绝，而不是「发送成功却没人看过这张图」。",
            readerEndpointUnset: "凭证已配置——端点/模型留空，将使用首运行固化默认",
            readerUnknown: "代读配置未检查",
            readerUnknownExplain: "凭证服务对本引用没有给出描述（服务不可用，或尚未检查），因此不能作出任何可用性判断。",
            readerOff: "不适用——运行时缝已关闭",
            readerDisabled: "前置条件已关闭（seam.requireReader = false）",
            readerDisabledExplain: "前置条件关闭后，即使代读未配置缝也会注入：截图可能被放行而无人阅读。",
            legacyRow: "磁盘补丁（遗留）",
            legacySuperseded: "对本部署不适用——已被运行时缝取代",
            legacySupersededExplain: "本部署的核心包位于不可变资源树（app.asar）内，本地磁盘补丁打不进去——而且已经不需要：运行时缝在内存里完成了同样的工作。磁盘补丁仍保留给便携版/旧内核。",
            modlensOk: "modlens 无粘贴冲突",
            modlensConflict: "modlens 粘贴冲突",
            modlensUnknown: "modlens 状态未知",
            modlensExplain: "modlens 插件的粘贴接管会在本插件看到图片之前把贴图截走（转成临时文件路径）。「一键关闭」只关粘贴接管，modlens 其余能力不受影响；重启 DSH web 后生效。",
            fixAdmission: "一键修复",
            fixModlens: "一键关闭",
            fixApplied: "已应用，重启 DSH web 后生效。",
            fixAlready: "已是目标状态。",
            fixFailed: "操作失败",
            explainToggle: "说明",
        };

        // One card field: flat id (React key + edit() argument) → settings path.
        const FIELDS = [
            { id: "baseURL", path: ["provider", "baseURL"], kind: "text", labelKey: "providerBaseURL", placeholderKey: "providerPlaceholder" },
            { id: "model", path: ["provider", "model"], kind: "text", labelKey: "providerModel", placeholderKey: "providerPlaceholder" },
            { id: "credential", path: ["credential"], kind: "text", labelKey: "credential", hintKey: "credentialHint" },
            { id: "mode", path: ["mode"], kind: "select", labelKey: "mode", hintKey: "modeHint", options: ["tool", "auto", "both"] },
            { id: "language", path: ["language"], kind: "select", labelKey: "language", options: ["zh", "en"] },
            { id: "promptExtra", path: ["promptExtra"], kind: "textarea", labelKey: "promptExtra", hintKey: "promptExtraHint" },
            { id: "outputFormat", path: ["visionCapabilities", "outputFormat"], kind: "select", labelKey: "outputFormat", options: ["auto", "hanako", "gemini", "qwen", "anchor"] },
            { id: "timeoutMs", path: ["timeoutMs"], kind: "number", labelKey: "timeoutMs" },
            { id: "concurrency", path: ["concurrency"], kind: "number", labelKey: "concurrency" },
            { id: "maxPerTurn", path: ["autoMode", "maxPerTurn"], kind: "number", labelKey: "maxPerTurn" },
        ];
        const FIELD_BY_ID = new Map(FIELDS.map((field) => [field.id, field]));

        function readPath(root, path) {
            let current = root;
            for (const key of path) {
                if (current === null || typeof current !== "object") return undefined;
                current = current[key];
            }
            return current;
        }

        /** Draft text shown for one field's current effective value. `live` is
         * false while the effective value is unknown (the settings face is
         * loading or unavailable): an off-list select then reads EMPTY instead
         * of posing as its first option — the card never fakes a default. */
        function formatValue(field, value, live = true) {
            if (field.kind === "number") return typeof value === "number" ? String(value) : "";
            if (field.kind === "select") {
                if (field.options.includes(value)) return value;
                return live ? field.options[0] : "";
            }
            return typeof value === "string" ? value : "";
        }

        /** Client-side draft validation (the server validate remains the
         * authority; these only block obviously-unsaveable drafts). */
        function draftInvalid(field, text) {
            if (field.kind === "number") {
                const trimmed = text.trim();
                return trimmed !== "" && !Number.isFinite(Number(trimmed));
            }
            if (field.kind === "textarea") return text.trim().length > MAX_PROMPT_EXTRA;
            return false;
        }

        /** Minimal snapshot source (uSES-compatible) the card's hook reads. */
        function createSource(project) {
            let snapshot = project();
            const listeners = new Set();
            return {
                getSnapshot: () => snapshot,
                subscribe(listener) {
                    listeners.add(listener);
                    return () => { listeners.delete(listener); };
                },
                publish() {
                    snapshot = project();
                    for (const listener of [...listeners]) listener();
                },
            };
        }

        /** §4-D snapshot while no settings face has answered: loading status,
         * empty layers — the card shows a skeleton, never a made-up value. */
        function pendingSnapshot() {
            return { status: "loading", value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: undefined };
        }

        /** Lazy optional-service read (§4-D): `ctx.get(name)` declares nothing and
         * waits for nothing, so a service this generation lacks degrades visibly
         * instead of leaving this fiber pending forever. Undefined = absent. */
        function readService(ctx, serviceName) {
            return typeof ctx.get === "function" ? ctx.get(serviceName) ?? undefined : undefined;
        }

        /** One-shot warnings: a degradation reports once, whatever re-renders. */
        const warnOnce = (function () {
            const seen = new Set();
            return function (message, ...rest) {
                if (seen.has(message)) return;
                seen.add(message);
                console.warn("[dsh-vision-bridge] " + message, ...rest);
            };
        })();

        /** The two settings generations behind one shape (§4-D): `resolve(ctx)`
         * hands back the live face (null while unavailable), `read` / `save` /
         * `watch` speak to it. `configForms` (0.1.7) first, `settingsScope`
         * (0.1.6) second. */
        const SETTINGS_GENERATIONS = [
            {
                kind: "configForms",
                resolve(ctx) {
                    const service = readService(ctx, "configForms");
                    return service !== undefined && typeof service.get === "function" ? service.get(SETTINGS_NS) ?? null : null;
                },
                read(face) { return face.getSnapshot?.() ?? null; },
                save(face, ops, revision) {
                    return typeof face.mutate === "function" ? Promise.resolve(face.mutate(ops, revision)) : Promise.resolve(false);
                },
                watch(face, listener) { return typeof face.subscribe === "function" ? face.subscribe(listener) : null; },
            },
            {
                kind: "settingsScope",
                resolve(ctx) {
                    const service = readService(ctx, "settingsScope");
                    return service !== undefined && typeof service.bind === "function" ? service.bind({ namespace: SETTINGS_NS }) : null;
                },
                read(face) { return face.getSnapshot?.() ?? null; },
                // The 0.1.6 `mutate` has no revision fence and its result was
                // never interpreted (the landed check reads the snapshot back):
                // a fulfilled call reports true, and the old behaviour is kept.
                save(face, ops) { return Promise.resolve(face.mutate(ops)).then(() => true); },
                watch(face, listener) { return typeof face.subscribe === "function" ? face.subscribe(listener) : null; },
            },
        ];

        /** The card's data source (§4-D): nothing above it knows which generation
         * answered. The first one that resolves wins, and every operation
         * re-resolves it, so a service arriving after apply is still picked up. */
        function createSettingsSource(ctx) {
            const generations = SETTINGS_GENERATIONS.map((generation) => ({ ...generation, face: null, attached: false, detach: null }));
            const listeners = new Set();
            const flush = () => { for (const listener of [...listeners]) listener(); };
            /** The live face, resolved ONCE (the 0.1.6 `bind` must not run twice). */
            const faceOf = (generation) => {
                if (generation.face !== null) return generation.face;
                try {
                    generation.face = generation.resolve(ctx);
                } catch (error) {
                    warnOnce(generation.kind + " refused to resolve", error);
                }
                return generation.face;
            };
            const live = () => generations.find((generation) => faceOf(generation) !== null) ?? null;
            /** Attach the winner's change feed the first time it answers. */
            const watch = () => {
                const chosen = live();
                if (chosen !== null && !chosen.attached) {
                    chosen.attached = true;
                    chosen.detach = chosen.watch(faceOf(chosen), flush);
                }
                return chosen;
            };
            const viewOf = (chosen) => {
                const view = chosen === null ? null : chosen.read(faceOf(chosen));
                return view !== null && typeof view === "object" ? view : pendingSnapshot();
            };
            return {
                kind: () => live()?.kind ?? null,
                status() {
                    const chosen = watch();
                    if (chosen === null) {
                        warnOnce("no settings face resolved — configuration stays unreadable");
                        return "loading";
                    }
                    const status = viewOf(chosen).status;
                    return status === "ready" || status === "unavailable" ? status : "loading";
                },
                snapshot() {
                    return viewOf(live());
                },
                async write(ops, revision) {
                    const chosen = live();
                    if (chosen === null) return false;
                    return (await chosen.save(faceOf(chosen), ops, revision)) !== false;
                },
                subscribe(listener) {
                    listeners.add(listener);
                    watch();
                    return () => { listeners.delete(listener); };
                },
                dispose() {
                    for (const generation of generations) {
                        if (typeof generation.detach === "function") generation.detach();
                        generation.detach = null;
                        generation.attached = false;
                    }
                    listeners.clear();
                },
            };
        }

        /** The card slots, most precise first (§4-E): this bundle's own row, the
         * bundle, the official-card group (it carries its own id, so it never
         * fights an official entry for a cell), then the 0.1.6-only legacy slot —
         * registering that one on 0.1.7 throws, so it is probed like every rung. */
        const SLOT_CANDIDATES = [
            { slot: "plugins.row.config", kind: "keyed", key: ROW_KEY },
            { slot: "plugins.bundle.config", kind: "keyed", key: name },
            { slot: "plugins.item", kind: "list" },
            { slot: LEGACY_SLOT_NAME, kind: "keyed", key: SETTINGS_NS },
        ];

        /** The declared spec of one slot, or undefined when the host declares
         * nothing — a legal probe answer, and the only one a host with no probe
         * face at all gives. */
        function slotSpec(slots, slot) {
            for (const probe of [slots.specDynamic, slots.spec]) {
                if (typeof probe !== "function") continue;
                const spec = probe.call(slots, slot);
                if (spec !== undefined && spec !== null) return spec;
            }
            return undefined;
        }

        /** Pick the rung to mount on: the highest declared one whose kind matches
         * the shape we register. Without a probe face the ladder cannot be ranked
         * here, so the legacy rung is waited on through `inject` (a no-op wait
         * when that slot never appears); with nothing declared yet, the highest
         * such rung is waited on the same way, mounting whenever it shows up. */
        function chooseSlot(slots) {
            const probeable = typeof slots.specDynamic === "function" || typeof slots.spec === "function";
            if (!probeable) return { candidate: SLOT_CANDIDATES[SLOT_CANDIDATES.length - 1], via: "inject" };
            const undeclared = [];
            for (const candidate of SLOT_CANDIDATES) {
                const spec = slotSpec(slots, candidate.slot);
                if (spec === undefined) {
                    undeclared.push(candidate);
                    continue;
                }
                if (spec.kind !== undefined && spec.kind !== candidate.kind) {
                    warnOnce("slot " + candidate.slot + " is declared with kind " + spec.kind + ", not " + candidate.kind + " — taking the next rung");
                    continue;
                }
                return { candidate, via: "direct" };
            }
            if (undeclared.length > 0) return { candidate: undeclared[0], via: "inject" };
            return null;
        }

        /** Registration options for one rung: a keyed rung carries its cell `key`,
         * the list rung its own id / order / label. */
        function cardRegistration(ctx, candidate, controller) {
            const options = { name: candidate.slot, locale: LOCALE_NS, inject: () => controller.inject() };
            if (candidate.kind === "keyed") {
                options.key = candidate.key;
                return options;
            }
            options.id = CARD_ID;
            options.order = CARD_ORDER;
            options.label = () => ctx.locale.bind(LOCALE_NS)("cardTitle");
            return options;
        }

        /** Mount the card on the chosen rung, at most once (§4-E guard: a
         * re-entrant apply or a second declared rung must not stack two). */
        let cardMounted = false;
        function mountCard(ctx, controller) {
            if (cardMounted) return () => {};
            const slots = ctx.slots;
            const choice = chooseSlot(slots);
            if (choice === null) {
                warnOnce("no card slot is available in this kernel — the settings card is not mounted");
                return () => {};
            }
            /** Register on the chosen rung; returns its disposer. */
            const register = () => {
                if (cardMounted) return () => {};
                const unregister = slots.register(cardRegistration(ctx, choice.candidate, controller), VisionBridgeCard);
                cardMounted = true;
                return () => {
                    cardMounted = false;
                    if (typeof unregister === "function") unregister();
                };
            };
            // A declared rung registers right away; an undeclared one waits for
            // its declaration through `inject`, which also withdraws that
            // registration again when the declaration collapses (§2.3).
            let unregister = () => {};
            if (choice.via === "direct") unregister = register();
            else if (typeof slots.inject === "function") unregister = slots.inject(choice.candidate.slot, register);
            else warnOnce("slots.inject is unavailable — cannot wait for slot " + choice.candidate.slot);
            return () => {
                cardMounted = false;
                if (typeof unregister === "function") unregister();
            };
        }

        /**
         * Staged form over the `vision-bridge` settings source (§10), extended
         * with the §11 v2 faces: provider linkage, credential three-forms, the
         * connectivity probe, and the environment panel. Settings writes stay
         * the §10 staged → ONE atomic write flow; the provider dropdown and
         * credential forms are fill helpers whose outcome still lands in the
         * same three provider fields.
         */
        class VisionBridgeCardController {
            constructor(source, credentials) {
                this.source = source;
                this.credentials = credentials;
                this.disposed = false;
                this.wakeup = null;
                this.staged = new Map();
                this.saving = false;
                this.showKey = false;
                this.savedAt = 0;
                this.failed = false;
                // §11 v2 UI state
                this.env = null;
                this.envStatus = "loading";
                this.credentialViews = {};
                this.providerMode = CUSTOM_PROVIDER;
                this.credentialMode = "list";
                this.pendingKey = "";
                this.pendingName = DEFAULT_CREDENTIAL_NAME;
                this.credentialError = null;
                this.test = { status: "idle" };
                this.advancedOpen = false;
                // §4.6: the four seam rows carry their own Details toggles.
                this.explainOpen = { admission: false, modlens: false, seam: false, "seam-marker": false, "seam-reader": false };
                this.fixing = null;
                this.fixMessage = null;
                this.store = createSource(() => this.projection());
                this.source.subscribe(() => this.publish());
                this.startServiceWakeup();
                this.refreshEnv();
            }

            publish() {
                this.store.publish();
            }

            /** Poll until every lazily read service has answered, then publish
             * (a service may arrive after apply, §4-D). Bounded: a service this
             * deployment never provides stops the loop instead of spinning. */
            startServiceWakeup() {
                if (this.wakeup !== null) return;
                let attempts = 0;
                const tick = () => {
                    this.wakeup = null;
                    if (this.disposed) return;
                    const waiting = this.source.status() === "loading" || this.credentials() === undefined;
                    this.publish();
                    if (!waiting || attempts >= WAKEUP_ATTEMPTS) return;
                    attempts += 1;
                    this.wakeup = globalThis.setTimeout(tick, WAKEUP_INTERVAL_MS);
                };
                tick();
            }

            /** Release the subscription, the wake-up poll and the face feed. */
            dispose() {
                this.disposed = true;
                if (this.wakeup !== null) {
                    globalThis.clearTimeout(this.wakeup);
                    this.wakeup = null;
                }
                this.source.dispose();
            }

            snapshot() {
                return this.source.snapshot();
            }

            /** §4-D three-state, narrowed to what the UI renders: anything but
             * a definite `ready` / `unavailable` reads as loading (skeleton). */
            statusNow() {
                const status = this.snapshot().status;
                return status === "ready" || status === "unavailable" ? status : "loading";
            }

            /** Writing needs a live face that is writable — `unavailable` stays
             * read-only even if a stale flag claimed otherwise (§4-D). */
            writableNow() {
                const view = this.snapshot();
                return view.status === "ready" && view.writable === true;
            }

            effective(field) {
                return readPath(this.snapshot().value, field.path);
            }

            draftText(id) {
                const staged = this.staged.get(id);
                if (staged !== undefined) return staged;
                return formatValue(FIELD_BY_ID.get(id), this.effective(FIELD_BY_ID.get(id)));
            }

            /** Every staged edit a save would write, plus a blocked flag when a
             * draft cannot become a value (save refuses rather than dropping). */
            plan() {
                const ops = [];
                let invalid = false;
                for (const [id, text] of this.staged) {
                    const field = FIELD_BY_ID.get(id);
                    if (draftInvalid(field, text)) {
                        invalid = true;
                        continue;
                    }
                    if (field.kind === "number") {
                        const trimmed = text.trim();
                        if (trimmed === "") {
                            ops.push({ op: "unset", path: field.path });
                        } else if (Number(trimmed) !== this.effective(field)) {
                            ops.push({ op: "set", path: field.path, value: Number(trimmed) });
                        }
                        continue;
                    }
                    const value = text.trim();
                    if (value === "") {
                        if (formatValue(field, this.effective(field)) !== "") ops.push({ op: "unset", path: field.path });
                        continue;
                    }
                    if (value !== formatValue(field, this.effective(field))) {
                        ops.push({ op: "set", path: field.path, value });
                    }
                }
                return { ops, invalid };
            }

            opLanded(op, view) {
                if (op.op === "set") return readPath(view.value, op.path) === op.value;
                return readPath(view.user, op.path) === undefined;
            }

            /** Provider rows for the dropdown; empty until /env answers. */
            providers() {
                return Array.isArray(this.env?.providers) ? this.env.providers : [];
            }

            /** The provider the current Base URL links to, or null for custom. */
            linkedProviderFromBaseURL() {
                const baseURL = this.draftText("baseURL").trim();
                if (baseURL === "") return null;
                return this.providers().find((p) => p.baseURL !== "" && p.baseURL === baseURL) ?? null;
            }

            syncProviderMode() {
                const linked = this.linkedProviderFromBaseURL();
                this.providerMode = linked ? linked.id : CUSTOM_PROVIDER;
            }

            projection() {
                const view = this.snapshot();
                const status = this.statusNow();
                // Values are only trustworthy on a ready face; the credential
                // service is re-read here so its late arrival re-renders.
                const live = status === "ready";
                const credentialsAvailable = this.credentials() !== undefined;
                const { ops, invalid } = this.plan();
                const fields = {};
                for (const field of FIELDS) {
                    const staged = this.staged.get(field.id);
                    fields[field.id] = {
                        text: staged !== undefined ? staged : formatValue(field, readPath(view.value, field.path), live),
                        invalid: staged !== undefined && draftInvalid(field, staged),
                    };
                }
                const providers = this.providers();
                const linked = this.providerMode === CUSTOM_PROVIDER ? null : providers.find((p) => p.id === this.providerMode) ?? null;
                const modelDraft = this.draftText("model").trim();
                const modelOptions = linked === null ? null : linked.models.map((m) => ({
                    id: m.id,
                    label: m.vision ? m.id + " 👁" : m.id,
                    vision: m.vision,
                })).concat(modelDraft !== "" && !linked.models.some((m) => m.id === modelDraft)
                    ? [{ id: modelDraft, label: modelDraft, vision: false }]
                    : []);
                const credentialOptions = this.credentialOptions();
                return {
                    status,
                    writable: live && view.writable === true,
                    // §4-H2②: without the credential service this area says so
                    // neutrally — never a made-up entry list, and never the
                    // paste form (which writes through that very service).
                    credentialsAvailable,
                    dirty: ops.length > 0 || (this.credentialMode === "paste" && this.pendingKey.trim() !== ""),
                    invalid,
                    saving: this.saving,
                    showKey: this.showKey,
                    savedFlash: Date.now() - this.savedAt < 4000,
                    failed: this.failed,
                    fields,
                    envStatus: this.envStatus,
                    env: this.env,
                    providers,
                    providerMode: this.providerMode,
                    linkedProvider: linked,
                    linkedNoBaseURL: linked !== null && linked.baseURL === "",
                    modelOptions,
                    credentialMode: !credentialsAvailable && this.credentialMode === "paste" ? "list" : this.credentialMode,
                    credentialOptions,
                    pendingKey: this.pendingKey,
                    pendingName: this.pendingName,
                    credentialError: this.credentialError,
                    credentialCheck: this.credentialCheck(),
                    test: this.test,
                    advancedOpen: this.advancedOpen,
                    explainOpen: this.explainOpen,
                    fixing: this.fixing,
                    fixMessage: this.fixMessage,
                };
            }

            /** Credential dropdown rows: projected candidates (provider
             * apiKeyEnv, current ref, VISION_API_KEY), each annotated with the
             * describe() facts — plus the current ref when it is not a
             * candidate, so a select never silently drops a value. */
            credentialOptions() {
                const options = [];
                const seen = new Set();
                // Without the credential service nothing can be read about any
                // candidate: those rows then carry the reference alone instead
                // of claiming "not configured" (§4-H2②).
                const readable = this.credentials() !== undefined;
                for (const ref of Array.isArray(this.env?.credentialCandidates) ? this.env.credentialCandidates : []) {
                    if (seen.has(ref)) continue;
                    seen.add(ref);
                    const view = this.credentialViews[ref];
                    const provider = this.providers().find((p) => p.apiKeyEnv === ref);
                    options.push({ value: ref, readable, configured: view?.configured === true, source: view?.source, provider: provider?.id });
                }
                const current = this.draftText("credential").trim();
                if (current !== "" && !seen.has(current)) {
                    options.push({ value: current, readable, configured: this.credentialViews[current]?.configured === true });
                }
                return options;
            }

            /** Silent describe()-based check of the credential the draft names
             * (§11.3C form 1: linked ⇒ configured reads as the ✓ mark). */
            credentialCheck() {
                const ref = this.draftText("credential").trim();
                if (ref === "") return null;
                const view = this.credentialViews[ref];
                if (!view) return { status: "unknown" };
                const provider = this.providers().find((p) => p.apiKeyEnv === ref);
                return { status: view.configured ? "ok" : "missing", source: view.source, provider: provider?.id };
            }

            edit(id, text) {
                this.staged.set(id, text);
                this.failed = false;
                if (id === "baseURL") this.syncProviderMode();
                this.publish();
            }

            /** Provider linkage (§11.3B): custom unlocks manual entry; a real
             * provider auto-fills model (first vision-capable, keeping a model
             * the provider lists), Base URL (only when readable — risk #12),
             * and the credential reference (apiKeyEnv). */
            selectProvider(id) {
                this.failed = false;
                this.credentialError = null;
                if (id === CUSTOM_PROVIDER || this.providers().every((p) => p.id !== id)) {
                    this.providerMode = CUSTOM_PROVIDER;
                    this.publish();
                    return;
                }
                const provider = this.providers().find((p) => p.id === id);
                this.providerMode = id;
                const current = this.draftText("model").trim();
                if (!provider.models.some((m) => m.id === current)) {
                    const next = (provider.models.find((m) => m.vision) ?? provider.models[0])?.id ?? "";
                    if (next !== "") this.staged.set("model", next);
                }
                if (provider.baseURL !== "") this.staged.set("baseURL", provider.baseURL);
                if (provider.apiKeyEnv !== "") {
                    this.credentialMode = "list";
                    this.staged.set("credential", provider.apiKeyEnv);
                }
                this.publish();
            }

            selectCredential(value) {
                this.credentialError = null;
                if (value === PASTE_CREDENTIAL) {
                    this.credentialMode = "paste";
                    this.pendingKey = "";
                    this.pendingName = DEFAULT_CREDENTIAL_NAME;
                    this.publish();
                    return;
                }
                if (value === MANUAL_CREDENTIAL) {
                    this.credentialMode = "manual";
                    this.publish();
                    return;
                }
                this.credentialMode = "list";
                this.edit("credential", value);
            }

            editPendingKey(text) {
                this.pendingKey = text;
                this.credentialError = null;
                this.publish();
            }

            editPendingName(text) {
                this.pendingName = text;
                this.credentialError = null;
                this.publish();
            }

            clearPasteForm() {
                this.pendingKey = "";
                this.pendingName = DEFAULT_CREDENTIAL_NAME;
                this.credentialMode = "list";
                this.credentialError = null;
            }

            discard() {
                this.staged.clear();
                this.failed = false;
                this.clearPasteForm();
                this.syncProviderMode();
                this.publish();
            }

            /** GET /vision-bridge/env + describe the credential candidates. */
            async refreshEnv() {
                this.fixMessage = null;
                if (this.env === null) this.envStatus = "loading";
                this.publish();
                try {
                    const response = await fetch("/vision-bridge/env");
                    if (!response.ok) throw new Error("HTTP " + response.status);
                    const data = await response.json();
                    this.env = data && typeof data === "object" ? data : null;
                    this.envStatus = "ready";
                    this.syncProviderMode();
                    this.publish();
                    await this.describeCredentials(Array.isArray(this.env?.credentialCandidates) ? this.env.credentialCandidates : []);
                } catch {
                    this.envStatus = "failed";
                    this.publish();
                }
            }

            async describeCredentials(refs) {
                const service = this.credentials();
                if (!service || refs.length === 0) return;
                try {
                    const response = await service.describe(refs);
                    if (response?.ok !== true || !response.value) return;
                    this.credentialViews = { ...this.credentialViews, ...response.value };
                    this.publish();
                } catch {
                    /* views stay as they are — the marks simply do not render */
                }
            }

            /** POST /vision-bridge/test with the current draft; a pasted key
             * rides pendingApiKey and exists only for this one request. */
            async runTest() {
                if (this.test.status === "testing") return;
                this.test = { status: "testing" };
                this.publish();
                const body = {};
                const baseURL = this.draftText("baseURL").trim();
                if (baseURL !== "") body.baseURL = baseURL;
                const model = this.draftText("model").trim();
                if (model !== "") body.model = model;
                if (this.credentialMode === "paste") {
                    const key = this.pendingKey.trim();
                    if (key !== "") body.pendingApiKey = key;
                    const entry = this.pendingName.trim();
                    if (entry !== "") body.credential = entry;
                } else {
                    const credential = this.draftText("credential").trim();
                    if (credential !== "") body.credential = credential;
                }
                try {
                    const response = await fetch("/vision-bridge/test", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                    });
                    if (!response.ok) {
                        // Surface the server's structured error when present
                        // (review #6): a 400 "baseURL must be http(s)" must
                        // not read as a network failure.
                        let serverMessage = null;
                        try {
                            const body = await response.json();
                            serverMessage = body?.error ?? null;
                        } catch { /* not JSON */ }
                        throw new Error(serverMessage ?? ("HTTP " + response.status));
                    }
                    const data = await response.json();
                    this.test = data?.ok === true
                        ? { status: "ok", latencyMs: data.latencyMs, model: data.model }
                        : { status: "fail", code: data?.error?.code ?? "unknown", message: data?.error?.message };
                } catch (error) {
                    this.test = { status: "fail", code: "network", message: String(error?.message ?? error) };
                }
                this.publish();
            }

            /** One-click fixes: POST /vision-bridge/fix-admission|fix-modlens. */
            async runFix(kind) {
                if (this.fixing !== null) return;
                if (kind !== "admission" && kind !== "modlens") return;
                this.fixing = kind;
                this.fixMessage = null;
                this.publish();
                try {
                    const response = await fetch("/vision-bridge/fix-" + kind, { method: "POST" });
                    if (!response.ok) throw new Error("HTTP " + response.status);
                    const data = await response.json();
                    this.fixMessage = {
                        target: kind,
                        kind: data?.applied === true ? "applied" : data?.alreadyPatched === true ? "already" : "failed",
                        message: data?.error,
                    };
                } catch (error) {
                    this.fixMessage = { target: kind, kind: "failed", message: String(error?.message ?? error) };
                }
                this.fixing = null;
                this.publish();
                // Keep the fix result message visible (review #1): refreshEnv
                // clears fixMessage on entry, and two synchronous publishes
                // in the same stack coalesce - the user would never see
                // "applied, restart DSH web". Await the refresh first, then
                // restore the message and publish again.
                const fixResult = this.fixMessage;
                await this.refreshEnv();
                this.fixMessage = fixResult;
                this.publish();
            }

            toggleAdvanced() {
                this.advancedOpen = !this.advancedOpen;
                this.publish();
            }

            toggleShowKey() {
                this.showKey = !this.showKey;
                this.publish();
            }

            toggleExplain(target) {
                this.explainOpen = { ...this.explainOpen, [target]: !this.explainOpen[target] };
                this.publish();
            }

            async save() {
                const initial = this.plan();
                if (initial.invalid || this.saving || !this.writableNow()) return;
                // Credential form 3 (§11.3C): the pasted key becomes a DSH
                // credential entry BEFORE the settings write. An existing name
                // is OVERWRITTEN (the user is changing their key — rejecting
                // would force endless new entries); the key never lands in
                // this plugin's settings either way.
                if (this.credentialMode === "paste") {
                    const entry = this.pendingName.trim();
                    const key = this.pendingKey.trim();
                    if (key === "") {
                        this.credentialError = { kind: "empty" };
                        this.publish();
                        return;
                    }
                    const service = this.credentials();
                    if (!service || typeof service.describe !== "function" || typeof service.set !== "function") {
                        this.credentialError = { kind: "failed", message: "credentials service unavailable" };
                        this.publish();
                        return;
                    }
                    // No pre-check: set() overwrites by design (the user is
                    // supplying a new key for this entry name). The describe
                    // pre-check was removed — a refused describe used to block
                    // legitimate key rotation.
                    try {
                        await service.set(entry, key);
                    } catch (error) {
                        this.credentialError = { kind: "failed", message: String(error?.message ?? error) };
                        this.publish();
                        return;
                    }
                    this.credentialError = null;
                    this.staged.set("credential", entry);
                    // The credential entry is now durable (review #3): leave
                    // paste mode BEFORE the settings write, so a failed write
                    // retry only re-runs the write instead of colliding with
                    // the entry it just created.
                    this.pendingKey = "";
                    this.credentialMode = "list";
                }
                const plan = this.plan();
                if (plan.ops.length === 0) {
                    // Only the credential entry was written — nothing to mutate.
                    this.clearPasteForm();
                    this.publish();
                    return;
                }
                this.saving = true;
                this.failed = false;
                this.publish();
                let landed = true;
                try {
                    // §4-D: the write carries the revision this snapshot was
                    // taken at, and a face answering `false` (refused / stale
                    // revision) is a failure — the landed check below is the
                    // second witness against the post-write snapshot.
                    const accepted = await this.source.write(plan.ops, this.snapshot().revision);
                    const view = this.snapshot();
                    landed = accepted !== false && plan.ops.every((op) => this.opLanded(op, view));
                } catch {
                    landed = false;
                }
                if (landed) {
                    this.staged.clear();
                    this.clearPasteForm();
                    // Visible save confirmation (user feedback: the previous
                    // success was indistinguishable from nothing happening).
                    this.savedAt = Date.now();
                } else {
                    this.failed = true;
                }
                this.saving = false;
                this.publish();
            }

            /** The face the card's slot registration injects. */
            inject() {
                return {
                    hooks: { visionBridgeCard: this.store },
                    edit: (id, text) => { this.edit(id, text); },
                    save: () => { this.save(); },
                    discard: () => { this.discard(); },
                    selectProvider: (id) => { this.selectProvider(id); },
                    selectCredential: (value) => { this.selectCredential(value); },
                    editPendingKey: (text) => { this.editPendingKey(text); },
                    editPendingName: (text) => { this.editPendingName(text); },
                    runTest: () => { this.runTest(); },
                    refreshEnv: () => { this.refreshEnv(); },
                    runFix: (kind) => { this.runFix(kind); },
                    toggleAdvanced: () => { this.toggleAdvanced(); },
                    toggleShowKey: () => { this.toggleShowKey(); },
                    toggleExplain: (target) => { this.toggleExplain(target); },
                };
            }
        }

        function inputId(id) {
            return `vision-bridge-card-${id}`;
        }

        function errorMessageText(t, code, message) {
            const known = {
                auth: t("testErrorAuth"),
                endpoint: t("testErrorEndpoint"),
                timeout: t("testErrorTimeout"),
                network: t("testErrorNetwork"),
            };
            const reason = known[code] ?? t("testErrorUnknown");
            return typeof message === "string" && message !== "" ? reason + " — " + message : reason;
        }

        /** The Plugins-page card: locale copy `t`, the card snapshot hook, and
         * the form actions (edit/save/…/runFix) arrive as slot props. */
        function VisionBridgeCard(props) {
            const state = props.useVisionBridgeCard((snapshot) => snapshot);
            const t = props.t;
            const e = react.createElement;
            const disabled = !state.writable || state.saving;

            // The detail page asks for a one-line summary before the full card
            // (built-in card precedent): the summary is the existing description
            // string, so no new copy and no layout of its own.
            if (props.view === "summary") return t("description");

            /** A generic field shell (label + control + notes). */
            function fieldShell(field, fs, control, extraNotes) {
                const id = inputId(field.id);
                const notes = [];
                if (field.id === "promptExtra") {
                    notes.push(e("span", {
                        key: "count",
                        className: "dvb-count",
                        "data-over": fs.invalid ? "true" : undefined,
                    }, `${fs.text.length}/2000`));
                }
                if (fs.invalid && field.kind === "number") {
                    notes.push(e("span", { key: "num", className: "dvb-hint dvb-hint-error" }, t("invalidNumber")));
                }
                if (fs.invalid && field.kind === "textarea") {
                    notes.push(e("span", { key: "long", className: "dvb-hint dvb-hint-error" }, t("promptExtraTooLong")));
                }
                if (Array.isArray(extraNotes)) notes.push(...extraNotes);
                if (field.hintKey !== undefined) {
                    notes.push(e("span", { key: "hint", className: "dvb-hint" }, t(field.hintKey)));
                }
                return e("div", {
                    key: field.id,
                    className: field.kind === "textarea" ? "dvb-field dvb-wide" : "dvb-field",
                    "data-invalid": fs.invalid ? "true" : undefined,
                }, e("label", { htmlFor: id }, t(field.labelKey)), control, ...notes);
            }

            /** The §10 generic control for trigger/advanced fields. */
            function simpleField(field) {
                const fs = state.fields[field.id];
                const id = inputId(field.id);
                let control;
                if (field.kind === "select") {
                    control = e("select", {
                        id,
                        value: fs.text,
                        disabled,
                        onChange: (event) => { props.edit(field.id, event.currentTarget.value); },
                    }, field.options.map((option) => e("option", { key: option, value: option }, option)));
                } else if (field.kind === "textarea") {
                    control = e("textarea", {
                        id,
                        rows: 4,
                        value: fs.text,
                        disabled,
                        onChange: (event) => { props.edit(field.id, event.currentTarget.value); },
                    });
                } else {
                    control = e("input", {
                        id,
                        type: "text",
                        inputMode: field.kind === "number" ? "numeric" : undefined,
                        value: fs.text,
                        disabled,
                        placeholder: field.placeholderKey !== undefined ? t(field.placeholderKey) : undefined,
                        onChange: (event) => { props.edit(field.id, event.currentTarget.value); },
                    });
                }
                return fieldShell(field, fs, control);
            }

            /** ① Vision engine group (§11.3A): provider linkage + model +
             * Base URL + credential, with the connectivity probe. */
            function engineGroup() {
                const modelField = FIELD_BY_ID.get("model");
                const modelFs = state.fields.model;
                let modelControl;
                if (state.modelOptions === null) {
                    // Custom mode: free-text model entry.
                    modelControl = e("input", {
                        id: inputId("model"),
                        type: "text",
                        value: modelFs.text,
                        disabled,
                        placeholder: t("providerPlaceholder"),
                        onChange: (event) => { props.edit("model", event.currentTarget.value); },
                    });
                } else {
                    modelControl = e("select", {
                        id: inputId("model"),
                        value: modelFs.text,
                        disabled,
                        onChange: (event) => { props.edit("model", event.currentTarget.value); },
                    }, state.modelOptions.map((option) => e("option", {
                        key: option.id,
                        value: option.id,
                        style: option.vision ? undefined : { color: "#9a958e" },
                    }, option.label)));
                }

                const providerControl = e("select", {
                    id: inputId("provider"),
                    value: state.providerMode,
                    disabled,
                    onChange: (event) => { props.selectProvider(event.currentTarget.value); },
                }, [
                    ...state.providers.map((p) => e("option", { key: p.id, value: p.id }, p.id)),
                    e("option", { key: CUSTOM_PROVIDER, value: CUSTOM_PROVIDER }, t("providerCustom")),
                ]);

                const baseURLField = FIELD_BY_ID.get("baseURL");
                const baseURLFs = state.fields.baseURL;
                const baseURLNotes = [];
                if (state.linkedNoBaseURL) {
                    baseURLNotes.push(e("span", { key: "manual", className: "dvb-hint dvb-hint-error" }, t("baseURLManualHint")));
                } else if (state.providerMode === CUSTOM_PROVIDER) {
                    baseURLNotes.push(e("span", { key: "custom", className: "dvb-hint" }, t("customModeHint")));
                }
                const baseURLControl = e("input", {
                    id: inputId("baseURL"),
                    type: "text",
                    value: baseURLFs.text,
                    disabled,
                    placeholder: t("providerPlaceholder"),
                    onChange: (event) => { props.edit("baseURL", event.currentTarget.value); },
                });

                // Credential control — three forms (§11.3C): the dropdown is
                // always present (stored entries + paste + manual options);
                // the paste/manual selections expand their inputs below it.
                const credentialField = FIELD_BY_ID.get("credential");
                const credentialFs = state.fields.credential;
                const credentialNotes = [];
                if (!state.credentialsAvailable) {
                    // §4-H2②: this area reports the missing credential service
                    // neutrally instead of showing claims it cannot back.
                    credentialNotes.push(e("span", { key: "nosvc", className: "dvb-hint" }, t("credentialsUnavailable")));
                }
                if (state.credentialCheck !== null) {
                    const mark = state.credentialCheck.status === "ok"
                        ? e("span", { key: "ck", className: "dvb-cred-mark dvb-cred-ok" }, t("credentialCheckOk"))
                        : state.credentialCheck.status === "missing"
                            ? e("span", { key: "ck", className: "dvb-cred-mark dvb-cred-miss" }, t("credentialCheckMissing"))
                            : null;
                    if (mark !== null) credentialNotes.push(mark);
                }
                const credentialOptions = state.credentialOptions.map((option) => {
                    // An unreadable row (no credential service) keeps the bare
                    // reference: no configured / unconfigured claim is made.
                    const facts = !option.readable ? [] : [option.configured
                        ? t("credentialConfigured") + (typeof option.source === "string" && option.source !== "" ? " · " + t("credentialSourceLabel") + " " + option.source : "")
                        : t("credentialNotConfigured")];
                    if (option.readable && option.provider) facts.push(t("credentialFromProvider") + " " + option.provider);
                    return e("option", {
                        key: option.value,
                        value: option.value,
                        style: option.readable && !option.configured ? { color: "#9a958e" } : undefined,
                    }, option.value + (facts.length === 0 ? "" : " · " + facts.join(" · ")));
                });
                const credentialSelectValue = state.credentialMode === "paste" ? PASTE_CREDENTIAL
                    : state.credentialMode === "manual" ? MANUAL_CREDENTIAL
                        : credentialFs.text;
                const credentialSubRows = [];
                if (state.credentialMode === "paste") {
                    credentialSubRows.push(e("input", {
                        key: "key",
                        id: inputId("credential-key"),
                        type: state.showKey ? "text" : "password",
                        className: "dvb-mono",
                        value: state.pendingKey,
                        disabled,
                        placeholder: t("credentialKeyPlaceholder"),
                        autoComplete: "off",
                        spellCheck: false,
                        onChange: (event) => { props.editPendingKey(event.currentTarget.value); },
                    }));
                    // Masked by default with a reveal toggle (password-style
                    // + switchable plaintext, per user feedback).
                    credentialSubRows.push(e("button", {
                        key: "reveal",
                        type: "button",
                        className: "dvb-mini",
                        disabled,
                        onClick: () => { props.toggleShowKey(); },
                    }, state.showKey ? "🙈" : "👁"));
                    credentialSubRows.push(e("input", {
                        key: "name",
                        id: inputId("credential-name"),
                        type: "text",
                        value: state.pendingName,
                        disabled,
                        placeholder: DEFAULT_CREDENTIAL_NAME,
                        onChange: (event) => { props.editPendingName(event.currentTarget.value); },
                    }));
                    credentialNotes.push(e("span", { key: "paste-hint", className: "dvb-hint" }, t("credentialPasteHint")));
                    credentialNotes.push(e("span", { key: "name-hint", className: "dvb-hint" }, t("credentialKeyName") + " · " + t("credentialKeyLabel")));
                    if (state.credentialError !== null) {
                        credentialNotes.push(credentialErrorNote());
                    }
                } else if (state.credentialMode === "manual") {
                    credentialSubRows.push(e("input", {
                        key: "manual",
                        id: inputId("credential-manual"),
                        type: "text",
                        value: credentialFs.text,
                        disabled,
                        placeholder: "VISION_API_KEY",
                        onChange: (event) => { props.edit("credential", event.currentTarget.value); },
                    }));
                }
                const credentialControl = e("div", null,
                    e("select", {
                        id: inputId("credential"),
                        value: credentialSelectValue,
                        disabled,
                        onChange: (event) => { props.selectCredential(event.currentTarget.value); },
                    }, [
                        ...credentialOptions,
                        // The paste form writes through the credential service, so
                        // it is only offered while that service is present; the
                        // manual form keeps working either way (its reference is
                        // simply typed into the settings field).
                        state.credentialsAvailable
                            ? e("option", { key: PASTE_CREDENTIAL, value: PASTE_CREDENTIAL }, t("credentialPasteOption"))
                            : null,
                        e("option", { key: MANUAL_CREDENTIAL, value: MANUAL_CREDENTIAL }, t("credentialManualOption")),
                    ]),
                    ...credentialSubRows);

                const testButton = e("button", {
                    type: "button",
                    className: "dvb-mini",
                    disabled: disabled || state.test.status === "testing",
                    onClick: () => { props.runTest(); },
                }, state.test.status === "testing" ? t("testing") : t("testConnection"));

                let testLine = null;
                if (state.test.status === "ok") {
                    testLine = e("div", { className: "dvb-testline dvb-ok" },
                        t("testOk") + " — " + (typeof state.test.model === "string" ? state.test.model : "")
                        + " · " + t("testLatency") + " " + String(state.test.latencyMs ?? "?") + " ms");
                } else if (state.test.status === "fail") {
                    testLine = e("div", { className: "dvb-testline dvb-warn" },
                        t("testFail") + " — " + errorMessageText(t, state.test.code, state.test.message));
                }

                return e("div", {
                    className: "dvb-group dvb-group-engine",
                    "data-custom": state.providerMode === CUSTOM_PROVIDER ? "true" : undefined,
                },
                    e("div", { className: "dvb-group-head" }, t("groupEngine")),
                    e("div", { className: "dvb-grid" },
                        fieldShell({ id: "provider", kind: "text", labelKey: "provider" }, { text: state.providerMode, invalid: false }, providerControl),
                        fieldShell(modelField, modelFs, modelControl)),
                    e("div", { className: "dvb-actions" }, testButton),
                    testLine,
                    e("div", { className: "dvb-grid" },
                        fieldShell(baseURLField, baseURLFs, baseURLControl, baseURLNotes),
                        fieldShell(credentialField, credentialFs, credentialControl, credentialNotes)));

                function credentialErrorNote() {
                    // "conflict" is unreachable since the 11.8-6 revision
                    // (paste-key set() overwrites by design); the dead branch
                    // and its misleading copy were removed (code review #5).
                    if (state.credentialError.kind === "empty") {
                        return e("span", { key: "cred-err", className: "dvb-hint dvb-hint-error" }, t("credentialEmptyKey"));
                    }
                    return e("span", { key: "cred-err", className: "dvb-hint dvb-hint-error" },
                        t("credentialWriteFailed") + (typeof state.credentialError.message === "string" ? " — " + state.credentialError.message : ""));
                }
            }

            /** ② Trigger & output group. */
            function triggerGroup() {
                return e("div", { className: "dvb-group" },
                    e("div", { className: "dvb-group-head" }, t("groupTrigger")),
                    e("div", { className: "dvb-grid" },
                        simpleField(FIELD_BY_ID.get("mode")),
                        simpleField(FIELD_BY_ID.get("language"))),
                    simpleField(FIELD_BY_ID.get("promptExtra")));
            }

            /** Advanced group — collapsed by default (§11.1 story 5). */
            function advancedGroup() {
                return e("div", { className: "dvb-group" },
                    e("button", {
                        type: "button",
                        className: "dvb-adv-toggle",
                        onClick: () => { props.toggleAdvanced(); },
                    }, (state.advancedOpen ? "▾ " : "▸ ") + t("groupAdvanced")),
                    state.advancedOpen ? e("div", { className: "dvb-grid" },
                        simpleField(FIELD_BY_ID.get("outputFormat")),
                        simpleField(FIELD_BY_ID.get("timeoutMs")),
                        simpleField(FIELD_BY_ID.get("concurrency")),
                        simpleField(FIELD_BY_ID.get("maxPerTurn"))) : null);
            }

            /** ③ Environment check panel (§11.3E, admission item two-faced per §12). */
            function envGroup() {
                const admission = state.env?.admission;
                const seam = state.env?.seam;
                const modlens = state.env?.modlens;
                const connectivityOk = state.test.status === "ok";
                // §12.2 B: ✓ only when the disk marker is present AND the running
                // gate was observed as lazy. A live gate (disk repaired, this
                // process still old) or an unverified runtime is never a ✓ —
                // the 9/9 incident was exactly "UI says ✓ while the server
                // rejects".
                const admissionOk = admission?.disk === "patched" && admission?.runtime === "dead";
                const modlensOk = modlens?.conflict !== true;
                // §4.6 row verdicts. `live` is a TRI-state (true / false / null)
                // and ONLY true may ever render as ✓; a marker without a passing
                // behaviour self-proof is a residue, never a ✓.
                const seamLive = seam?.live === true;
                const seamInstalled = seam?.status === "installed" || seam?.status === "already";
                // F3/N-B2-4: a REAL residue comes from the server flag (mark
                // present, method is not our layer). "Installed but not
                // self-proven" is NOT a residue — row 1 already reports that,
                // neutrally; warning here too would contradict it.
                const seamResidue = seam?.residue === true;
                // Row 1's NEUTRAL state: installed, but the behaviour self-proof
                // has not passed. It may never be hidden behind "environment
                // ready" — the collapsed line exists only for a proven path.
                const seamUnproven = seamInstalled && !seamLive;
                const reader = readerVerdict();
                // The collapsed summary may only appear when the four §4.6 rows
                // would all be ✓/not-applicable — otherwise it would hide an
                // unproven seam behind an "environment ready" line.
                // F1: the disk patch is a WORKING path — a deployment that runs
                // on it while the seam is off/unavailable must still be able to
                // reach "environment ready" (v0.2.0 admitted it). F3: an
                // installed-but-unproven seam never collapses.
                const allOk = connectivityOk && (seamLive || admissionOk)
                    && !seamUnproven && !seamResidue && reader.ok && modlensOk;

                const rows = [];
                if (allOk) {
                    rows.push(e("div", { key: "ready", className: "dvb-env-row dvb-ok" }, t("envReady")));
                } else {
                    rows.push(connectivityRow());
                    rows.push(seamRow());
                    rows.push(markerRow());
                    rows.push(readerRow());
                    rows.push(envRow("admission"));
                    rows.push(envRow("modlens"));
                }

                return e("div", { className: "dvb-env" },
                    e("div", { className: "dvb-env-head" },
                        e("div", { className: "dvb-group-head" }, t("envTitle")),
                        e("button", {
                            type: "button",
                            className: "dvb-mini",
                            onClick: () => { props.refreshEnv(); },
                        }, t("envRecheck"))),
                    state.envStatus === "loading" ? e("div", { className: "dvb-unknown" }, t("envLoading")) : null,
                    state.envStatus === "failed" ? e("div", { className: "dvb-warn" }, t("envFailed")) : null,
                    ...rows);

                function connectivityRow() {
                    const status = state.test.status;
                    let text;
                    let cls;
                    if (status === "ok") {
                        cls = "dvb-ok";
                        text = t("connOk") + " — " + (typeof state.test.model === "string" ? state.test.model : "")
                            + " · " + t("testLatency") + " " + String(state.test.latencyMs ?? "?") + " ms";
                    } else if (status === "fail") {
                        cls = "dvb-warn";
                        text = t("testFail") + " — " + errorMessageText(t, state.test.code, state.test.message);
                    } else {
                        cls = "dvb-unknown";
                        text = t("connUnverified");
                    }
                    return e("div", { key: "conn", className: "dvb-env-row" },
                        e("span", { className: cls }, t("connRow")),
                        e("span", { className: "dvb-row-text " + cls }, text));
                }

                /** One §4.6 row: label + optional server reason + a Details toggle
                 * when there is an explanation to show. */
                function explainRow(key, cls, label, text, explain) {
                    const actions = [];
                    if (explain != null) {
                        actions.push(e("button", {
                            type: "button",
                            className: "dvb-adv-toggle",
                            onClick: () => { props.toggleExplain(key); },
                        }, t("explainToggle")));
                    }
                    const parts = [
                        e("div", { key: "row", className: "dvb-env-row" },
                            e("span", { className: cls }, label),
                            e("span", { className: "dvb-row-text " + cls }, text),
                            ...actions),
                    ];
                    if (explain != null && state.explainOpen[key] === true) {
                        parts.push(e("div", { key: "explain", className: "dvb-explain" }, explain));
                    }
                    return e("div", { key }, ...parts);
                }

                /** §4.6 row 1 — the runtime seam itself. */
                function seamRow() {
                    const reason = typeof seam?.reason === "string" && seam.reason !== ""
                        ? t("seamReason") + seam.reason : "";
                    if (seamLive) {
                        return explainRow("seam", "dvb-ok", t("seamLive"), reason, t("seamLiveExplain"));
                    }
                    if (seam?.status === "off") {
                        return explainRow("seam", "dvb-unknown", t("seamOff"), reason, t("seamOffExplain"));
                    }
                    if (seam?.status === "unsupported") {
                        return explainRow("seam", "dvb-warn", t("seamUnsupported"), reason, t("seamUnsupportedExplain"));
                    }
                    if (seamInstalled) {
                        // Deliberately NEUTRAL: installed is not proven (§4.6).
                        return explainRow("seam", "dvb-unknown", t("seamUnproven"), reason, t("seamUnprovenExplain"));
                    }
                    return explainRow("seam", "dvb-unknown", t("seamUnknown"), reason, null);
                }

                /** §4.6 row 2 — marker residue (B2/R8: the mark can outlive the
                 * seam; a marked install whose self-proof failed is reported as
                 * exactly that, and is never a ✓). */
                function markerRow() {
                    if (seamResidue) {
                        return explainRow("seam-marker", "dvb-warn", t("markerResidue"),
                            t("markerResidueHint"), t("markerResidueExplain"));
                    }
                    if (seamInstalled) {
                        return explainRow("seam-marker", "dvb-ok", t("markerOk"), "", null);
                    }
                    return explainRow("seam-marker", "dvb-unknown", t("markerAbsent"), "", null);
                }

                /** §4.5 reader precondition, as far as this card can see it: the
                 * credential the draft names (a describe() fact) plus an explicit
                 * endpoint/model. Configuration availability, NOT connectivity. */
                function readerVerdict() {
                    if (seam?.status === "off") return { kind: "off", ok: true };
                    if (seam?.requireReader === false) return { kind: "disabled", ok: false };
                    const credential = String(state.fields?.credential?.text ?? "").trim();
                    const baseURL = String(state.fields?.baseURL?.text ?? "").trim();
                    const model = String(state.fields?.model?.text ?? "").trim();
                    if (credential === "") return { kind: "missing", ok: false };
                    const check = state.credentialCheck;
                    if (check === null || check === undefined || check.status === "unknown") {
                        return { kind: "unknown", ok: false };
                    }
                    if (check.status !== "ok") return { kind: "missing", ok: false };
                    if (baseURL === "" || model === "") return { kind: "endpoint", ok: false };
                    return { kind: "ok", ok: true };
                }

                /** §4.6 row 3 — reader availability. */
                function readerRow() {
                    const verdict = reader.kind;
                    if (verdict === "off") return explainRow("seam-reader", "dvb-unknown", t("readerOff"), "", null);
                    if (verdict === "disabled") return explainRow("seam-reader", "dvb-warn", t("readerDisabled"), "", t("readerDisabledExplain"));
                    if (verdict === "ok") return explainRow("seam-reader", "dvb-ok", t("readerOk"), "", t("readerOkExplain"));
                    if (verdict === "missing") return explainRow("seam-reader", "dvb-warn", t("readerMissing"), "", t("readerMissingExplain"));
                    if (verdict === "endpoint") return explainRow("seam-reader", "dvb-unknown", t("readerEndpointUnset"), "", t("readerOkExplain"));
                    return explainRow("seam-reader", "dvb-unknown", t("readerUnknown"), "", t("readerUnknownExplain"));
                }

                function envRow(target) {
                    const isAdmission = target === "admission";
                    // §4.6 row 4: while the seam is live the disk patch is
                    // superseded — report that instead of a §12 verdict, and offer
                    // no one-click fix (there is nothing left to repair).
                    if (isAdmission && seamLive) {
                        return explainRow("admission", "dvb-ok", t("legacySuperseded"), "",
                            t("legacySupersededExplain"));
                    }
                    // Admission verdicts (§12.2 B). `disk` = the marker on disk,
                    // `runtime` = the behavior probe's reading of the loaded gate.
                    const admissionMissing = isAdmission && admission?.disk === "missing";
                    const admissionLive = isAdmission && admission?.disk === "patched" && admission?.runtime === "live";
                    const admissionUnverified = isAdmission && admission?.disk === "patched"
                        && admission?.runtime !== "dead" && admission?.runtime !== "live";
                    const admissionUnknown = isAdmission && !admissionMissing && !admissionLive
                        && !admissionUnverified && admission?.disk !== "patched";
                    const conflict = !isAdmission && modlens?.conflict === true;
                    const unknownState = isAdmission ? (admissionUnverified || admissionUnknown) : modlens?.paste === "unknown";
                    const ok = isAdmission ? admissionOk : (!conflict && !unknownState);
                    const warn = isAdmission ? admissionMissing : conflict;
                    const label = isAdmission
                        ? (admissionMissing ? t("admissionMissing")
                            : admissionLive ? t("admissionLive")
                                : admissionOk ? t("admissionOk")
                                    : admissionUnverified ? t("admissionUnverified") : t("admissionUnknown"))
                        : (conflict ? t("modlensConflict") : unknownState ? t("modlensUnknown") : t("modlensOk"));
                    const cls = warn ? "dvb-warn" : ok ? "dvb-ok" : "dvb-unknown";
                    const actions = [];
                    if (warn) {
                        actions.push(e("button", {
                            type: "button",
                            className: "dvb-mini",
                            disabled: state.fixing !== null,
                            onClick: () => { props.runFix(target); },
                        }, isAdmission ? t("fixAdmission") : t("fixModlens")));
                        actions.push(e("button", {
                            type: "button",
                            className: "dvb-adv-toggle",
                            onClick: () => { props.toggleExplain(target); },
                        }, t("explainToggle")));
                    } else if (isAdmission && (admissionLive || admissionUnverified)) {
                        // Nothing to fix: the disk is already repaired (the
                        // only remaining step is the restart, §12.2 C) or the
                        // runtime state is simply unobservable here.
                        actions.push(e("button", {
                            type: "button",
                            className: "dvb-adv-toggle",
                            onClick: () => { props.toggleExplain(target); },
                        }, t("explainToggle")));
                    }
                    const parts = [
                        e("div", { key: "row", className: "dvb-env-row" },
                            e("span", { className: cls }, label),
                            e("span", { className: "dvb-row-text " + cls }, fixMessageText(target)),
                            ...actions),
                    ];
                    const explainOpen = (warn || (isAdmission && (admissionLive || admissionUnverified)))
                        && state.explainOpen[target];
                    if (explainOpen) {
                        parts.push(e("div", { key: "explain", className: "dvb-explain" },
                            isAdmission
                                ? (admissionLive ? t("admissionLiveExplain")
                                    : admissionUnverified ? t("admissionUnverifiedExplain") : t("admissionExplain"))
                                : t("modlensExplain")));
                    }
                    return e("div", { key: target }, ...parts);
                }

                function fixMessageText(target) {
                    const message = state.fixMessage;
                    if (message === null || message.target !== target) return "";
                    if (message.kind === "applied") return t("fixApplied");
                    if (message.kind === "already") return t("fixAlready");
                    return t("fixFailed") + (typeof message.message === "string" && message.message !== "" ? " — " + message.message : "");
                }
            }

            const badges = [
                e("span", { key: "mode", className: "dvb-badge" }, "mode: " + state.fields.mode.text),
            ];
            if (state.test.status === "ok") {
                badges.push(e("span", { key: "conn", className: "dvb-badge dvb-badge-ok" }, t("badgeConnected")));
            }

            return e("section", { className: "dvb-card", "data-dsh-plugin": name },
                e("div", { className: "dvb-headrow" },
                    e("h3", null, t("cardTitle")),
                    e("div", { className: "dvb-badges" }, badges)),
                e("p", null, t("description")),
                state.status === "loading"
                    ? e("p", { className: "dvb-muted" }, t("loading"))
                    : e(react.Fragment, null,
                        state.status === "unavailable"
                            ? e("p", { className: "dvb-muted", role: "status" }, t("settingsUnavailable"))
                            : state.writable ? null : e("p", { className: "dvb-muted" }, t("readOnly")),
                        state.failed ? e("p", { className: "dvb-error", role: "alert" }, t("saveRejected")) : null,
                        engineGroup(),
                        triggerGroup(),
                        advancedGroup(),
                        envGroup(),
                        e("div", { className: "dvb-actions" },
                            e("button", {
                                type: "button",
                                disabled: disabled || !state.dirty || state.invalid,
                                onClick: () => { props.save(); },
                            }, state.saving ? t("saving") : t("save")),
                            state.savedFlash ? e("span", { key: "saved", className: "dvb-badge dvb-badge-ok", role: "status" }, t("savedFlash")) : null,
                            e("button", {
                                type: "button",
                                className: "dvb-reset",
                                disabled: state.saving || !state.dirty,
                                onClick: () => { props.discard(); },
                            }, t("reset")),
                            state.invalid ? e("span", { className: "dvb-hint dvb-hint-error" }, t("invalidDraft")) : null)));
        }

        function apply(ctx) {
            ctx.effect(installStyles, "dsh-vision-bridge/client: styles");
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), "dsh-vision-bridge/client: locale");
            // §4-D: no settings face is taken here — the source re-resolves it
            // on every operation, so a service arriving after this apply is
            // picked up instead of being declared into a dead wait.
            const source = createSettingsSource(ctx);
            const controller = new VisionBridgeCardController(
                source,
                () => readService(ctx, "remote.credentials") ?? readService(ctx, "remote")?.credentials,
            );
            // §4-E: the card's registration reset and the controller's
            // subscription / wake-up poll all ride this one effect, so a
            // re-entrant apply cannot leave a stale mount behind.
            ctx.effect(() => {
                const unmount = mountCard(ctx, controller);
                return () => {
                    unmount();
                    controller.dispose();
                };
            }, "dsh-vision-bridge/client: card");
        }

        exports.name = name;
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
    }
});
