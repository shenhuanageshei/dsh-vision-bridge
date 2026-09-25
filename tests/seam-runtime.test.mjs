import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { plainSection } from './_plain-section.mjs';
import {
  READER_VERDICT_TTL_MS,
  SEAM_LIVE_SKIP_SELF_HEAL_LOG,
  apply,
  resetProcessSeamState,
  resetSelfHealCache,
} from '../lib/index.js';
import { ADMISSION_PROBE_SKIPPED_REASON, installServerRoutes } from '../lib/server-routes.js';
import { installSeam, SEAM_MARK } from '../lib/seam.js';
import { ADMISSION_PATCH_MARKER, admissionPatchTargets } from '../scripts/patch-admission-gate.mjs';

// Batch A (task-7): runtime seam consequences that are not pure unit behaviour —
// §4.7-1 (stand the disk self-heal down while the seam is live), §4.7-2 + §4.6
// (env-route seam state, probe stand-down), N-I2 (reader verdict TTL + block-warn
// latch), N-I4 (late llm), N-I6 (marker-write rollback).
//
// Every case is hermetic: DSH_HOME and the §12 self-heal scan are pinned to a
// mkdtemp directory, never the host profile.

const tmpDirs = [];
function makeDir(prefix = 'dvb-seam-rt-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
  resetSelfHealCache();
  resetProcessSeamState();
});

/** Clean (unpatched) admission-gate source carrying both conditions verbatim. */
const CLEAN_GATE = [
  'function admissionGate(model) {',
  '  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) return "reject";',
  "  if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) return 'reject';",
  '  return "accept";',
  '',
].join('\n');

function writeGateFiles(nodeModulesDir, content) {
  for (const file of admissionPatchTargets(nodeModulesDir)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
}

class FakeLlm {
  constructor(inputModalities = ['text']) {
    this.inputModalities = inputModalities;
    this.calls = [];
    this.lastInfo = undefined;
  }

  async resolveModelInfo(provider, model, signal) {
    this.calls.push({ provider, model, signal });
    const info = { provider, id: model, name: model };
    if (this.inputModalities !== null) info.inputModalities = [...this.inputModalities];
    this.lastInfo = info;
    return info;
  }
}

/** cordis-shaped traceable proxy: a fresh shadow method per read (review F5). */
function traceable(raw) {
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === Symbol.for('cordis.original')) return target;
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') return (...args) => value.apply(receiver, args);
      return value;
    },
  });
}

function makeLlm(inputModalities = ['text']) {
  const raw = new FakeLlm(inputModalities);
  return { raw, llm: traceable(raw) };
}

function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message) => lines.info.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
    error: (message) => lines.error.push(String(message)),
  };
}

const modalitiesOf = (info) => info?.inputModalities;

/** apply() ctx (same minimum the §12 suite uses) with everything this file
 * needs to observe: the llm service, credential resolution, effects, injects. */
function makeApplyCtx(llm, { llmRow, credentialValue = 'sk-test', resolveCalls } = {}) {
  let scope;
  let currentLlm = llm;
  const logger = makeLogger();
  const effects = [];
  const injections = [];
  const ctx = {
    logger: () => logger,
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    tools: { register() { return () => {}; } },
    systemPrompt: { context() { return () => {}; } },
    inject(deps, callback) { injections.push({ deps, callback }); return () => {}; },
    get(name) { return name === 'llm' ? currentLlm : undefined; },
    settings: {
      register(namespace, schema, options = {}) {
        const state = { user: {}, watchers: [] };
        const resolved = () => plainSection(schema({ ...(options.base ?? {}), ...state.user }));
        scope = {
          get: resolved,
          watch(callback) { state.watchers.push(callback); return () => {}; },
          async update(patch) {
            state.user = { ...state.user, ...patch };
            const value = resolved();
            options.validate?.(value);
            for (const watcher of state.watchers) await watcher(value);
          },
        };
        options.validate?.(resolved());
        return scope;
      },
      get(namespace) { return namespace === 'llm-pi-ai' ? llmRow : undefined; },
    },
    credentials: {
      async resolve() {
        if (resolveCalls !== undefined) resolveCalls.count += 1;
        return { value: credentialValue };
      },
    },
    attachments: { async readImageRequest(ref) { return { attachment: ref, data: new Uint8Array([1]), mediaType: 'image/png' }; } },
  };
  return {
    ctx,
    effects,
    injections,
    setLlm(next) { currentLlm = next; },
    update: (patch) => scope.update(patch),
    logs: logger.lines,
  };
}

