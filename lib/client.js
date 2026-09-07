window.__ModuleLoader__.load({
    id: "@dsh-external/dsh-vision-bridge",
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        const react = require("react");

        // Browser half of dsh-vision-bridge (design §10.3B): one card in the
        // Plugins settings page over the `vision-bridge` settings namespace.
        // Plain JavaScript only — no JSX, no TypeScript, no build step. The
        // factory body has zero side effects; everything mounts in apply(ctx).

        const name = "@dsh-external/dsh-vision-bridge";
        const inject = ["slots", "settingsScope", "locale"];

        const SETTINGS_NS = "vision-bridge";
        const LOCALE_NS = "vision-bridge-ui";
        const SLOT_NAME = "settings.plugin.item";
        const MAX_PROMPT_EXTRA = 2000;

        const css = `
.dvb-card{display:grid;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-fg-primary,#26231f)}
.dvb-card h3{margin:0;font-size:13px}
.dvb-card p{margin:0;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.5}
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
.dvb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dvb-actions button{padding:6px 14px;border-radius:999px;border:0;background:#6758d4;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.dvb-actions button:disabled{opacity:.55;cursor:default}
.dvb-actions .dvb-reset{background:var(--dsw-alias-bg-layer-2,#f7f5f1);color:var(--dsw-alias-fg-primary,#26231f);border:1px solid var(--dsw-alias-border-subtle,#dedbd5)}
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
            title: "Vision Bridge",
            description: "Session screenshots are read by a vision-language model for text-only chats (tool, auto, or both).",
            providerBaseURL: "Base URL",
            providerModel: "Model",
            providerPlaceholder: "Leave empty = first-run frozen default",
            credential: "Credential reference",
            credentialHint: "Stored DSH credential name holding the API key (a name, not the key itself).",
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
            reset: "Reset",
            saveRejected: "The save was rejected (likely an invalid value); the previous configuration keeps serving. Your draft is kept.",
            invalidDraft: "Fix the highlighted fields before saving.",
            invalidNumber: "Enter a number, or leave empty for the default.",
            readOnly: "Settings are read-only right now.",
            loading: "Loading configuration…",
        };

        const zh = {
            title: "Vision 截图代读",
            description: "纯文本模型的会话截图由视觉模型代读（tool / auto / both 三种触发模式）。",
            providerBaseURL: "Base URL",
            providerModel: "模型",
            providerPlaceholder: "留空 = 使用首运行固化默认",
            credential: "凭证引用名",
            credentialHint: "DSH 凭证条目名（存 API Key 的名字，不是密钥本身）。",
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
            reset: "重置",
            saveRejected: "保存被拒绝（可能是非法值）；旧配置继续生效，草稿已保留。",
            invalidDraft: "请先修正标红的字段再保存。",
            invalidNumber: "请输入数字，留空使用默认值。",
            readOnly: "当前设置只读。",
            loading: "正在读取配置…",
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

        /** Draft text shown for one field's current effective value. */
        function formatValue(field, value) {
            if (field.kind === "number") return typeof value === "number" ? String(value) : "";
            if (field.kind === "select") return field.options.includes(value) ? value : field.options[0];
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

        /**
         * Staged form over the bound `vision-bridge` settings scope: the card
         * shows the effective value, edits stay local until Save commits ONE
         * atomic scope.mutate with every change (server validate is the
         * authority — a refused write keeps the draft and flags the failure).
         */
        class VisionBridgeCardController {
            constructor(scope) {
                this.scope = scope;
                this.staged = new Map();
                this.saving = false;
                this.failed = false;
                this.store = createSource(() => this.projection());
                scope.subscribe(() => this.publish());
            }

            publish() {
                this.store.publish();
            }

            snapshot() {
                return this.scope.getSnapshot();
            }

            effective(field) {
                return readPath(this.snapshot().value, field.path);
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

            projection() {
                const view = this.snapshot();
                const { ops, invalid } = this.plan();
                const fields = {};
                for (const field of FIELDS) {
                    const staged = this.staged.get(field.id);
                    fields[field.id] = {
                        text: staged !== undefined ? staged : formatValue(field, readPath(view.value, field.path)),
                        invalid: staged !== undefined && draftInvalid(field, staged),
                    };
                }
                return {
                    available: view.status === "ready",
                    writable: view.writable,
                    dirty: ops.length > 0,
                    invalid,
                    saving: this.saving,
                    failed: this.failed,
                    fields,
                };
            }

            edit(id, text) {
                this.staged.set(id, text);
                this.failed = false;
                this.publish();
            }

            discard() {
                if (this.staged.size === 0 && !this.failed) return;
                this.staged.clear();
                this.failed = false;
                this.publish();
            }

            async save() {
                const { ops, invalid } = this.plan();
                if (ops.length === 0 || invalid || this.saving || !this.snapshot().writable) return;
                this.saving = true;
                this.failed = false;
                this.publish();
                let landed = true;
                try {
                    await this.scope.mutate(ops);
                    const view = this.snapshot();
                    landed = ops.every((op) => this.opLanded(op, view));
                } catch {
                    landed = false;
                }
                if (landed) this.staged.clear();
                else this.failed = true;
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
                };
            }
        }

        function inputId(id) {
            return `vision-bridge-card-${id}`;
        }

        /** The Plugins-page card: locale copy `t`, the card snapshot hook, and
         * the form actions (edit/save/discard) arrive as slot props. */
        function VisionBridgeCard(props) {
            const state = props.useVisionBridgeCard((snapshot) => snapshot);
            const t = props.t;
            const e = react.createElement;
            const disabled = !state.writable || state.saving;

            const fields = FIELDS.map((field) => {
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
                if (field.hintKey !== undefined) {
                    notes.push(e("span", { key: "hint", className: "dvb-hint" }, t(field.hintKey)));
                }
                return e("div", {
                    key: field.id,
                    className: field.kind === "textarea" ? "dvb-field dvb-wide" : "dvb-field",
                    "data-invalid": fs.invalid ? "true" : undefined,
                }, e("label", { htmlFor: id }, t(field.labelKey)), control, ...notes);
            });

            return e("section", { className: "dvb-card", "data-dsh-plugin": name },
                e("h3", null, t("title")),
                e("p", null, t("description")),
                !state.available
                    ? e("p", { className: "dvb-muted" }, t("loading"))
                    : e(react.Fragment, null,
                        state.writable ? null : e("p", { className: "dvb-muted" }, t("readOnly")),
                        state.failed ? e("p", { className: "dvb-error", role: "alert" }, t("saveRejected")) : null,
                        e("div", { className: "dvb-grid" }, fields),
                        e("div", { className: "dvb-actions" },
                            e("button", {
                                type: "button",
                                disabled: disabled || !state.dirty || state.invalid,
                                onClick: () => { props.save(); },
                            }, state.saving ? t("saving") : t("save")),
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
            const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
            const controller = new VisionBridgeCardController(scope);
            ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
                name: SLOT_NAME,
                key: SETTINGS_NS,
                locale: LOCALE_NS,
                inject: () => controller.inject(),
            }, VisionBridgeCard));
        }

        exports.name = name;
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
    }
});
