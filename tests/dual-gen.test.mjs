/**
 * Dual-generation (0.1.6 / 0.1.7) coverage for the SERVER half of the compat
 * layer (design §2.1-7/9/18, §2.4, §4-A/B/C, §7-1..5, §7-7, §7-13):
 *
 * - generation dispatch (`usesLegacySettings`) and the two settings assemblies;
 * - 0.1.7 reads: volatile references unwrapped exactly like the 0.1.6 handle's
 *   plain section, and what a committed update does to the runtime;
 * - validation interception (`internal/config`) and refuse-and-keep-old;
 * - cross-namespace reads (`settings.get(ns)` vs `settings.describe()`) and the
 *   provider projection that feeds the card's dropdown;
 * - the attachment request projection (`projectRequestDimensions`).
 *
 * The two fake contexts model the two FACES, not host versions:
 * - legacy: `ctx.settings.register(ns, schema, { base, applies, validate })`
 *   returns a handle (`.get()` / `.watch()`) and hands over PLAIN values — the
 *   pre-volatile schemastery has no `.volatile()`, so nothing marks the schema
 *   (see `_plain-section.mjs` for the full argument);
 * - new: no `register` at all; the editable schema nodes arrive as `{ get() }`
 *   references embedded in the config `apply()` received, the loader writes new
 *   values into the SAME reference and re-emits
 *   (`cordis-plugin-loader/lib/index.js:393-425`; the write is cosmokit's
 *   `updateVolatile(target, source)` = `target[write](source.get())`).
 *
 * `apply()` side effects are pinned to temp dirs (DSH_HOME + the hermetic
 * self-heal target) so no test touches real host state.
 */
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, resetSelfHealCache } from '../lib/index.js';
import { Config } from '../lib/config.js';
import { projectRequestDimensions } from '../lib/request-dimensions.js';
import { projectProviders } from '../lib/server-routes.js';
import {
  NO_VOLATILE_REFS_WARN,
  REF_READ_FAILED_WARN,
  installVolatileSettings,
  readSettingsNamespace,
  snapshotOf,
  usesLegacySettings,
} from '../lib/settings-compat.js';
import { plainSection } from './_plain-section.mjs';

const tmpDirs = [];
function makeDir(prefix = 'dvb-dual-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
let restoreEnv = () => {};
afterEach(() => {
  restoreEnv();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Hermetic default for every apply() call below: DSH_HOME and the self-heal
 * scan target live in a temp root, so no test reads or writes real host state.
 * Tests that need their own root re-pin inside the body. */
beforeEach(() => { restoreEnv = pinEnv(makeDir('dvb-dual-env-')); });

/** Logger whose lines can be asserted on (same shape the other suites use). */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  const record = (level) => (...args) => {
    lines[level].push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg?.message ?? arg))).join(' '));
  };
  return { lines, info: record('info'), warn: record('warn'), error: record('error') };
}
const warned = (logger, fragment) => logger.lines.warn.some((line) => line.includes(fragment));
const logged = (logger, level, fragment) => logger.lines[level].some((line) => line.includes(fragment));

/** The startup self-heal scans the pinned (empty) temp node_modules and reports
 * the absent gate once — an environment condition this suite does not own
 * (tests/self-heal.test.mjs covers that path). Every OTHER error line is a
 * finding. */
const SELF_HEAL_FAILED = 'admission gate self-heal failed';
const errorsBesidesSelfHeal = (logger) => logger.lines.error.filter((line) => !line.includes(SELF_HEAL_FAILED));

/** A volatile reference whose value can be replaced in place — the observable
 * contract a loader commit produces (later `.get()` reads see the new value). */
function volRef(initial) {
  let value = initial;
  return {
    get: () => value,
    put: (next) => { value = next; },
  };
}

/** A reference whose getter throws (a host-side broken read). */
function throwingRef(message = 'reference exploded') {
  return { get() { throw new Error(message); } };
}

/** Pin the two process-global inputs apply() reads (DSH_HOME, the hermetic
 * self-heal target) to the temp root; returns the restore function. */
function pinEnv(root) {
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    VISION_BRIDGE_SELF_HEAL_NM: process.env.VISION_BRIDGE_SELF_HEAL_NM,
  };
  process.env.DSH_HOME = root;
  process.env.VISION_BRIDGE_SELF_HEAL_NM = path.join(root, 'nm');
  resetSelfHealCache();
  return () => {
    resetSelfHealCache();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const TOOLKIT_VALUE = {
  provider: { baseUrl: 'https://toolkit.example/v1', model: 'toolkit-vl', credential: 'TOOLKIT_KEY' },
};
const TOOLKIT_ROW = { ns: 'vision-toolkit', value: TOOLKIT_VALUE };

function attachmentFake() {
  const seen = {};
  return {
    seen,
    service: {
      async readImageRequest(ref, target, signal) {
        seen.ref = ref;
        seen.target = target;
        seen.signal = signal;
        return { variantId: 'v1', attachment: ref, data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' };
      },
    },
  };
}

/** 0.1.6-shaped context: a register handle + `settings.get(ns)`. */
function legacyCtx({ logger = makeLogger(), toolkit = TOOLKIT_VALUE } = {}) {
  const registered = { settings: [], handlers: new Map(), tools: [], contexts: [] };
  const attachment = attachmentFake();
  let scope;
  const ctx = {
    logger: () => logger,
    agents: {},
    get() { return undefined; },
    on(name, handler) {
      const list = registered.handlers.get(name) ?? [];
      list.push(handler);
      registered.handlers.set(name, list);
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1); };
    },
    effect(fn) { return fn(); },
    tools: { register(def) { registered.tools.push(def); return () => {}; } },
    systemPrompt: { context(text) { registered.contexts.push(text); return () => {}; } },
    settings: {
      register(ns, schema, options = {}) {
        registered.settings.push({ ns, schema, options });
        const state = { user: {}, watchers: [] };
        const resolved = () => plainSection(schema({ ...(options.base ?? {}), ...state.user }));
        // The real handle refuses an invalid stored section at registration.
        options.validate?.(resolved());
        scope = {
          get: resolved,
          watch(cb) { state.watchers.push(cb); return () => {}; },
          async update(patch) {
            const candidate = plainSection(schema({ ...(options.base ?? {}), ...state.user, ...patch }));
            options.validate?.(candidate); // refused BEFORE the user layer moves
            state.user = { ...state.user, ...patch };
            const value = resolved();
            for (const watcher of state.watchers) await watcher(value);
          },
        };
        return scope;
      },
      get(ns) { return ns === 'vision-toolkit' ? toolkit : undefined; },
    },
    credentials: { async resolve() { return { value: 'sk-test', source: 'env' }; } },
    attachments: attachment.service,
    registered,
  };
  Object.defineProperty(ctx, 'settingsScope', { get: () => scope });
  return { ctx, registered, attachment, logger };
}