function pinEnv(dir) {
  const previousHome = process.env.DSH_HOME;
  const previousNm = process.env.VISION_BRIDGE_SELF_HEAL_NM;
  process.env.DSH_HOME = dir;
  process.env.VISION_BRIDGE_SELF_HEAL_NM = join(dir, 'nm');
  resetSelfHealCache();
  resetProcessSeamState();
  return () => {
    resetSelfHealCache();
    resetProcessSeamState();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousNm === undefined) delete process.env.VISION_BRIDGE_SELF_HEAL_NM; else process.env.VISION_BRIDGE_SELF_HEAL_NM = previousNm;
  };
}

const selfHealDir = () => process.env.VISION_BRIDGE_SELF_HEAL_NM;
const gateFiles = () => admissionPatchTargets(selfHealDir());

const TEXT_ONLY_ROW = {
  providers: {
    qax: {
      baseURL: 'https://qax.example/v1',
      models: [{ id: 'glm-5.3', name: 'glm-5.3', input: ['text'] }],
    },
  },
};

const configFor = (dir) => ({
  provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
  credential: 'VISION_API_KEY',
  cache: { persistDir: join(dir, 'cache') },
});

describe('A1 §4.7-1 — the disk self-heal stands down while the seam is live', () => {
  it('a live seam skips the repair on the next mount (and says so)', async () => {
    const { llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    try {
      // Cold mount: the self-proof at ④ publishes the process-wide verdict.
      const first = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose1 = await apply(first.ctx, configFor(dir));
      assert.equal(first.logs.info.some((line) => /runtime seam live/.test(line)), true,
        'precondition: this mount proved the seam live');
      await dispose1();

      // Next mount of the same process, same llm instance, clean gate on disk.
      writeGateFiles(selfHealDir(), CLEAN_GATE);
      const target = gateFiles()[0];
      const before = statSync(target).mtimeMs;
      resetSelfHealCache(); // otherwise the cached outcome would mask the decision

      const second = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose2 = await apply(second.ctx, configFor(dir));
      assert.equal(second.logs.info.some((line) => line.includes(SEAM_LIVE_SKIP_SELF_HEAL_LOG)), true,
        'the stand-down is logged — never silent');
      assert.equal(readFileSync(target, 'utf8').includes(ADMISSION_PATCH_MARKER), false,
        'the clean gate was NOT patched while the seam is live');
      assert.equal(statSync(target).mtimeMs, before, 'and the file was not even touched');
      await dispose2();
    } finally {
      restoreEnv();
    }
  });

  it('F2: a mount whose BASE CONFIG turns the seam off does not inherit the live verdict', async () => {
    const { llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    try {
      // mount#1: auto ⇒ proves live and publishes live = true
      const first = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose1 = await apply(first.ctx, configFor(dir));
      assert.equal(first.logs.info.some((line) => /runtime seam live/.test(line)), true, 'precondition: live');
      await dispose1();

      // mount#2: the composition base switches the seam OFF. The process verdict
      // says live, but THIS mount has no seam — the repair must run again.
      writeGateFiles(selfHealDir(), CLEAN_GATE);
      const target = gateFiles()[0];
      resetSelfHealCache();
      const off = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose2 = await apply(off.ctx, { ...configFor(dir), seam: { mode: 'off' } });
      assert.equal(off.logs.info.some((line) => line.includes(SEAM_LIVE_SKIP_SELF_HEAL_LOG)), false,
        'a seam-off mount must not stand the repair down');
      assert.equal(readFileSync(target, 'utf8').includes(ADMISSION_PATCH_MARKER), true,
        'the clean gate was patched again');
      await dispose2();
    } finally {
      restoreEnv();
    }
  });

  it('a cold start / seam turned off still repairs (control)', async () => {
    const { llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    try {
      writeGateFiles(selfHealDir(), CLEAN_GATE);

      // Never self-proven (no text-only route in the projection) ⇒ repair runs.
      const cold = makeApplyCtx(llm, {});
      const dispose1 = await apply(cold.ctx, configFor(dir));
      assert.equal(cold.logs.info.some((line) => line.includes(SEAM_LIVE_SKIP_SELF_HEAL_LOG)), false,
        'a cold start cannot know the verdict and must not claim to');
      assert.equal(readFileSync(gateFiles()[0], 'utf8').includes(ADMISSION_PATCH_MARKER), true,
        'the repair still ran');
      await dispose1();

      // Seam live, then turned OFF: the published verdict must go back to
      // non-live so the repair resumes instead of skipping forever.
      writeGateFiles(selfHealDir(), CLEAN_GATE);
      const live = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose2 = await apply(live.ctx, configFor(dir));
      assert.equal(live.logs.info.some((line) => /runtime seam live/.test(line)), true);
      await live.update({ seam: { mode: 'off' } });
      await dispose2();

      writeGateFiles(selfHealDir(), CLEAN_GATE);
      resetSelfHealCache();
      const off = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose3 = await apply(off.ctx, configFor(dir));
      assert.equal(off.logs.info.some((line) => line.includes(SEAM_LIVE_SKIP_SELF_HEAL_LOG)), false,
        'mode=off must not keep the repair skipped');
      assert.equal(readFileSync(gateFiles()[0], 'utf8').includes(ADMISSION_PATCH_MARKER), true);
      await dispose3();
    } finally {
      restoreEnv();
    }
  });
});

describe('A2/A3 — env route seam state and probe stand-down', () => {
  const ROUTE_ENV = '/vision-bridge/env';

  function makeReq(method) {
    const stream = Readable.from([]);
    stream.method = method;
    return stream;
  }
  function makeRes() {
    const captured = { status: 0, body: '' };
    const res = {
      writeHead(code) { captured.status = code; return res; },
      end(text) { captured.body = text === undefined ? '' : String(text); return res; },
    };
    return { res, captured };
  }
  async function callEnv(deps) {
    const routes = new Map();
    const webServer = {
      port: 45999,
      host: '127.0.0.1',
      register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); },
    };
    installServerRoutes({ webServer }, { fetchImpl: async () => ({ status: 404 }), ...deps });
    const { res, captured } = makeRes();
    await routes.get(ROUTE_ENV)(makeReq('GET'), res);
    return { status: captured.status, body: JSON.parse(captured.body) };
  }

  const LIVE_SEAM = {
    status: 'installed',
    live: true,
    reason: 'self-check passed (qax:glm-5.3)',
    mode: 'auto',
    include: [],
    requireReader: true,
    residue: false,
  };

  it('a live seam skips the runtime probe and reports the third state', async () => {
    let submissions = 0;
    const { status, body } = await callEnv({
      nodeModulesDir: makeDir(),
      settingsGet: () => undefined,
      getSeamState: () => LIVE_SEAM,
      promptRemote: async () => { submissions += 1; return { accepted: true }; },
      ensureScratchSession: async () => 'scratch',
    });
    assert.equal(status, 200);
    assert.equal(body.admission.runtime, 'skipped');
    assert.equal(body.admission.reason, ADMISSION_PROBE_SKIPPED_REASON);
    assert.equal(submissions, 0, 'not even a scratch session submission happens');
    assert.equal(body.admission.conflict, false, 'skipped is not "live"');
    assert.deepEqual(body.seam, LIVE_SEAM, 'the seam state is exposed read-only');
    // the §11 fields the first-generation card reads are untouched
    assert.equal(typeof body.admission.status, 'string');
    assert.equal(Array.isArray(body.admission.files), true);
  });

  it('a non-live seam still probes, and the seam field renders the tri-state', async () => {
    for (const live of [false, null]) {
      const { body } = await callEnv({
        nodeModulesDir: makeDir(),
        settingsGet: () => undefined,
        getSeamState: () => ({ ...LIVE_SEAM, live, reason: 'not self-proven' }),
        promptRemote: async () => ({ accepted: true }),
        ensureScratchSession: async () => 'scratch',
      });
      assert.equal(body.admission.runtime, 'dead', 'the probe ran (admitted ⇒ dead) for live=' + String(live));
      assert.equal(body.seam.live, live);
    }
  });

  it('without a seam source the env route keeps its previous shape plus defaults', async () => {
    const { body } = await callEnv({
      nodeModulesDir: makeDir(),
      settingsGet: () => undefined,
      promptRemote: async () => ({ accepted: true }),
      ensureScratchSession: async () => 'scratch',
    });
    assert.equal(body.admission.runtime, 'dead');
    assert.deepEqual(body.seam, {
      status: 'unknown',
      live: null,
      reason: 'unknown',
      mode: null,
      include: [],
      requireReader: null,
      residue: false,
    });
  });

  it('F3: the running plugin reports a REAL residue through its own route wiring', async () => {
    const { raw, llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 404 }); // the modlens probe stays offline
    try {
      const { ctx, injections } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir));
      const routes = new Map();
      injections.find((entry) => entry.deps.includes('webServer')).callback({
        webServer: {
          port: 45999,
          host: '127.0.0.1',
          register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); },
        },
      });
      const env = async () => {
        const { res, captured } = makeRes();
        await routes.get(ROUTE_ENV)(makeReq('GET'), res);
        return JSON.parse(captured.body);
      };

      const healthy = await env();
      assert.equal(healthy.seam.live, true, 'the seam self-proved');
      assert.equal(healthy.seam.residue, false, 'a healthy install is NOT a residue');

      // A foreign decorator lands on top: the mark stays, the method is not ours.
      Object.defineProperty(raw, 'resolveModelInfo', {
        value: async function resolveModelInfo() { return { provider: 'p', id: 'm', name: 'm', inputModalities: ['text', 'image'] }; },
        writable: true,
        configurable: true,
        enumerable: false,
      });
      const buried = await env();
      assert.equal(buried.seam.residue, true, 'the mark is there but the live layer is not ours');
      await dispose();
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv();
    }
  });

  it('a throwing seam source degrades to unknown instead of failing the route', async () => {
    const { status, body } = await callEnv({
      nodeModulesDir: makeDir(),
      settingsGet: () => undefined,
      getSeamState: () => { throw new Error('state exploded'); },
      promptRemote: async () => ({ accepted: true }),
      ensureScratchSession: async () => 'scratch',
    });
    assert.equal(status, 200);
    assert.equal(body.seam.status, 'unknown');
    assert.equal(body.admission.runtime, 'dead', 'no stand-down without a live verdict');
  });
});

