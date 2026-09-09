import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  ADMISSION_PROBE_SESSION_ID,
  admissionProbeEnabled,
  apply,
  buildAdmissionProbeDeps,
  pickTextOnlyModel,
  resetSelfHealCache,
  resolveNodeModulesDir,
  selfHealAdmissionGate,
  SELF_HEAL_REPATCHED_LOG,
} from '../lib/index.js';
import {
  ADMISSION_GATE_LIVE_REASON,
  classifyAdmissionProbeError,
  installServerRoutes,
  probeAdmissionGate,
} from '../lib/server-routes.js';
import { ADMISSION_PATCH_MARKER, admissionPatchTargets } from '../scripts/patch-admission-gate.mjs';

// §12 unit matrix (design §12.5): disk self-heal outcomes, the behavior
// probe's three states, and the env payload the card renders. Every
// file-touching case runs inside a mkdtemp node_modules root — the real
// <DSH_HOME>/profiles/web/node_modules is never written (the self-heal reads
// it only when apply() runs with its default resolution, and it is already
// patched, which is a no-write 'skipped' outcome).

const tmpDirs = [];
function makeDir(prefix = 'dvb-self-heal-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Clean (unpatched) core-package source carrying COND_A and COND_B verbatim. */
const CLEAN_GATE = [
  'function admissionGate(model) {',
  '  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) return "reject";',
  "  if (model.inputModalities !== undefined && !model.inputModalities.includes('image')) return 'reject';",
  '  return "accept";',
  '}',
  '',
].join('\n');
const PATCHED_GATE = 'const gate = false ' + ADMISSION_PATCH_MARKER + '\n';

/** Write one or both admission-gate target files under a temp node_modules root. */
function writeGateFiles(nodeModulesDir, content, { only } = {}) {
  for (const file of admissionPatchTargets(nodeModulesDir)) {
    if (only !== undefined && !file.endsWith(only)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
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

describe('§12.2 A — startup self-heal of the admission gate', () => {
  it('an already-patched directory is left untouched: already, zero writes, zero logs', async () => {
    const nm = makeDir();
    writeGateFiles(nm, PATCHED_GATE);
    const before = admissionPatchTargets(nm).map((file) => statSync(file).mtimeMs);
    const logger = makeLogger();
    const result = await selfHealAdmissionGate({ nodeModulesDir: nm, logger });
    assert.equal(result.status, 'already');
    assert.deepEqual(result.files.map((f) => f.status), ['skipped', 'skipped']);
    assert.deepEqual(logger.lines, { info: [], warn: [], error: [] }, 'no log noise when nothing had to be done');
    assert.deepEqual(admissionPatchTargets(nm).map((file) => statSync(file).mtimeMs), before, 'no file was touched');
  });

  it('a clean directory is re-patched: marker on disk, .bak kept, one info line naming the next boot', async () => {
    const nm = makeDir();
    writeGateFiles(nm, CLEAN_GATE);
    const logger = makeLogger();
    const result = await selfHealAdmissionGate({ nodeModulesDir: nm, logger });
    assert.equal(result.status, 'patched');
    assert.deepEqual(result.files.map((f) => f.status), ['patched', 'patched']);
    for (const file of admissionPatchTargets(nm)) {
      assert.ok(readFileSync(file, 'utf8').includes(ADMISSION_PATCH_MARKER), file + ' must carry the marker');
      assert.ok(readFileSync(file + '.bak-vision-bridge', 'utf8').includes('admissionGate'), file + ' must keep its backup');
    }
    assert.deepEqual(logger.lines.info, [SELF_HEAL_REPATCHED_LOG]);
    assert.ok(logger.lines.info[0].includes('(effective on next boot)'), 'the log must state the scope (§12.2 D)');
    assert.deepEqual(logger.lines.error, []);
  });

  it('one patched and one clean file: only the missing marker is repaired', async () => {
    const nm = makeDir();
    writeGateFiles(nm, PATCHED_GATE, { only: 'lib/index.js' });
    writeGateFiles(nm, CLEAN_GATE, { only: 'lib/types/commands.js' });
    const logger = makeLogger();
    const result = await selfHealAdmissionGate({ nodeModulesDir: nm, logger });
    assert.equal(result.status, 'patched');
    assert.deepEqual(result.files.map((f) => f.status), ['skipped', 'patched']);
    assert.equal(logger.lines.info.length, 1);
  });

  it('a rejecting repair is caught: one error line, status failed, never throws', async () => {
    const logger = makeLogger();
    const result = await selfHealAdmissionGate({
      nodeModulesDir: makeDir(),
      logger,
      applyPatch: async () => { throw new Error('EACCES: permission denied'); },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /EACCES/);
    assert.equal(logger.lines.error.length, 1);
    assert.match(logger.lines.error[0], /self-heal failed/);
    assert.deepEqual(logger.lines.info, []);
  });

  it('a missing node_modules directory degrades to failed without throwing', async () => {
    const logger = makeLogger();
    const result = await selfHealAdmissionGate({ nodeModulesDir: join(makeDir(), 'nope'), logger });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.files.map((f) => f.status), ['error', 'error']);
    assert.equal(logger.lines.error.length, 1, 'exactly one self-heal error line');
  });

  it('fiber re-entry: the second apply() entry reuses the cached outcome (one repair call)', async () => {
    const nm = makeDir();
    writeGateFiles(nm, CLEAN_GATE);
    let calls = 0;
    const applyPatch = ({ nodeModulesDir }) => {
      calls += 1;
      writeGateFiles(nodeModulesDir, PATCHED_GATE);
      return [{ file: 'a', status: 'patched' }];
    };
    const first = await selfHealAdmissionGate({ nodeModulesDir: nm, applyPatch, cache: new Map() });
    const second = await selfHealAdmissionGate({ nodeModulesDir: nm, applyPatch, cache: new Map() });
    assert.equal(calls, 2, 'independent caches run independently (the default cache is per process)');
    assert.equal(first.status, 'patched');
    assert.equal(second.status, 'patched');

    const shared = new Map();
    let sharedCalls = 0;
    const sharedPatch = () => { sharedCalls += 1; return [{ file: 'a', status: 'patched' }]; };
    const a = selfHealAdmissionGate({ nodeModulesDir: nm, applyPatch: sharedPatch, cache: shared });
    const b = selfHealAdmissionGate({ nodeModulesDir: nm, applyPatch: sharedPatch, cache: shared });
    assert.equal(a, b, 'the cached promise is returned verbatim');
    await Promise.all([a, b]);
    assert.equal(sharedCalls, 1, 'at most one repair per entry point');
  });

  it('resolveNodeModulesDir prefers the plugin ../.. and falls back to DSH_HOME', () => {
    // Installed layout: <node_modules>/@dsh-external/dsh-vision-bridge, so the
    // plugin's ../.. IS the node_modules directory.
    const nm = makeDir();
    const installedPluginRoot = join(nm, '@dsh-external', 'dsh-vision-bridge');
    mkdirSync(join(nm, '@deepseek-ai', 'dsh-api-session-controller'), { recursive: true });
    assert.equal(resolveNodeModulesDir(installedPluginRoot), nm);
    // no core package next to the checkout → DSH_HOME derivation (patch script DEFAULT_NM)
    const bare = join(makeDir(), 'checkout');
    mkdirSync(bare, { recursive: true });
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = join(nm, 'home');
    try {
      assert.equal(resolveNodeModulesDir(bare), join(nm, 'home', 'profiles', 'web', 'node_modules'));
      delete process.env.DSH_HOME;
      assert.equal(resolveNodeModulesDir(bare), join(bare, '..', '..'), 'without DSH_HOME the primary derivation stands');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it('apply() runs the self-heal once per process and caches it (§12.1 non-functional)', async () => {
    const cacheDir = makeDir();
    const ctx = makeFakeCtx();
    resetSelfHealCache();
    const disposer = await apply(ctx, {
      provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
      credential: 'VISION_API_KEY',
      cache: { persistDir: join(cacheDir, 'cache') },
    });
    let calls = 0;
    const result = await selfHealAdmissionGate({
      nodeModulesDir: resolveNodeModulesDir(),
      applyPatch: () => { calls += 1; return []; },
    });
    assert.equal(calls, 0, 'apply() already performed and cached the self-heal for this directory');
    assert.ok(['already', 'patched', 'failed'].includes(result.status));
    await disposer();
    resetSelfHealCache();
  });
});

describe('§12.2 B — admission behavior probe', () => {
  const LIVE_ERROR = Object.assign(new Error('Model "glm-5.3" does not support image input.'), {
    name: 'RemoteError',
    code: 'session/attachment-invalid',
    details: { reason: ADMISSION_GATE_LIVE_REASON },
  });

  it('an admitted submission means the loaded gate is dead (and the message is cleaned up)', async () => {
    const cleaned = [];
    const result = await probeAdmissionGate({
      promptRemote: async ({ sessionId, content }) => {
        assert.equal(sessionId, 'scratch-1');
        assert.equal(content[0].type, 'text');
        assert.equal(content[1].type, 'image');
        assert.equal(content[1].mediaType, 'image/png');
        return { accepted: true };
      },
      ensureScratchSession: async () => 'scratch-1',
      cleanupScratchMessage: async (sessionId, submitted) => { cleaned.push([sessionId, submitted.accepted]); },
    });
    assert.deepEqual(result, { runtime: 'dead' });
    assert.deepEqual(cleaned, [['scratch-1', true]]);
  });

  it('the gate rejection code means the loaded gate is live', async () => {
    const result = await probeAdmissionGate({
      promptRemote: async () => { throw LIVE_ERROR; },
      ensureScratchSession: async () => 'scratch-1',
    });
    assert.deepEqual(result, { runtime: 'live', reason: ADMISSION_GATE_LIVE_REASON });
  });

  it('agent-busy and unexpected failures are inconclusive — never a verdict', async () => {
    const busy = Object.assign(new Error('prompt rejected'), { code: 'session/agent-busy' });
    assert.deepEqual(
      await probeAdmissionGate({ promptRemote: async () => { throw busy; }, ensureScratchSession: async () => 's' }),
      { runtime: 'unknown', reason: 'inconclusive' },
    );
    assert.deepEqual(
      await probeAdmissionGate({ promptRemote: async () => { throw new Error('socket hang up'); }, ensureScratchSession: async () => 's' }),
      { runtime: 'unknown', reason: 'inconclusive' },
    );
  });

  it('without an RPC face or a scratch session the probe reports unknown and submits nothing', async () => {
    let called = 0;
    assert.deepEqual(await probeAdmissionGate({}), { runtime: 'unknown', reason: 'rpc-face-unavailable' });
    assert.deepEqual(
      await probeAdmissionGate({ promptRemote: async () => { called += 1; } }),
      { runtime: 'unknown', reason: 'scratch-session-unavailable' },
    );
    assert.deepEqual(
      await probeAdmissionGate({ promptRemote: async () => { called += 1; }, ensureScratchSession: async () => undefined }),
      { runtime: 'unknown', reason: 'scratch-session-unavailable' },
    );
    assert.equal(called, 0);
  });

  it('a wedged submission times out into unknown instead of hanging the env route', async () => {
    const result = await probeAdmissionGate({
      promptRemote: () => new Promise(() => {}),
      ensureScratchSession: async () => 's',
      probeTimeoutMs: 30,
    });
    assert.deepEqual(result, { runtime: 'unknown', reason: 'inconclusive' });
  });

  it('a failing cleanup must not change an admitted verdict', async () => {
    const logger = makeLogger();
    const result = await probeAdmissionGate({
      promptRemote: async () => ({ accepted: true }),
      ensureScratchSession: async () => 's',
      cleanupScratchMessage: async () => { throw new Error('no such message'); },
      logger,
    });
    assert.deepEqual(result, { runtime: 'dead' });
    assert.equal(logger.lines.warn.length, 1);
  });

  it('classifyAdmissionProbeError reads the gate reason from details, message, or neither', () => {
    assert.equal(classifyAdmissionProbeError(LIVE_ERROR), 'live');
    assert.equal(classifyAdmissionProbeError({ details: { reason: ADMISSION_GATE_LIVE_REASON } }), 'live');
    assert.equal(classifyAdmissionProbeError(new Error('Model does not support image input.')), 'live');
    assert.equal(classifyAdmissionProbeError(Object.assign(new Error('x'), { code: 'session/agent-busy' })), 'unknown');
    assert.equal(classifyAdmissionProbeError(undefined), 'unknown');
  });
});

describe('§12.2 B — production RPC seam (opt-in) and the model pick', () => {
  it('the real RPC seam stays off unless the deployment opts in', () => {
    assert.equal(admissionProbeEnabled({}), false);
    assert.equal(admissionProbeEnabled({ VISION_BRIDGE_ADMISSION_PROBE: '0' }), false);
    assert.equal(admissionProbeEnabled({ VISION_BRIDGE_ADMISSION_PROBE: '1' }), true);
    assert.equal(admissionProbeEnabled({ VISION_BRIDGE_ADMISSION_PROBE: ' ON ' }), true);
    const ctx = { get: () => { throw new Error('must not be reached'); } };
    assert.deepEqual(buildAdmissionProbeDeps(ctx, () => undefined, {}), {}, 'no seam while disabled');
  });

  it('with the opt-in on, the seam adopts a stable scratch session on a text-only model', async () => {
    const previous = process.env.VISION_BRIDGE_ADMISSION_PROBE;
    process.env.VISION_BRIDGE_ADMISSION_PROBE = '1';
    try {
      const calls = [];
      const service = {
        async create(request) { calls.push(['create', request]); return { sessionId: request.sessionId }; },
        async selectModel(request) { calls.push(['selectModel', request]); return { selected: request }; },
        async prompt(request, signal) { calls.push(['prompt', request, signal instanceof AbortSignal]); return { accepted: true }; },
      };
      const deps = buildAdmissionProbeDeps({ get: (name) => (name === 'sessionController' ? service : undefined) }, () => ({
        providers: {
          zai: { models: [{ id: 'vl', input: ['text', 'image'] }, { id: 'plain', input: ['text'] }] },
        },
      }));
      assert.deepEqual(Object.keys(deps).sort(), ['ensureScratchSession', 'promptRemote']);
      const sessionId = await deps.ensureScratchSession();
      assert.equal(sessionId, ADMISSION_PROBE_SESSION_ID, 'a stable id keeps the scratch session from multiplying');
      assert.deepEqual(calls[0], ['create', { sessionId: ADMISSION_PROBE_SESSION_ID }]);
      assert.deepEqual(calls[1], ['selectModel', { sessionId: ADMISSION_PROBE_SESSION_ID, provider: 'zai', model: 'plain' }],
        'the gate only fires for a text-only model');
      await deps.promptRemote({ sessionId, content: [] });
      assert.equal(calls[2][0], 'prompt');
      assert.equal(calls[2][2], true, 'the submission carries an AbortSignal');
      // and the seam feeds the probe end to end
      assert.deepEqual(await probeAdmissionGate(deps), { runtime: 'dead' });
    } finally {
      if (previous === undefined) delete process.env.VISION_BRIDGE_ADMISSION_PROBE;
      else process.env.VISION_BRIDGE_ADMISSION_PROBE = previous;
    }
  });

  it('pickTextOnlyModel picks the first non-image model and tolerates empty projections', () => {
    assert.equal(pickTextOnlyModel([]), undefined);
    assert.equal(pickTextOnlyModel(undefined), undefined);
    assert.equal(pickTextOnlyModel([{ id: 'p', models: [{ id: 'v', vision: true }] }]), undefined);
    assert.deepEqual(
      pickTextOnlyModel([{ id: 'p', models: [{ id: 'v', vision: true }, { id: 't', vision: false }] }, { id: 'q', models: [] }]),
      { provider: 'p', model: 't' },
    );
  });
});

describe('§12.2 B — env route admission payload', () => {
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
  function mount(deps) {
    const routes = new Map();
    const webServer = {
      port: 45999,
      host: '127.0.0.1',
      register({ path, handler }) { routes.set(path, handler); return () => { routes.delete(path); }; },
    };
    installServerRoutes({ webServer }, { fetchImpl: async () => ({ status: 404 }), ...deps });
    return routes.get(ROUTE_ENV);
  }
  async function callEnv(deps) {
    const handler = mount(deps);
    const { res, captured } = makeRes();
    await handler(makeReq('GET'), res);
    return { status: captured.status, body: JSON.parse(captured.body) };
  }

  it('reports disk=patched + runtime=dead (no conflict) while keeping the §11 fields', async () => {
    const nm = makeDir();
    writeGateFiles(nm, PATCHED_GATE);
    const { status, body } = await callEnv({
      nodeModulesDir: nm,
      settingsGet: () => undefined,
      promptRemote: async () => ({ accepted: true }),
      ensureScratchSession: async () => 's',
    });
    assert.equal(status, 200);
    assert.equal(body.admission.status, 'ok', 'the §11 field is unchanged for the first-generation card');
    assert.deepEqual(body.admission.files.map((f) => f.status), ['ok', 'ok']);
    assert.equal(body.admission.disk, 'patched');
    assert.equal(body.admission.runtime, 'dead');
    assert.equal(body.admission.conflict, false);
  });

  it('flags the §12.1 story-1 state: disk repaired, running gate still live', async () => {
    const nm = makeDir();
    writeGateFiles(nm, PATCHED_GATE);
    const live = Object.assign(new Error('Model does not support image input.'), {
      code: 'session/attachment-invalid',
      details: { reason: ADMISSION_GATE_LIVE_REASON },
    });
    const { body } = await callEnv({
      nodeModulesDir: nm,
      settingsGet: () => undefined,
      promptRemote: async () => { throw live; },
      ensureScratchSession: async () => 's',
    });
    assert.equal(body.admission.disk, 'patched');
    assert.equal(body.admission.runtime, 'live');
    assert.equal(body.admission.conflict, true);
  });

  it('reports disk=missing with an unverified runtime when no probe seam exists', async () => {
    const nm = makeDir();
    writeGateFiles(nm, CLEAN_GATE);
    const { body } = await callEnv({ nodeModulesDir: nm, settingsGet: () => undefined });
    assert.equal(body.admission.status, 'missing');
    assert.equal(body.admission.disk, 'missing');
    assert.equal(body.admission.runtime, 'unknown');
    assert.equal(body.admission.conflict, false);
  });

  it('reports disk=unknown when the core package is absent', async () => {
    const { body } = await callEnv({ nodeModulesDir: join(makeDir(), 'nope'), settingsGet: () => undefined });
    assert.equal(body.admission.status, 'unknown');
    assert.equal(body.admission.disk, 'unknown');
  });
});

/** Minimal cordis-shaped ctx so apply() can run end to end (settings/tools/auto). */
function makeFakeCtx() {
  return {
    logger: () => makeLogger(),
    on() { return () => {}; },
    effect(fn) { return fn(); },
    tools: { register() { return () => {}; } },
    systemPrompt: { context() { return () => {}; } },
    get() { return undefined; },
    settings: {
      register(ns, schema, options = {}) {
        const state = { user: {}, watchers: [] };
        const resolved = () => schema({ ...(options.base ?? {}), ...state.user });
        const scope = {
          get: resolved,
          watch(cb) { state.watchers.push(cb); return () => {}; },
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
      get() { return undefined; },
    },
    credentials: { async resolve() { return { value: 'sk-test' }; } },
    attachments: { async readImageRequest(ref) { return { attachment: ref, data: new Uint8Array([1]), mediaType: 'image/png' }; } },
  };
}