/** 0.1.7-shaped context: `settings.describe()` only, no register/get. */
function newGenCtx({ rows = [TOOLKIT_ROW], logger = makeLogger(), inject = false } = {}) {
  const registered = { handlers: new Map(), tools: [], contexts: [], injects: [], describeCalls: 0 };
  const attachment = attachmentFake();
  const ctx = {
    logger: () => logger,
    agents: {},
    get() { return undefined; },
    on(name, handler) {
      const list = registered.handlers.get(name) ?? [];
      list.push(handler);
      registered.handlers.set(name, list);
      return () => { const at = list.indexOf(handler); if (at >= 0) list.splice(at, 1); };
    },
    effect(fn) { return fn(); },
    tools: { register(def) { registered.tools.push(def); return () => {}; } },
    systemPrompt: { context(text) { registered.contexts.push(text); return () => {}; } },
    settings: {
      describe() {
        registered.describeCalls += 1;
        if (typeof rows === 'function') return rows();
        return rows;
      },
    },
    credentials: { async resolve() { return { value: 'sk-test', source: 'env' }; } },
    attachments: attachment.service,
    registered,
  };
  if (inject) ctx.inject = (list, callback) => { registered.injects.push({ list, callback }); return () => {}; };
  return { ctx, registered, attachment, logger };
}

const handlersOf = (registered, name) => registered.handlers.get(name) ?? [];

/** Fire every handler of an event the way the emitting side does: `this` is the
 * fiber-scoped emitter object the loader passes (`Object.create(fiber.ctx)`);
 * `null` models an emitter without a ctx (owner guard must let it through). */
function fire(registered, name, { owner = null, args = [] } = {}) {
  const calls = [];
  for (const handler of handlersOf(registered, name)) {
    calls.push(handler.apply(owner ?? {}, args));
  }
  return calls;
}

/** 0.1.7 config: volatile nodes are references, the rest are plain values —
 * exactly the mark set of `lib/config.js` (`cache`, `maxImageBytes`,
 * `maxImagePixels` are NOT volatile). */
function newGenConfig({
  model = 'new-gen-m1',
  baseURL = 'https://new.example/v1',
  persistDir,
  language = 'zh',
  promptExtra = '',
  maxImagePixels = 1000000,
  mode = 'both',
} = {}) {
  return {
    mode: volRef(mode),
    provider: volRef({ baseURL, model }),
    credential: volRef('VISION_API_KEY'),
    timeoutMs: volRef(60000),
    concurrency: volRef(2),
    cache: { maxEntries: 256, persistDir },
    maxImageBytes: 10485760,
    maxImagePixels,
    visionCapabilities: volRef({ outputFormat: 'auto' }),
    language: volRef(language),
    promptExtra: volRef(promptExtra),
    autoMode: volRef({ maxPerTurn: 3 }),
  };
}

/** 0.1.6 config: the same user values, plain (the handle schema-resolves it). */
function legacyConfig({
  model = 'legacy-m1',
  baseURL = 'https://legacy.example/v1',
  persistDir,
  language,
  promptExtra,
  maxImagePixels,
  credential = 'VISION_API_KEY',
  mode,
} = {}) {
  const config = { provider: { baseURL, model }, credential, cache: { persistDir } };
  if (mode !== undefined) config.mode = mode;
  if (language !== undefined) config.language = language;
  if (promptExtra !== undefined) config.promptExtra = promptExtra;
  if (maxImagePixels !== undefined) config.maxImagePixels = maxImagePixels;
  return config;
}

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const PREFIX_A = ID_A.slice(7, 15);
const REF_A = { attachmentId: ID_A, mediaType: 'image/png', bytes: 4, width: 4000, height: 3000 };
function sessionWithImages() {
  return {
    snapshotEvents: () => [{
      type: 'user/message', seq: 1, time: 1,
      data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'image', attachment: { ...REF_A } }] },
    }],
  };
}

/** Stub the engine's HTTP face and record every request. */
function stubFetch() {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body, text: body?.messages?.[0]?.content?.[0]?.text });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'image_overview: dual-gen ok' } }] }),
    };
  };
  return { calls, restore() { globalThis.fetch = real; } };
}

/** Drive the mounted tool (the only public face of the runtime state). */
async function readViaTool(registered, question = 'what is on screen') {
  const tool = registered.tools[0];
  assert.ok(tool, 'the tool must be mounted');
  return tool.execute({ ref: PREFIX_A, question }, {
    agent: { session: sessionWithImages() },
    signal: new AbortController().signal,
  });
}