describe('A4 N-I2 — reader verdict cache and block-warning latch', () => {
  it('one credential resolution serves a batch of resolveModelInfo calls', async () => {
    const { llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    const resolveCalls = { count: 0 };
    try {
      const { ctx } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW, resolveCalls });
      const dispose = await apply(ctx, configFor(dir));
      const before = resolveCalls.count;
      assert.equal(before > 0, true, 'precondition: the mount itself resolved the credential once');
      for (let i = 0; i < 5; i += 1) {
        assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('qax', 'glm-5.3')), ['text', 'image']);
      }
      assert.equal(resolveCalls.count - before, 0,
        'the batch catalog walk reuses the cached verdict (5 models, 0 extra resolutions)');
      assert.equal(READER_VERDICT_TTL_MS > 0, true);
      await dispose();
    } finally {
      restoreEnv();
    }
  });

  it('a blocked reader warns once per episode, not once per model', async () => {
    const { llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    try {
      // Credential resolves, but carries no value ⇒ the reader is unavailable.
      // (null, not undefined: a destructuring default would swallow undefined.)
      const { ctx, logs } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW, credentialValue: null });
      const dispose = await apply(ctx, configFor(dir));
      const blocked = () => logs.warn.filter((line) => /not injecting image capability/.test(line)).length;
      const before = blocked();
      assert.equal(before > 0, true, 'precondition: the seam reported the blocked reader');
      for (let i = 0; i < 4; i += 1) {
        assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('qax', 'glm-5.3')), ['text'],
          'the hard rejection is kept');
      }
      assert.equal(blocked(), before, 'repeat blocks are latched (allow→deny only)');
      await dispose();
    } finally {
      restoreEnv();
    }
  });
});

