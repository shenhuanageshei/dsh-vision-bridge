import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_PROMPT_EXTRA_CHARS } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Static shape assertions for the browser half (design §10.3B/§10.6 and the
// §11 v2 card): node --test cannot mount a browser, so the loader protocol,
// slot registration, inject declarations, no-JSX/no-build constraints, and
// the §11 v2 structure (three groups, provider linkage, credential
// three-forms, connectivity probe, environment panel) are asserted against
// the file text, and the package manifest against strict JSON.parse.

const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('lib/client.js — module-loader factory shape', () => {
  it('registers through window.__ModuleLoader__.load as the first statement', () => {
    assert.ok(clientSrc.startsWith('window.__ModuleLoader__.load({'), 'file must open with the loader registration');
    assert.ok(clientSrc.includes('factory: (require) =>'), 'factory receives require');
    assert.ok(clientSrc.includes('return module.exports;'), 'factory returns module.exports');
  });

  it('uses the package id and requires react (no build step)', () => {
    assert.ok(clientSrc.includes('id: "@dsh-external/dsh-vision-bridge"'));
    assert.ok(clientSrc.includes('require("react")'));
    assert.ok(clientSrc.includes('react.createElement'));
  });

  it('declares the client service inject list (§11: remote + remote.credentials added)', () => {
    // §11.2-6: the card needs remote.settings/remote.credentials through the
    // `remote` seam — five service names on the plugin object (M0-2: the
    // settings-plugins built-in card precedent declares exactly remote +
    // remote.credentials).
    assert.ok(clientSrc.includes('["slots", "settingsScope", "locale", "remote", "remote.credentials"]'));
    assert.ok(clientSrc.includes('exports.inject = inject;'));
    assert.ok(clientSrc.includes('exports.apply = apply;'));
    assert.ok(clientSrc.includes('exports.name = name;'));
  });

  it('registers a settings.plugin.item card keyed by the namespace', () => {
    assert.ok(clientSrc.includes('const SLOT_NAME = "settings.plugin.item"'));
    assert.ok(clientSrc.includes('const SETTINGS_NS = "vision-bridge"'));
    assert.ok(clientSrc.includes('key: SETTINGS_NS'));
    assert.ok(clientSrc.includes('ctx.slots.register'));
    assert.ok(clientSrc.includes('ctx.slots.inject(SLOT_NAME'));
  });

  it('binds the settings scope and saves through one atomic mutate', () => {
    assert.ok(clientSrc.includes('ctx.settingsScope.bind({ namespace: SETTINGS_NS })'));
    assert.ok(clientSrc.includes('await this.scope.mutate(plan.ops);'));
  });

  it('registers the bilingual locale dictionary', () => {
    assert.ok(clientSrc.includes('const LOCALE_NS = "vision-bridge-ui"'));
    assert.ok(clientSrc.includes('ctx.locale.register(LOCALE_NS, { en, zh })'));
  });

  it('carries no JSX / TypeScript / build artifacts', () => {
    assert.equal(/jsx-runtime|react\/jsx|\/\*\* @jsx/.test(clientSrc), false, 'no jsx runtime pragma');
    assert.equal(/<\/?[A-Za-z][^>]*>/.test(clientSrc), false, 'no JSX element syntax');
    assert.equal(/:\s*(string|number|boolean|any)\b/.test(clientSrc), false, 'no TypeScript type annotations');
    assert.equal(clientSrc.includes('.tsx'), false);
  });

  it('has zero side effects at module load (DOM touched only inside functions)', () => {
    const head = clientSrc.slice(0, clientSrc.indexOf('function installStyles'));
    assert.equal(head.includes('document.'), false, 'no DOM access before the style installer definition');
    assert.ok(clientSrc.includes('ctx.effect(installStyles'), 'styles mount inside apply via ctx.effect');
  });

  it('covers all ten §10.1 fields including the textarea promptExtra', () => {
    for (const id of ['baseURL', 'model', 'credential', 'mode', 'language', 'promptExtra', 'outputFormat', 'timeoutMs', 'concurrency', 'maxPerTurn']) {
      assert.ok(clientSrc.includes(`id: "${id}"`), `field ${id} must be declared`);
    }
    assert.ok(clientSrc.includes('kind: "textarea"'), 'promptExtra uses a multiline textarea');
    assert.ok(clientSrc.includes('/2000'), 'character counter present');
  });

  it('renders the loading and read-only branches', () => {
    assert.ok(clientSrc.includes('t("loading")'), 'loading branch is rendered');
    assert.ok(clientSrc.includes('t("readOnly")'), 'read-only branch is rendered');
  });

  it('keeps the client draft limit in sync with the server bound', () => {
    const match = clientSrc.match(/MAX_PROMPT_EXTRA\s*=\s*(\d+)/);
    assert.ok(match, 'client MAX_PROMPT_EXTRA constant must exist');
    assert.equal(Number(match[1]), MAX_PROMPT_EXTRA_CHARS, 'client and server promptExtra limits must match');
  });
});

describe('lib/client.js — §11 v2 card structure', () => {
  it('titles the card "dsh-VisionBridge 视觉代读" in both locales (§11.3F)', () => {
    assert.ok(clientSrc.includes('cardTitle: "dsh-VisionBridge Vision Read"'));
    assert.ok(clientSrc.includes('cardTitle: "dsh-VisionBridge 视觉代读"'));
    assert.ok(clientSrc.includes('t("cardTitle")'), 'the card header renders the cardTitle key');
  });

  it('renders the three groups: engine / trigger & output / advanced (§11.3A)', () => {
    assert.ok(clientSrc.includes('function engineGroup()'));
    assert.ok(clientSrc.includes('function triggerGroup()'));
    assert.ok(clientSrc.includes('function advancedGroup()'));
    assert.ok(clientSrc.includes('groupEngine: "Vision engine"'));
    assert.ok(clientSrc.includes('groupEngine: "视觉引擎"'));
    assert.ok(clientSrc.includes('groupTrigger: "Trigger and output"'));
    assert.ok(clientSrc.includes('groupTrigger: "触发与输出"'));
    assert.ok(clientSrc.includes('groupAdvanced: "Advanced (output format · timeout · concurrency · per-turn cap)"'));
    assert.ok(clientSrc.includes('groupAdvanced: "高级设置（输出格式 · 超时 · 并发 · 每轮上限）"'));
  });

  it('collapses the advanced group by default; the toggle flips it (§11.1 story 5)', () => {
    assert.ok(clientSrc.includes('this.advancedOpen = false;'), 'advanced starts collapsed');
    assert.ok(clientSrc.includes('state.advancedOpen ? e("div"'), 'fields render only when open');
    assert.ok(clientSrc.includes('toggleAdvanced()'));
  });

  it('shows the first-seven core fields: provider/model/baseURL/credential/mode/language/promptExtra (§11.1 story 5)', () => {
    assert.ok(clientSrc.includes('id: inputId("provider")'), 'provider dropdown control');
    for (const id of ['model', 'baseURL', 'credential', 'mode', 'language', 'promptExtra']) {
      assert.ok(clientSrc.includes(`id: "${id}"`), `field ${id} must be declared`);
    }
  });

  it('carries the provider linkage functions and the custom sentinel (§11.3B)', () => {
    assert.ok(clientSrc.includes('const CUSTOM_PROVIDER = "__custom";'));
    assert.ok(clientSrc.includes('selectProvider(id)'));
    assert.ok(clientSrc.includes('syncProviderMode()'));
    assert.ok(clientSrc.includes('linkedProviderFromBaseURL()'));
    // custom mode unlocks manual entry with the purple-border visual distinction
    assert.ok(clientSrc.includes('"data-custom": state.providerMode === CUSTOM_PROVIDER ? "true" : undefined'));
    assert.ok(clientSrc.includes('.dvb-group-engine[data-custom="true"]'));
  });

  it('auto-fills model/BaseURL/credential from the selected provider (§11.3B)', () => {
    assert.ok(clientSrc.includes('this.staged.set("baseURL", provider.baseURL)'));
    assert.ok(clientSrc.includes('this.staged.set("credential", provider.apiKeyEnv)'));
    assert.ok(clientSrc.includes('provider.models.find((m) => m.vision)'));
  });

  it('marks vision-capable models with the 👁 glyph in the model options (§11.1 story 1)', () => {
    assert.ok(clientSrc.includes('m.id + " 👁"'));
  });
});

describe('lib/client.js — §11 credential three-forms', () => {
  it('declares the paste and manual sentinel options next to the entry list', () => {
    assert.ok(clientSrc.includes('const PASTE_CREDENTIAL = "__paste";'));
    assert.ok(clientSrc.includes('const MANUAL_CREDENTIAL = "__manual";'));
    assert.ok(clientSrc.includes('t("credentialPasteOption")'));
    assert.ok(clientSrc.includes('t("credentialManualOption")'));
  });

  it('carries the three form controllers (select / paste key+name / manual)', () => {
    assert.ok(clientSrc.includes('selectCredential(value)'));
    assert.ok(clientSrc.includes('editPendingKey(text)'));
    assert.ok(clientSrc.includes('editPendingName(text)'));
    assert.ok(clientSrc.includes('this.credentialMode = "paste"'));
    assert.ok(clientSrc.includes('this.credentialMode = "manual"'));
  });

  it('saves a pasted key through the credential service with overwrite-on-existing (§11.3C form 3, 2026-09-07 revision)', () => {
    assert.ok(clientSrc.includes('await service.set(entry, key)'), 'the key goes to the DSH credential service');
    // User feedback revision: changing a key must NOT require a new entry
    // name — set() overwrites by design; the old describe-precheck/conflict
    // rejection was removed.
    assert.ok(!clientSrc.includes('this.credentialError = { kind: "conflict", name: entry }'), 'no conflict refusal: key rotation overwrites the entry');
    assert.ok(clientSrc.includes('this.staged.set("credential", entry)'), 'only the entry NAME is staged into settings');
    assert.ok(clientSrc.includes('type: state.showKey ? "text" : "password"'), 'the pasted key input is password-masked with a reveal toggle');
    assert.ok(clientSrc.includes('toggleShowKey'), 'reveal toggle method exists');
  });

  it('describes credential candidates through remote.credentials (§11.3C form 1/2)', () => {
    assert.ok(clientSrc.includes('await service.describe(refs)'));
    assert.ok(clientSrc.includes('this.credentialViews'));
  });
});

describe('lib/client.js — §11 connectivity probe and environment panel', () => {
  it('probes through POST /vision-bridge/test with a transient pendingApiKey (§11.3D)', () => {
    assert.ok(clientSrc.includes('async runTest()'));
    assert.ok(clientSrc.includes('fetch("/vision-bridge/test"'));
    assert.ok(clientSrc.includes('body.pendingApiKey = key'), 'a pasted key rides the probe request only');
    assert.ok(clientSrc.includes('t("testConnection")'));
    assert.ok(clientSrc.includes('t("testing")'), 'testing state shown while in flight');
    assert.ok(clientSrc.includes('state.test.status === "testing"'));
  });

  it('renders the admission four-state rows (§12.2 B client, review #2)', () => {
    assert.ok(clientSrc.includes('admissionLive'), 'live-state label key exists');
    assert.ok(clientSrc.includes('admissionUnverified'), 'unverified-state label key exists');
    assert.ok(clientSrc.includes('savedFlash'), 'save-flash badge is rendered (§11.8-9 review #1)');
    assert.ok(clientSrc.includes('const admissionOk = admission?.disk === "patched" && admission?.runtime === "dead"'), 'strict ok gate: disk+runtime both required');
  });
  it('renders the environment check panel with a re-check control (§11.3E)', () => {
    assert.ok(clientSrc.includes('function envGroup()'));
    assert.ok(clientSrc.includes('async refreshEnv()'));
    assert.ok(clientSrc.includes('fetch("/vision-bridge/env")'));
    assert.ok(clientSrc.includes('t("envRecheck")'));
    assert.ok(clientSrc.includes('envTitle: "Environment check"'));
    assert.ok(clientSrc.includes('envTitle: "环境体检"'));
  });

  it('runs the two one-click fixes against the server routes (§11.3E)', () => {
    assert.ok(clientSrc.includes('async runFix(kind)'));
    assert.ok(clientSrc.includes('fetch("/vision-bridge/fix-" + kind'));
    assert.ok(clientSrc.includes('props.runFix(target)'));
    assert.ok(clientSrc.includes('t("fixAdmission")'));
    assert.ok(clientSrc.includes('t("fixModlens")'));
    assert.ok(clientSrc.includes('t("fixApplied")'), 'fix feedback mentions the restart requirement');
  });

  it('carries the admission and modlens rows with their human explanations (§11.3E)', () => {
    assert.ok(clientSrc.includes('admissionMissing: "Admission patch not applied"'));
    assert.ok(clientSrc.includes('admissionMissing: "准入补丁未生效"'));
    assert.ok(clientSrc.includes('modlensConflict: "modlens paste conflict"'));
    assert.ok(clientSrc.includes('modlensConflict: "modlens 粘贴冲突"'));
    assert.ok(clientSrc.includes('t("admissionExplain")'));
    assert.ok(clientSrc.includes('t("modlensExplain")'));
    assert.ok(clientSrc.includes('t("envReady")'), 'the all-✓ collapsed summary exists');
  });

  it('collapses the environment panel to one green line when everything is ok (§11.3E)', () => {
    assert.ok(clientSrc.includes('const allOk = connectivityOk && admissionOk && modlensOk;'));
    assert.ok(clientSrc.includes('if (allOk) {'));
  });
});

describe('package.json — dsh.client declaration', () => {
  it('exposes ./client', () => {
    assert.equal(pkg.exports['./client'], './lib/client.js');
  });

  it('declares the web client half with the four host packages (§11.2-6: +dsh-api-remotes)', () => {
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.deepEqual(pkg.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-api-remotes',
    ]);
  });

  it('ships lib/client.js in files', () => {
    assert.equal(pkg.files.includes('lib/client.js') || pkg.files.includes('lib'), true);
  });
});