// ---------------------------------------------------------------------------
// §7-1/9 — generation dispatch
// ---------------------------------------------------------------------------
describe('§7-1/9 — generation dispatch (capability probe, never a version)', () => {
  it('usesLegacySettings asks for a function-valued settings.register and nothing else', () => {
    const cases = [
      [{ settings: { register() {} } }, true, 'register function'],
      [{ settings: { register: async () => {} } }, true, 'async register function'],
      [{ settings: { register: () => {}, describe() {} } }, true, 'mixed face: register present'],
      [{ settings: { register: '0.1.6' } }, false, 'register present but not a function'],
      [{ settings: { register: null } }, false, 'register null'],
      [{ settings: { describe() {} } }, false, 'new face (describe only)'],
      [{ settings: {} }, false, 'neither face'],
      [{ settings: null }, false, 'settings null'],
      [{}, false, 'settings missing'],
      [undefined, false, 'ctx undefined'],
      [null, false, 'ctx null'],
    ];
    for (const [ctx, expected, label] of cases) {
      assert.equal(usesLegacySettings(ctx), expected, label);
    }
  });

  it('the register call is kept for 0.1.6 and sits inside the capability guard (§7-5②)', () => {
    // F5's second half is graded in the "occurrences sit inside the guard" form
    // (never "the call is gone"): the 0.1.6 branch must keep registering, and
    // no 0.1.7 path may reach the call. Source scan here; the behavioural twin
    // is the two apply() faces asserted around it.
    const indexSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    const occurrences = [...indexSource.matchAll(/ctx\.settings\.register\(/g)];
    assert.ok(occurrences.length >= 1, 'the 0.1.6 branch keeps its register call');
    for (const { index } of occurrences) {
      const lineStart = indexSource.lastIndexOf('\n', index) + 1;
      const newline = indexSource.indexOf('\n', index);
      const line = indexSource.slice(lineStart, newline === -1 ? undefined : newline);
      assert.match(line, /\?\s*ctx\.settings\.register\(/, 'every occurrence is an arm of the guarded dispatch');
    }
    const guardAt = indexSource.indexOf('usesLegacySettings(ctx)');
    assert.ok(guardAt !== -1, 'the dispatch evaluates the capability probe');
    assert.ok(guardAt < occurrences[0].index, 'the probe comes before the call it guards');
  });

  it('the self-heal call precedes the first settings-face call in index.js (§7-8)', () => {
    // F8's machine-checkable half: on a kernel whose settings face throws, the
    // repair — which needs no settings face — must already have run. Graded on
    // call sites only, so the one occurrence that is the definition can never
    // satisfy the test by accident.
    const indexSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    const callSites = [...indexSource.matchAll(/selfHealAdmissionGate\(/g)]
      .filter(({ index }) => !/function\s+$/.test(indexSource.slice(Math.max(0, index - 40), index)));
    assert.ok(callSites.length >= 1, 'the self-heal call site is findable');
    const capabilityProbe = indexSource.indexOf('usesLegacySettings(ctx)');
    const registerCall = indexSource.indexOf('ctx.settings.register(');
    assert.ok(capabilityProbe !== -1 && registerCall !== -1, 'the settings-face anchors are findable');
    for (const { index } of callSites) {
      assert.ok(index < capabilityProbe, 'the self-heal runs before the capability probe');
      assert.ok(index < registerCall, 'the self-heal runs before the register call');
    }
  });

  it('0.1.6 face: apply() registers the namespace through the handle and mounts everything else', async () => {
    const dir = makeDir();
    const { ctx, registered, logger } = legacyCtx();
    const config = legacyConfig({ persistDir: path.join(dir, 'cache') });
    const disposer = await apply(ctx, config);

    assert.equal(registered.settings.length, 1, 'exactly one register call');
    const call = registered.settings[0];
    assert.equal(call.ns, 'vision-bridge', 'namespace is contractual');
    assert.equal(call.schema, Config, 'the schema itself is registered');
    assert.equal(call.options.applies, 'live', 'live updates');
    assert.equal(typeof call.options.validate, 'function', 'validate hook passed');
    assert.equal(call.options.base, config, 'the apply() config is the composition base');
    assert.equal(ctx.settingsScope.get().provider.model, 'legacy-m1');
    assert.deepEqual(handlersOf(registered, 'internal/config'), [], 'the 0.1.7 interception point is not installed on the legacy face');
    assert.equal(handlersOf(registered, 'session/event').length, 1);
    assert.equal(handlersOf(registered, 'agent/pre-step').length, 1);
    assert.equal(handlersOf(registered, 'agent/created').length, 1);
    assert.equal(registered.contexts.length, 1, 'PromptContext fallback');
    assert.equal(registered.tools.length, 1);
    assert.equal(registered.tools[0].name, 'vision_bridge_read');
    assert.deepEqual(errorsBesidesSelfHeal(logger), [], 'no error line on a healthy load');
    await disposer();
  });

  it('0.1.7 face: apply() installs the volatile face; the legacy call is unreachable', async () => {
    const dir = makeDir();
    const { ctx, registered, logger } = newGenCtx();
    const disposer = await apply(ctx, newGenConfig({ persistDir: path.join(dir, 'cache') }));

    assert.equal(typeof ctx.settings.register, 'undefined', 'a 0.1.7 kernel has no register to call');
    assert.equal(typeof ctx.settings.get, 'undefined', 'and no cross-namespace get either');
    assert.equal(handlersOf(registered, 'internal/config').length, 1, 'validation interception installed');
    assert.equal(handlersOf(registered, 'loader/volatile-update').length, 1, 'live-update propagation installed');
    assert.equal(handlersOf(registered, 'session/event').length, 1);
    assert.equal(registered.contexts.length, 1);
    assert.equal(registered.tools.length, 1);
    assert.deepEqual(errorsBesidesSelfHeal(logger), []);
    await disposer();
  });

  it('a register that is not a function takes the new face (no crash, no legacy call)', async () => {
    const dir = makeDir();
    const { ctx, registered } = newGenCtx();
    ctx.settings.register = 'not-a-function';
    const disposer = await apply(ctx, newGenConfig({ persistDir: path.join(dir, 'cache') }));
    assert.equal(handlersOf(registered, 'internal/config').length, 1, 'the new face served the load');
    assert.equal(registered.tools.length, 1);
    await disposer();
  });

  it('neither face (settings: {}): apply() degrades with warnings instead of throwing', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    try {
      const { ctx, registered, logger } = newGenCtx({ rows: undefined });
      ctx.settings = {}; // no register, no describe, no get
      const disposer = await apply(ctx, { provider: { baseURL: '', model: '' }, cache: { persistDir: path.join(dir, 'cache') } });
      assert.equal(registered.tools.length, 1, 'the plugin still mounts');
      const loggedWarns = logger.lines.warn.join('\n');
      assert.match(loggedWarns, /settings\.describe\(\) failed/, 'the unreadable namespace face is visible');
      assert.equal(fs.existsSync(path.join(dir, 'vision-bridge', 'provider-defaults.json')), false, 'nothing may be frozen out of a dead face');
      await disposer();
    } finally {
      restore();
    }
  });

  it('a config carrying no reference warns once and still serves its values', async () => {
    const dir = makeDir();
    const { ctx, registered, logger } = newGenCtx();
    const plain = legacyConfig({ model: 'plain-m1', persistDir: path.join(dir, 'cache') });
    const disposer = await apply(ctx, plain);
    assert.equal(warned(logger, NO_VOLATILE_REFS_WARN), true, 'an inert settings surface must not be silent');
    assert.equal(registered.tools.length, 1);
    await disposer();
  });
});

// ---------------------------------------------------------------------------
// §7-2/3 — 0.1.7 reads and change propagation
// ---------------------------------------------------------------------------
describe('§7-2/3 — 0.1.7 reads: references unwrap to the legacy handle\'s section', () => {
  it('snapshotOf() equals the 0.1.6 oracle on a schema-resolved section', () => {
    const dir = makeDir();
    const resolved = Config({
      mode: 'auto',
      provider: { baseURL: 'https://a.example/v1', model: 'm1' },
      cache: { persistDir: dir },
      language: 'en',
      promptExtra: '  extra  ',
      visionCapabilities: { outputFormat: 'gemini' },
    });
    assert.deepEqual(snapshotOf(resolved), plainSection(resolved), 'both faces must hand over the same section');

    // The volatile mark set (design §4-B): exactly the card-editable fields.
    const volatilePaths = ['mode', 'provider', 'credential', 'timeoutMs', 'concurrency', 'visionCapabilities', 'language', 'promptExtra', 'autoMode'];
    assert.equal(volatilePaths.length, 9);
    for (const key of volatilePaths) {
      assert.equal(typeof resolved[key]?.get, 'function', key + ' must arrive as a reference on 0.1.7');
    }
    for (const key of ['cache', 'maxImageBytes', 'maxImagePixels']) {
      assert.notEqual(typeof resolved[key]?.get, 'function', key + ' is not a live field');
    }
    assert.equal(typeof resolved.cache.maxEntries, 'number', 'non-volatile leaves stay plain');
    // and the unwrap is idempotent: passing the plain section through changes nothing
    assert.deepEqual(snapshotOf(plainSection(resolved)), snapshotOf(resolved));
  });

  it('snapshotOf() walks arrays, copies plain objects and passes foreign objects through', () => {
    const stamp = new Date(0);
    const input = {
      list: [volRef(1), { deep: volRef('x') }],
      when: stamp,
      nil: null,
      n: 7,
      nested: { arr: [[2]] },
    };
    const out = snapshotOf(input);
    assert.deepEqual(out, { list: [1, { deep: 'x' }], when: stamp, nil: null, n: 7, nested: { arr: [[2]] } });
    assert.equal(out.when, stamp, 'a non-plain object passes through by identity');
    assert.notEqual(out.list[1], input.list[1], 'plain nodes are copied, never shared (no frozen cache)');
    assert.notEqual(out.nested, input.nested);
  });

  it('a reference that reads once and then fails is re-read every time (never cached)', () => {
    let reads = 0;
    const config = { a: volRef('v1'), counting: { get() { reads += 1; return reads; } } };
    assert.equal(snapshotOf(config).counting, 1);
    assert.equal(snapshotOf(config).counting, 2, 'the same call must recompute');
    config.a.put('v2');
    assert.equal(snapshotOf(config).a, 'v2', 'a committed update reaches the next read');
  });

  it('a throwing getter reads as undefined (install warns) and recovers on the next read', () => {
    const logger = makeLogger();
    const bad = throwingRef();
    const config = { a: volRef('ok'), b: bad };
    assert.deepEqual(snapshotOf(config), { a: 'ok', b: undefined }, 'no throw out of the reader');

    const { ctx, registered } = newGenCtx({ logger });
    const settings = installVolatileSettings(ctx, config, { logger, validate() {} });
    assert.equal(warned(logger, REF_READ_FAILED_WARN), true, 'a failing read must be visible');
    assert.deepEqual(settings.get(), { a: 'ok', b: undefined });
    bad.get = () => 'recovered';
    assert.equal(settings.get().b, 'recovered', 'the reader is not frozen into the failed generation');
    assert.equal(handlersOf(registered, 'internal/config').length, 1);
  });

  it('watch() delivers the whole section after a volatile update, and nothing after unsubscribe', async () => {
    const logger = makeLogger();
    const config = newGenConfig({ model: 'm1' });
    const { ctx, registered } = newGenCtx({ logger });
    const settings = installVolatileSettings(ctx, config, { logger, validate() {} });

    const seen = [];
    const off = settings.watch((next) => seen.push(next));
    assert.equal(handlersOf(registered, 'loader/volatile-update').length, 1);

    config.provider.put({ baseURL: 'https://new.example/v1', model: 'm2' });
    fire(registered, 'loader/volatile-update', { args: [['provider']] });
    assert.equal(seen.length, 1, 'one commit delivers once');
    assert.equal(seen[0].provider.model, 'm2');
    assert.equal(settings.get().provider.model, 'm2');

    // The loader emits per fiber with the changed paths; this handler rebuilds
    // from the current references and ignores the path list, so an emit that
    // changed nothing delivers the SAME values (no drift, no partial rebuild).
    fire(registered, 'loader/volatile-update', { args: [['cache.maxEntries']] });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], seen[0]);

    off();
    fire(registered, 'loader/volatile-update', { args: [['provider']] });
    assert.equal(seen.length, 2, 'an unsubscribed watcher is not called');
  });

  it('a reference failing at commit time warns and blocks the update (previous state kept)', async () => {
    const logger = makeLogger();
    const config = newGenConfig({ model: 'm1' });
    const { ctx, registered } = newGenCtx({ logger });
    const settings = installVolatileSettings(ctx, config, { logger, validate() {} });
    const seen = [];
    settings.watch((next) => seen.push(next));

    config.provider = throwingRef('read failed at commit');
    fire(registered, 'loader/volatile-update', { args: [['provider']] });
    assert.equal(warned(logger, REF_READ_FAILED_WARN), true);
    assert.equal(seen.length, 0, 'a failed read must not deliver a partial generation');

    config.provider = volRef({ baseURL: 'https://new.example/v1', model: 'm3' });
    fire(registered, 'loader/volatile-update', { args: [['provider']] });
    assert.equal(seen.length, 1, 'the next good read delivers again');
    assert.equal(seen[0].provider.model, 'm3');
  });
});