describe('A5 N-I4 — the late llm service is retried', () => {
  it('registers a scoped llm inject after the webServer scope, installing on arrival', async () => {
    const { raw, llm } = makeLlm();
    const dir = makeDir();
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, injections, setLlm } = makeApplyCtx(undefined, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'nothing to decorate while llm is absent');
      assert.deepEqual(injections.map((entry) => entry.deps), [['webServer'], ['llm']],
        'the webServer scope stays first and unchanged; the llm retry is additive');

      setLlm(llm);
      injections[1].callback({});
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'the seam installs once llm appears');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('qax', 'glm-5.3')), ['text', 'image']);
      injections[1].callback({}); // idempotent: the status guard skips a second install
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true);
      await dispose();
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'the disposer still restores it');
    } finally {
      restoreEnv();
    }
  });
});

describe('A6 N-I6 — the marker write rolls back when it cannot land', () => {
  it('non-extensible instance that already owns a configurable method is left untouched', () => {
    const raw = new FakeLlm();
    const own = async () => ({ provider: 'p', id: 'own', name: 'own' });
    Object.defineProperty(raw, 'resolveModelInfo', { value: own, writable: true, configurable: true, enumerable: false });
    Object.preventExtensions(raw);
    const logger = makeLogger();

    const result = installSeam(traceable(raw), { logger });

    assert.equal(result.status, 'unsupported', 'the three-state contract still holds');
    assert.equal(result.restore, undefined);
    assert.equal(raw.resolveModelInfo, own, 'the replaced method was put back');
    assert.equal(raw[SEAM_MARK], undefined, 'no marker residue');
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(raw, 'resolveModelInfo'),
      { value: own, writable: true, enumerable: false, configurable: true },
    );
    assert.match(logger.lines.warn[0], /not extensible/);
  });
});