// ---------------------------------------------------------------------------
// §7-2/3 — apply()-level: the runtime follows the references
// ---------------------------------------------------------------------------
describe('§7-2/3 — apply() on 0.1.7: runtime state follows the references', () => {
  it('the row config reaches the runtime, and a committed update rebuilds it', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let disposer;
    try {
      const { ctx, registered, attachment, logger } = newGenCtx();
      const config = newGenConfig({ model: 'new-gen-m1', persistDir: path.join(dir, 'cache') });
      disposer = await apply(ctx, config);

      await readViaTool(registered, 'first question');
      assert.equal(fetch.calls.length, 1);
      assert.equal(fetch.calls[0].body.model, 'new-gen-m1', 'the section value (not a default) reached the runtime');
      assert.match(fetch.calls[0].url, /^https:\/\/new\.example\/v1\/chat\/completions$/);
      assert.match(fetch.calls[0].init.headers.Authorization, /^Bearer sk-test$/);
      // 0.1.7 attachment middle parameter: this side projects the dimensions.
      assert.deepEqual(attachment.seen.target, { width: 1154, height: 866, maxBytes: 10485760 });
      assert.deepEqual(attachment.seen.ref, REF_A, 'the durable ref shape is unchanged');

      // A committed volatile update: the loader writes the reference and emits.
      config.provider.put({ baseURL: 'https://rebuilt.example/v2', model: 'new-gen-m2' });
      config.language.put('en');
      fire(registered, 'loader/volatile-update', { args: [['provider', 'language']] });
      assert.equal(logged(logger, 'info', 'configuration applied live'), true, 'the rebuild is visible in the log');

      await readViaTool(registered, 'second question');
      assert.equal(fetch.calls.length, 2);
      assert.equal(fetch.calls[1].body.model, 'new-gen-m2', 'the rebuild picked up the new reference value');
      assert.match(fetch.calls[1].url, /^https:\/\/rebuilt\.example\/v2\/chat\/completions$/);
      assert.match(fetch.calls[1].text, /Please answer in English\.$/, 'the new language directives followed too');
    } finally {
      await disposer?.();
      fetch.restore();
      restore();
    }
  });

  it('a reference failing at commit time keeps the previous generation serving, then recovers', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let disposer;
    try {
      const { ctx, registered, logger } = newGenCtx();
      const config = newGenConfig({ model: 'new-gen-m1', persistDir: path.join(dir, 'cache') });
      disposer = await apply(ctx, config);

      await readViaTool(registered, 'q1');
      assert.equal(fetch.calls.at(-1).body.model, 'new-gen-m1');

      config.provider = throwingRef('vote of no confidence');
      const infoBefore = logger.lines.info.length;
      fire(registered, 'loader/volatile-update', { args: [['provider']] });
      assert.equal(warned(logger, REF_READ_FAILED_WARN), true);
      assert.equal(logger.lines.info.length, infoBefore, 'no rebuild was announced');

      await readViaTool(registered, 'q2');
      assert.equal(fetch.calls.at(-1).body.model, 'new-gen-m1', 'the runtime keeps the last good generation');

      config.provider = volRef({ baseURL: 'https://rebuilt.example/v2', model: 'new-gen-m3' });
      fire(registered, 'loader/volatile-update', { args: [['provider']] });
      await readViaTool(registered, 'q3');
      assert.equal(fetch.calls.at(-1).body.model, 'new-gen-m3', 'the next good commit rebuilds again');
    } finally {
      await disposer?.();
      fetch.restore();
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// §7-4 — validation interception: one verdict line for both faces
// ---------------------------------------------------------------------------
describe('§7-4 — validation interception (internal/config) and refuse-and-keep-old', () => {
  const interceptOf = (registered) => {
    const [handler] = handlersOf(registered, 'internal/config');
    assert.equal(typeof handler, 'function', 'the interception handler must be installed');
    return handler;
  };

  it('validates this fiber\'s candidates only; a refusal throws and never reaches next()', () => {
    const logger = makeLogger();
    const validate = (candidate) => {
      if (candidate?.timeoutMs < 1000) throw new TypeError('vision-bridge: timeoutMs must be an integer between 1000 and 600000');
    };
    const config = newGenConfig();
    const { ctx, registered } = newGenCtx({ logger });
    installVolatileSettings(ctx, config, { logger, validate });
    const handler = interceptOf(registered);

    let nextCalls = 0;
    const next = () => { nextCalls += 1; return 'config'; };
    assert.equal(handler.call({ ctx }, { timeoutMs: 5000 }, next), 'config', 'a valid candidate passes through unchanged');
    assert.equal(nextCalls, 1);

    assert.throws(() => handler.call({ ctx }, { timeoutMs: 5 }, next), /timeoutMs/, 'the refused candidate throws');
    assert.equal(nextCalls, 1, 'and the commit path is aborted (loader warns, references keep their values)');

    // Ownership guard: every other fiber's resolution must pass untouched.
    assert.doesNotThrow(() => handler.call({ ctx: {} }, { timeoutMs: 5 }, next), 'a foreign fiber is never validated by us');
    assert.equal(nextCalls, 2);
    assert.doesNotThrow(() => handler.call(undefined, { timeoutMs: 5 }, next), 'a dispatch without a receiver passes too');
    assert.equal(nextCalls, 3);
  });

  it('works without a validate hook (the option is optional)', () => {
    const logger = makeLogger();
    const { ctx, registered } = newGenCtx({ logger });
    installVolatileSettings(ctx, newGenConfig(), { logger });
    const handler = interceptOf(registered);
    let nextCalls = 0;
    assert.doesNotThrow(() => handler.call({ ctx }, { timeoutMs: 5 }, () => { nextCalls += 1; }));
    assert.equal(nextCalls, 1);
  });

  it('a value equal to the schema default still counts as an override on both faces', async () => {
    // The user layer is judged by EXISTENCE, not by a diff against the default:
    // neither face may drop a committed default value, and neither may refuse a
    // candidate that merely repeats the schema default (timeoutMs 60000 /
    // concurrency 2 — lib/config.js:62,64).
    const dir = makeDir();
    let legacyDisposer;
    let modernDisposer;
    try {
      // 0.1.6: the registered validate accepts a default-valued section, and an
      // update to that same value still reaches the runtime.
      const legacy = legacyCtx();
      legacyDisposer = await apply(legacy.ctx, legacyConfig({ model: 'default-vl', persistDir: path.join(dir, 'legacy-cache') }));
      const legacyValidate = legacy.registered.settings[0].options.validate;
      const defaultSection = plainSection(Config({
        provider: { baseURL: 'https://legacy.example/v1', model: 'default-vl' },
        cache: { persistDir: path.join(dir, 'legacy-cache') },
      }));
      assert.equal(defaultSection.timeoutMs, 60000, 'the fixture repeats the schema default');
      assert.doesNotThrow(() => legacyValidate(defaultSection), 'a default value is not a refusal');

      const rebuildsBefore = legacy.logger.lines.info.filter((line) => line.includes('configuration applied live')).length;
      await legacy.ctx.settingsScope.update({ timeoutMs: 60000 });
      assert.equal(legacy.ctx.settingsScope.get().timeoutMs, 60000, 'the value committed');
      assert.equal(
        legacy.logger.lines.info.filter((line) => line.includes('configuration applied live')).length,
        rebuildsBefore + 1,
        'an equal-to-default update still rebuilds the runtime',
      );

      // 0.1.7: the interception hook passes the same default value through, and a
      // committed write of it still rebuilds (the rebuild is not value-diffed).
      const modern = newGenCtx();
      const modernConfig = newGenConfig({ model: 'default-vl', persistDir: path.join(dir, 'new-cache') });
      modernDisposer = await apply(modern.ctx, modernConfig);
      const handler = interceptOf(modern.registered);
      let nextCalls = 0;
      const committed = handler.call(
        { ctx: modern.ctx },
        {
          provider: { baseURL: 'https://new.example/v1', model: 'default-vl' },
          cache: { persistDir: path.join(dir, 'new-cache') },
          timeoutMs: 60000,
        },
        () => { nextCalls += 1; return 'config'; },
      );
      assert.equal(committed, 'config', 'a default-valued candidate is committed, not refused');
      assert.equal(nextCalls, 1);

      const modernRebuildsBefore = modern.logger.lines.info.filter((line) => line.includes('configuration applied live')).length;
      modernConfig.concurrency.put(2); // 2 = the schema default
      fire(modern.registered, 'loader/volatile-update', { args: [['concurrency']] });
      assert.equal(
        modern.logger.lines.info.filter((line) => line.includes('configuration applied live')).length,
        modernRebuildsBefore + 1,
        'an equal-to-default commit still rebuilds (no value diffing)',
      );
      assert.deepEqual(errorsBesidesSelfHeal(modern.logger), [], 'no error line for a legal default value');
    } finally {
      await legacyDisposer?.();
      await modernDisposer?.();
    }
  });

  it('apply() on 0.1.7 refuses an invalid generation twice over (interception, then the rebuild guard)', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let disposer;
    try {
      const { ctx, registered, logger } = newGenCtx();
      const config = newGenConfig({ model: 'new-gen-m1', persistDir: path.join(dir, 'cache') });
      disposer = await apply(ctx, config);
      await readViaTool(registered, 'q1');
      assert.equal(fetch.calls.at(-1).body.model, 'new-gen-m1');

      const handler = interceptOf(registered);
      let nextCalls = 0;
      const raw = { provider: { baseURL: 'https://new.example/v1', model: 'new-gen-bad' }, cache: { persistDir: path.join(dir, 'cache') } };

      // Layer 1 — the loader consults this hook before committing.
      assert.throws(() => handler.call({ ctx }, { ...raw, timeoutMs: 5 }, () => { nextCalls += 1; }), /timeoutMs/);
      assert.throws(() => handler.call({ ctx }, { ...raw, maxImagePixels: 0 }, () => { nextCalls += 1; }), /maxImagePixels/);
      assert.throws(() => handler.call({ ctx }, { ...raw, concurrency: 99 }, () => { nextCalls += 1; }), /concurrency/);
      assert.equal(nextCalls, 0, 'no refused candidate reached the commit');

      // Layer 2 — even a committed bad generation (a loader bug / a direct ref
      // write) is refused by the watch handler, and the runtime keeps serving.
      config.provider.put({ baseURL: 'https://new.example/v1', model: 'new-gen-bad' });
      config.timeoutMs.put(5);
      fire(registered, 'loader/volatile-update', { args: [['provider', 'timeoutMs']] });
      assert.equal(logged(logger, 'error', 'keeping the previous configuration'), true);

      await readViaTool(registered, 'q2');
      assert.equal(fetch.calls.at(-1).body.model, 'new-gen-m1', 'the previous runtime keeps serving');
    } finally {
      await disposer?.();
      fetch.restore();
      restore();
    }
  });

  it('the same invalid patch is refused on both faces, with the same runtime outcome', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let legacyDisposer;
    let modernDisposer;
    try {
      // 0.1.6: the handle's validate refuses the update before it commits.
      const legacy = legacyCtx();
      const config = legacyConfig({ model: 'legacy-m1', persistDir: path.join(dir, 'legacy-cache') });
      legacyDisposer = await apply(legacy.ctx, config);
      await readViaTool(legacy.registered, 'q1');
      let legacyRefused = false;
      await assert.rejects(legacy.ctx.settingsScope.update({ timeoutMs: 999999999 }), (error) => {
        legacyRefused = /timeoutMs/.test(error.message);
        return true;
      });
      await readViaTool(legacy.registered, 'q2');
      const legacyOutcome = {
        refused: legacyRefused,
        sectionTimeoutMs: legacy.ctx.settingsScope.get().timeoutMs,
        runtimeModel: fetch.calls.at(-1).body.model,
      };

      // 0.1.7: the interception hook refuses the very same patch.
      const modern = newGenCtx();
      const modernConfig = newGenConfig({ model: 'legacy-m1', baseURL: 'https://legacy.example/v1', persistDir: path.join(dir, 'new-cache') });
      modernDisposer = await apply(modern.ctx, modernConfig);
      await readViaTool(modern.registered, 'q3');
      let modernRefused = false;
      assert.throws(() => interceptOf(modern.registered).call({ ctx: modern.ctx }, { ...legacyConfig({ persistDir: dir }), timeoutMs: 999999999 }, () => {}), (error) => {
        modernRefused = /timeoutMs/.test(error.message);
        return true;
      });
      await readViaTool(modern.registered, 'q4');
      const modernOutcome = {
        refused: modernRefused,
        sectionTimeoutMs: modernConfig.timeoutMs.get(),
        runtimeModel: fetch.calls.at(-1).body.model,
      };

      assert.deepEqual(modernOutcome, legacyOutcome, 'one verdict line: both generations refuse and keep the old value');
      assert.deepEqual(legacyOutcome, { refused: true, sectionTimeoutMs: 60000, runtimeModel: 'legacy-m1' });
    } finally {
      await legacyDisposer?.();
      await modernDisposer?.();
      fetch.restore();
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.1-18 / §7-13 — cross-namespace reads
// ---------------------------------------------------------------------------
describe('§2.1-18 — cross-namespace reads on both generations', () => {
  it('0.1.6 reads through settings.get(ns); a throwing getter propagates', () => {
    const logger = makeLogger();
    const ctx = { settings: { get: (ns) => (ns === 'vision-toolkit' ? TOOLKIT_VALUE : undefined) } };
    assert.equal(readSettingsNamespace(ctx, true, 'vision-toolkit', logger), TOOLKIT_VALUE);
    assert.equal(readSettingsNamespace(ctx, true, 'something-else', logger), undefined, 'a missing namespace is not an error');
    assert.throws(
      () => readSettingsNamespace({ settings: { get() { throw new Error('no such namespace'); } } }, true, 'vision-toolkit', logger),
      /no such namespace/,
      'the 0.1.6 read propagates (its callers guard)',
    );
    assert.equal(logger.lines.warn.length, 0);
  });

  it('0.1.7 reads the describe() row and tolerates every degenerate table', () => {
    const logger = makeLogger();
    const rowsCtx = (rows) => ({ settings: { describe: () => rows } });

    assert.equal(readSettingsNamespace(rowsCtx([{ ns: 'other', value: 1 }, TOOLKIT_ROW]), false, 'vision-toolkit', logger), TOOLKIT_VALUE, 'the matching row is picked');
    assert.equal(readSettingsNamespace(rowsCtx([{ ns: 'other', value: 1 }]), false, 'vision-toolkit', logger), undefined, 'a table without our namespace is legitimate');
    assert.equal(readSettingsNamespace(rowsCtx([]), false, 'vision-toolkit', logger), undefined);
    assert.equal(readSettingsNamespace(rowsCtx([{ value: TOOLKIT_VALUE }]), false, 'vision-toolkit', logger), undefined, 'a row without ns cannot match');
    assert.equal(readSettingsNamespace(rowsCtx([{ ns: 'vision-toolkit' }]), false, 'vision-toolkit', logger), undefined, 'an ns-only row has no value');
    assert.equal(readSettingsNamespace(rowsCtx(null), false, 'vision-toolkit', logger), undefined, 'non-array table');
    assert.equal(readSettingsNamespace(rowsCtx({ rows: [] }), false, 'vision-toolkit', logger), undefined);
    assert.equal(readSettingsNamespace(rowsCtx('nope'), false, 'vision-toolkit', logger), undefined);

    const warnsBefore = logger.lines.warn.length;
    const value = readSettingsNamespace({ settings: { describe() { throw new Error('describe exploded'); } } }, false, 'vision-toolkit', logger);
    assert.equal(value, undefined, 'an unreadable table is treated as unavailable');
    assert.equal(logger.lines.warn.length, warnsBefore + 1, 'exactly one visible warn');
    assert.match(logger.lines.warn.at(-1), /describe\(\) failed/);
  });

  it('0.1.7 reads the llm-pi-ai row through describe(): the projection is non-empty (§7-13)', () => {
    // The card's provider dropdown is served by projectProviders over this same
    // neutral reader (lib/index.js:345 `settingsReader.get` →
    // lib/server-routes.js:582). Normal cell of the design's case table: a
    // describe() table carrying the llm-pi-ai row ⇒ the reader hands the value
    // over ⇒ the rows the dropdown renders.
    const logger = makeLogger();
    const llmRow = {
      ns: 'llm-pi-ai',
      value: {
        providers: {
          qax: {
            baseURL: 'https://qax.example/v1',
            apiKeyEnv: 'QAX_API_KEY',
            models: [{ id: 'q-plus', name: 'Q Plus', input: ['text', 'image'] }],
          },
        },
      },
    };
    const readerFor = (rows) => (ns) => readSettingsNamespace({ settings: { describe: () => rows } }, false, ns, logger);

    assert.deepEqual(projectProviders(readerFor([TOOLKIT_ROW, llmRow])), [
      {
        id: 'qax',
        baseURL: 'https://qax.example/v1',
        apiKeyEnv: 'QAX_API_KEY',
        models: [{ id: 'q-plus', name: 'Q Plus', vision: true }],
      },
    ]);
    // Same composition with the row absent: the documented empty projection (the
    // card then offers only its custom entry), silently — a missing namespace is
    // legitimate, not an error.
    assert.deepEqual(projectProviders(readerFor([TOOLKIT_ROW])), []);
    assert.equal(logger.lines.warn.length, 0, 'a missing llm-pi-ai row is not an error');
  });

  it('0.1.7 apply(): the first-run freeze copies the toolkit row from describe()', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let disposer;
    try {
      const { ctx, registered } = newGenCtx({ rows: [TOOLKIT_ROW] });
      const config = newGenConfig({ baseURL: '', model: '', persistDir: path.join(dir, 'cache') });
      disposer = await apply(ctx, config);
      assert.ok(ctx.registered.describeCalls >= 1, 'the toolkit read went through describe()');
      const frozenFile = path.join(dir, 'vision-bridge', 'provider-defaults.json');
      assert.deepEqual(JSON.parse(fs.readFileSync(frozenFile, 'utf8')), { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });

      await readViaTool(registered, 'q1');
      assert.match(fetch.calls[0].url, /^https:\/\/toolkit\.example\/v1\/chat\/completions$/);
      assert.equal(fetch.calls[0].body.model, 'toolkit-vl', 'the frozen row values served the empty provider section');
    } finally {
      await disposer?.();
      fetch.restore();
      restore();
    }
  });

  it('0.1.7 apply(): an unreadable describe() defers the freeze, warns and serves with baked defaults', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let disposer;
    try {
      const { ctx, registered, logger } = newGenCtx({ rows: () => { throw new Error('describe exploded'); } });
      const config = newGenConfig({ baseURL: '', model: '', persistDir: path.join(dir, 'cache') });
      disposer = await apply(ctx, config);

      assert.equal(fs.existsSync(path.join(dir, 'vision-bridge', 'provider-defaults.json')), false, 'no freeze out of an unreadable table');
      assert.equal(logged(logger, 'warn', 'settings.describe() failed'), true, 'the degradation is visible');

      await readViaTool(registered, 'q1');
      assert.match(fetch.calls[0].url, /api\.inferera\.com/, 'baked defaults serve this run');
      assert.equal(fetch.calls[0].body.model, 'gemini-3.6-flash');
    } finally {
      await disposer?.();
      fetch.restore();
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-generation assembly: same user values, same runtime read
// ---------------------------------------------------------------------------
describe('cross-generation assembly — same user values, same runtime read', () => {
  it('both faces assemble the same request; only the attachment middle parameter differs (by design)', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    const fetch = stubFetch();
    let legacyDisposer;
    let modernDisposer;
    try {
      const shared = {
        model: 'shared-vl',
        baseURL: 'https://shared.example/v1',
        language: 'en',
        promptExtra: 'answer in one line',
        maxImagePixels: 1000000,
      };
      const legacy = legacyCtx();
      legacyDisposer = await apply(legacy.ctx, legacyConfig({ ...shared, persistDir: path.join(dir, 'legacy-cache') }));
      await readViaTool(legacy.registered, 'what is shown?');
      const legacyCall = fetch.calls.at(-1);
      const legacyTarget = legacy.attachment.seen.target;

      const modern = newGenCtx();
      modernDisposer = await apply(modern.ctx, newGenConfig({ ...shared, persistDir: path.join(dir, 'new-cache') }));
      await readViaTool(modern.registered, 'what is shown?');
      const modernCall = fetch.calls.at(-1);
      const modernTarget = modern.attachment.seen.target;

      assert.equal(legacyCall.url, modernCall.url, 'same endpoint');
      assert.equal(legacyCall.body.model, modernCall.body.model, 'same model');
      assert.deepEqual(legacyCall.init.headers, modernCall.init.headers, 'same auth face');
      assert.equal(legacyCall.text, modernCall.text, 'same directive assembly (question → language → promptExtra)');
      assert.match(legacyCall.text, /Please answer in English\.\n\nanswer in one line/, 'both directives, in this order');

      assert.deepEqual(legacyTarget, { maxPixels: 1000000, maxBytes: 10485760 }, '0.1.6 keeps the limit-shaped parameter');
      assert.deepEqual(modernTarget, { width: 1154, height: 866, maxBytes: 10485760 }, '0.1.7 receives a projected request target');
      assert.ok(modernTarget.width * modernTarget.height <= legacyTarget.maxPixels, 'the projection respects the same pixel budget');
      assert.equal(modernTarget.maxBytes, legacyTarget.maxBytes, 'the byte budget is the same field');

      assert.deepEqual(errorsBesidesSelfHeal(legacy.logger), []);
      assert.deepEqual(errorsBesidesSelfHeal(modern.logger), []);
    } finally {
      await legacyDisposer?.();
      await modernDisposer?.();
      fetch.restore();
      restore();
    }
  });

  it('the delegation route (ctx.inject) is offered on both faces and optional on neither-critical paths', async () => {
    const dir = makeDir();
    const restore = pinEnv(dir);
    try {
      const withInject = newGenCtx({ inject: true });
      const disposerA = await apply(withInject.ctx, newGenConfig({ persistDir: path.join(dir, 'a-cache') }));
      // Two scoped injects since N-I4: the webServer route scope and the
      // late-llm retry. The web server scope is still requested EXACTLY ONCE and
      // is still registered first (its position is part of the ⑧ contract); the
      // llm retry is additive and guarded, so this is an exact-equivalence
      // widening of the old "one inject, and it is webServer" assertion.
      assert.equal(withInject.registered.injects.length, 2, 'the web server scope plus the late-llm retry');
      assert.deepEqual(withInject.registered.injects[0].list, ['webServer']);
      assert.equal(typeof withInject.registered.injects[0].callback, 'function');
      assert.equal(withInject.registered.injects.filter((entry) => entry.list.includes('webServer')).length, 1,
        'the web server scope is still requested exactly once');
      assert.deepEqual(withInject.registered.injects[1].list, ['llm']);
      assert.equal(typeof withInject.registered.injects[1].callback, 'function');
      await disposerA();

      const withoutInject = newGenCtx();
      const disposerB = await apply(withoutInject.ctx, newGenConfig({ persistDir: path.join(dir, 'b-cache') }));
      assert.equal(withoutInject.registered.tools.length, 1, 'a headless kernel still mounts the tool');
      await disposerB();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// §2.4 / §7-7 — attachment request projection
// ---------------------------------------------------------------------------
describe('§2.4 — projectRequestDimensions matches the host geometry', () => {
  // Provenance: the expected values below are the reference implementation's
  // output, generated by calling the host's own `requestImageDimensions`
  // (`@deepseek-ai/dsh-attachment` 0.1.7-rc.1, `lib/index.js:150-178`, exported
  // at `:344`) with each vector — the live parity test below re-derives them at
  // run time so a host-side change in this algorithm turns the suite red.
  const VECTORS = [
    // [width, height, maxPixels, expected, class]
    [4000, 3000, 40000000, { width: 4000, height: 3000 }, 'budget larger than the image: never enlarged'],
    [100000, 1, 1000000, { width: 100000, height: 1 }, 'extreme aspect, no scaling needed'],
    [1920, 1080, 2073600, { width: 1920, height: 1080 }, 'budget exactly the pixel count: untouched'],
    [2000, 1000, 2000000, { width: 2000, height: 1000 }, 'exact budget, other aspect'],
    [1, 1, 1, { width: 1, height: 1 }, 'smallest possible image'],
    [4000, 3000, 1000000, { width: 1154, height: 866 }, 'long-side branch (scale < 1)'],
    [1920, 1080, 500000, { width: 942, height: 530 }, 'long-side branch, short side rounds'],
    [1000, 500, 250000, { width: 706, height: 353 }, 'long-side branch, decrement loop adjusts once'],
    [800, 600, 100, { width: 11, height: 8 }, 'heavy down-scale, floors at 1'],
    [3000, 4000, 6000000, { width: 2121, height: 2828 }, 'short-side branch (portrait)'],
    [500, 1000, 250000, { width: 353, height: 706 }, 'short-side branch, short side rounds'],
    [4000, 6000, 1000000, { width: 816, height: 1224 }, 'portrait, heavy down-scale'],
    [900, 1600, 500000, { width: 530, height: 942 }, 'portrait, decrement loop adjusts'],
    [4096, 2160, 2073600, { width: 1982, height: 1045 }, 'real screenshot budget'],
    [100000, 100, 5000000, { width: 70499, height: 70 }, 'extreme aspect with scaling'],
    [20, 20, 399, { width: 19, height: 19 }, 'one pixel over the budget'],
    [13, 7, 40, { width: 8, height: 4 }, 'tiny non-square'],
    [3, 3, 2, { width: 1, height: 1 }, 'budget below one row of pixels'],
    [5000, 5000, 1, { width: 1, height: 1 }, 'budget of a single pixel'],
    [7, 5, 4, { width: 2, height: 1 }, 'budget smaller than the source'],
  ];

  it('reproduces the reference vector table exactly, and is idempotent', () => {
    for (const [width, height, maxPixels, expected, label] of VECTORS) {
      const projected = projectRequestDimensions(width, height, maxPixels);
      assert.deepEqual(projected, expected, label + ' (' + width + 'x' + height + ' @ ' + maxPixels + ')');
      assert.ok(projected.width >= 1 && projected.height >= 1, 'a dimension never collapses to zero');
      assert.ok(projected.width * projected.height <= maxPixels, 'the pixel budget is never exceeded');
      assert.deepEqual(
        projectRequestDimensions(projected.width, projected.height, maxPixels),
        projected,
        'an already-projected size projects to itself (' + label + ')',
      );
    }
  });

  it('agrees with the live host implementation over a deterministic sweep', async (t) => {
    let host;
    try {
      ({ requestImageDimensions: host } = await import('@deepseek-ai/dsh-attachment'));
    } catch (error) {
      t.skip('host reference implementation unavailable: ' + (error?.message ?? error));
      return;
    }
    assert.equal(typeof host, 'function');
    // Deterministic LCG: covers both branches and the decrement loop widely.
    let state = 20260924;
    const next = (bound) => { state = (state * 1103515245 + 12345) % 2147483648; return (state % bound) + 1; };
    const budgets = [1, 2, 3, 17, 400, 4096, 100000, 999983, 2073600, 40000000, 268435456];
    for (let i = 0; i < 400; i += 1) {
      const width = next(i % 3 === 0 ? 200000 : 5000);
      const height = next(i % 3 === 1 ? 200000 : 5000);
      const maxPixels = budgets[next(budgets.length) - 1];
      const expected = host(width, height, maxPixels);
      const actual = projectRequestDimensions(width, height, maxPixels);
      assert.deepEqual(actual, { width: expected.width, height: expected.height },
        `divergence at ${width}x${height} @ ${maxPixels}`);
    }
    for (const [width, height, maxPixels] of VECTORS) {
      assert.deepEqual(projectRequestDimensions(width, height, maxPixels), { ...host(width, height, maxPixels) },
        `frozen vector diverged: ${width}x${height} @ ${maxPixels}`);
    }
  });
});
