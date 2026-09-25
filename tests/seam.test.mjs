import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plainSection } from './_plain-section.mjs';
import { apply, resetSelfHealCache } from '../lib/index.js';
import { resolveConfig, seamRouteIncluded } from '../lib/config.js';
import {
  CORDIS_ORIGINAL,
  SEAM_MARK,
  installSeam,
  resolveModelInfoUnseamed,
  seamInstalled,
  seamTarget,
} from '../lib/seam.js';

// §4.2 seam unit matrix (design v4.1 + review B1/B2, N11a/N11b, E1/E5b/E7/E8).
// Zero dependencies and zero host state: every case runs against a local fake
// service instance shaped like the real LlmRuntime (resolveModelInfo on the
// PROTOTYPE, non-enumerable, writable/configurable) behind a cordis-shaped
// traceable proxy.

/** Text-only service instance: `resolveModelInfo` lives on the prototype and
 * returns a fresh info object, kept as `lastInfo` so a test can prove identity
 * (no rewrite of the adapter's answer). */
class FakeLlm {
  constructor(inputModalities = ['text']) {
    /** null = the adapter declares no inputModalities at all (E8). */
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

/** Minimal cordis-shaped traceable proxy: a FRESH method proxy on every read
 * (review F5: this is exactly why `llm.resolveModelInfo === wrapped` can never
 * hold) plus the `cordis.original` back-pointer to the real instance. */
function traceable(raw) {
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === CORDIS_ORIGINAL) return target;
      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') return (...args) => value.apply(receiver, args);
      return value;
    },
    set(target, property, value) {
      if (property === CORDIS_ORIGINAL) return false;
      return Reflect.set(target, property, value);
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
const readDescriptor = (target, property) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  return descriptor === undefined
    ? undefined
    : { writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable };
};

describe('§4.2 seam — install', () => {
  it('E1: installs on the REAL instance and injects image capability', async () => {
    const { raw, llm } = makeLlm();
    const logger = makeLogger();
    const result = installSeam(llm, { logger });

    assert.equal(result.status, 'installed');
    assert.equal(typeof result.restore, 'function');
    assert.equal(seamTarget(llm), raw, 'every read/write goes through cordis.original');
    assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'the shadow property lands on the real instance');
    assert.equal(raw.resolveModelInfo, raw[SEAM_MARK].wrapped, 'B1 guard reads the real instance');
    assert.notEqual(llm.resolveModelInfo, raw.resolveModelInfo, 'a proxy read is a fresh shadow method (B1 root cause)');

    const info = await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3');
    assert.deepEqual(modalitiesOf(info), ['text', 'image']);
    assert.deepEqual(modalitiesOf(raw.lastInfo), ['text'], 'the adapter answer is not rewritten in place');
    assert.equal(info === raw.lastInfo, false, 'the seam returns a NEW object');
    assert.equal(raw.calls.length, 1);
    assert.equal(logger.lines.info.length, 1);
    assert.match(logger.lines.info[0], /installed on llm\.resolveModelInfo/);
  });

  it('N11a: the shadow property keeps the prototype method\'s enumerability', async () => {
    const { raw, llm } = makeLlm();
    const prototypeDescriptor = readDescriptor(Object.getPrototypeOf(raw), 'resolveModelInfo');
    assert.deepEqual(prototypeDescriptor, { writable: true, enumerable: false, configurable: true }, 'fake matches LlmRuntime');

    installSeam(llm);
    assert.deepEqual(readDescriptor(raw, 'resolveModelInfo'), prototypeDescriptor, 'own property is descriptor-identical');
    assert.deepEqual(Object.keys(raw).filter((key) => key === 'resolveModelInfo'), [], 'not enumerable');
  });

  it('a multi-modal model is passed through untouched (same object, E3)', async () => {
    const { raw, llm } = makeLlm(['text', 'image']);
    installSeam(llm);
    const info = await llm.resolveModelInfo('p', 'vl');
    assert.equal(info, raw.lastInfo, 'no copy for an already image-capable model');
    assert.deepEqual(modalitiesOf(info), ['text', 'image']);
  });

  it('E8: an undeclared inputModalities stays undeclared —字段逐项不变', async () => {
    const { raw, llm } = makeLlm(null);
    installSeam(llm);
    const info = await llm.resolveModelInfo('p', 'unknown');
    assert.equal(info, raw.lastInfo, 'identity: the adapter answer is returned as-is');
    assert.deepEqual(Object.keys(info).sort(), ['id', 'name', 'provider']);
    assert.equal('inputModalities' in info, false);
  });

  it('an own-property resolveModelInfo is restored losslessly (not just deleted)', async () => {
    const raw = new FakeLlm();
    const own = async () => ({ provider: 'p', id: 'own', name: 'own' });
    Object.defineProperty(raw, 'resolveModelInfo', { value: own, writable: true, configurable: true, enumerable: false });
    const { restore } = installSeam(traceable(raw));
    assert.notEqual(raw.resolveModelInfo, own);
    assert.equal(restore(), true);
    assert.equal(raw.resolveModelInfo, own, 'the previous own property came back');
    assert.deepEqual(readDescriptor(raw, 'resolveModelInfo'), { writable: true, enumerable: false, configurable: true });
  });
});

describe('§4.2 seam — idempotence and restore', () => {
  it('"already" is a behavior self-proof and its restore works (B2)', async () => {
    const { raw, llm } = makeLlm();
    const first = installSeam(llm);
    const second = installSeam(llm);
    assert.equal(second.status, 'already');
    assert.equal(second.restore, first.restore, 'the already-path hands back the live restore');

    assert.equal(second.restore(), true);
    assert.equal(seamInstalled(llm), false);
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text']);
  });

  it('a stale marker is NOT read as installed: the seam is re-installed (B2)', async () => {
    const { raw, llm } = makeLlm();
    raw[SEAM_MARK] = { wrapped: async () => ({}), restore: () => true, original: raw.resolveModelInfo };
    const result = installSeam(llm);
    assert.equal(result.status, 'installed', 'marker without the matching function is residue');
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);
    result.restore();
  });

  it('E5/E5b: restore returns to the baseline, then a re-install still installs', async () => {
    const { raw, llm } = makeLlm();
    const baseline = await llm.resolveModelInfo('p', 'm');
    assert.deepEqual(modalitiesOf(baseline), ['text']);

    const installed = installSeam(llm);
    assert.equal(installed.status, 'installed');
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);

    assert.equal(installed.restore(), true, 'the restore guard hits on the real instance');
    assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'own property is gone — prototype shows through');
    assert.equal(raw[SEAM_MARK], undefined, 'the marker is cleared with the seam');
    assert.equal(raw.resolveModelInfo, FakeLlm.prototype.resolveModelInfo);
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text'], 'behavior is back to the baseline');

    assert.equal(installed.restore(), false, 'restore is idempotent');

    const again = installSeam(llm);
    assert.equal(again.status, 'installed', 'E5b: no "already" false positive');
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);
    assert.equal(again.restore(), true);
  });

  it('R5: a decoration installed ON TOP of ours is never broken by our restore', async () => {
    const { raw, llm } = makeLlm();
    const ours = installSeam(llm);
    const theirWrapped = async function (provider, model, signal) {
      const info = await raw[SEAM_MARK].wrapped.call(this, provider, model, signal);
      return { ...info, decoratedBy: 'other-plugin' };
    };
    Object.defineProperty(raw, 'resolveModelInfo', { value: theirWrapped, writable: true, configurable: true, enumerable: false });

    assert.equal(ours.restore(), false, 'not the outermost layer anymore: hands off');
    assert.equal(raw.resolveModelInfo, theirWrapped);
    const info = await llm.resolveModelInfo('p', 'm');
    assert.equal(info.decoratedBy, 'other-plugin');
    assert.deepEqual(modalitiesOf(info), ['text', 'image'], 'their layer still wraps ours');

    // Their retirement must not resurrect a broken guard: the overwrite took
    // our layer off the instance, so the next install is a real install.
    delete raw.resolveModelInfo;
    assert.equal(seamInstalled(llm), false);
    const again = installSeam(llm);
    assert.equal(again.status, 'installed');
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);
  });

  it('unsupported: a missing/non-function resolveModelInfo installs nothing', () => {
    const logger = makeLogger();
    for (const value of [undefined, null, {}, { resolveModelInfo: 'nope' }, 42, 'llm']) {
      const result = installSeam(value, { logger });
      assert.equal(result.status, 'unsupported');
      assert.equal(result.restore, undefined);
    }
    assert.equal(installSeam(traceable({}), { logger }).status, 'unsupported');
    assert.equal(logger.lines.warn.length, 7, 'every unsupported install says so out loud');
    assert.match(logger.lines.warn[0], /no resolveModelInfo/);
  });
});

describe('§4.3 seam — include filter (E7)', () => {
  it('an included route is injected and an excluded route is untouched', async () => {
    const { llm } = makeLlm();
    const include = (provider, model) => provider === 'zai-coding-cn' && model === 'glm-5.3';
    installSeam(llm, { include });

    const included = await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3');
    assert.deepEqual(modalitiesOf(included), ['text', 'image']);

    const excluded = await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3-flash');
    assert.deepEqual(excluded, { provider: 'zai-coding-cn', id: 'glm-5.3-flash', name: 'glm-5.3-flash', inputModalities: ['text'] });
    const other = await llm.resolveModelInfo('openai', 'gpt-5');
    assert.deepEqual(modalitiesOf(other), ['text']);
  });

  it('the include predicate is re-evaluated on every call (live whitelist)', async () => {
    const { llm } = makeLlm();
    const routes = [];
    installSeam(llm, { include: (provider, model) => { routes.push(provider); return routes.length > 1; } });
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text']);
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);
  });
});

describe('§4.5 seam — requireReader is a call-time predicate (B5 / N11b)', () => {
  it('is not evaluated at install time and flips live without a re-install', async () => {
    const { llm } = makeLlm();
    const logger = makeLogger();
    const seen = [];
    let allowed = false;
    installSeam(llm, {
      logger,
      requireReader: (provider, model) => {
        seen.push(provider + ':' + model);
        return allowed ? true : { allowed: false, reason: 'reader-credential-unconfigured' };
      },
    });

    assert.deepEqual(seen, [], 'N11b: no snapshot — the predicate is not called at install time');

    const blocked = await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3');
    assert.deepEqual(modalitiesOf(blocked), ['text'], 'B5: the hard rejection is kept, no silent success');
    assert.deepEqual(seen, ['zai-coding-cn:glm-5.3']);
    assert.equal(logger.lines.warn.length, 1);
    assert.match(logger.lines.warn[0], /not injecting image capability for zai-coding-cn:glm-5\.3/);
    assert.match(logger.lines.warn[0], /reader-credential-unconfigured/);

    allowed = true;
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text', 'image']);
    assert.equal(seen.length, 2, 'evaluated per call');
    assert.equal(logger.lines.warn.length, 1, 'no warning once the reader is available');
  });

  it('a false verdict never rewrites the adapter answer', async () => {
    const { raw, llm } = makeLlm();
    installSeam(llm, { requireReader: () => false });
    const info = await llm.resolveModelInfo('p', 'm');
    assert.equal(info, raw.lastInfo);
  });

  it('a throwing predicate degrades to the adapter answer and says so', async () => {
    const { raw, llm } = makeLlm();
    const logger = makeLogger();
    installSeam(llm, { logger, requireReader: () => { throw new Error('credential store offline'); } });
    const info = await llm.resolveModelInfo('p', 'm');
    assert.equal(info, raw.lastInfo);
    assert.deepEqual(modalitiesOf(info), ['text']);
    assert.equal(logger.lines.error.length, 1);
    assert.match(logger.lines.error[0], /capability injection failed for p:m \(credential store offline\)/);
  });
});

describe('resolveModelInfoUnseamed — the truth for auto mode', () => {
  it('bypasses our own injection while it is installed', async () => {
    const { llm } = makeLlm();
    installSeam(llm);
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);
    const truth = await resolveModelInfoUnseamed(llm, 'p', 'm');
    assert.deepEqual(modalitiesOf(truth), ['text'], 'auto mode must still see a text-only session model');
  });

  it('falls back to the live accessor when no seam is installed, undefined without a service', async () => {
    const { llm } = makeLlm();
    assert.deepEqual(modalitiesOf(await resolveModelInfoUnseamed(llm, 'p', 'm')), ['text']);
    assert.equal(await resolveModelInfoUnseamed(undefined, 'p', 'm'), undefined);
  });
});

describe('§4.3 seam configuration surface', () => {
  const FALLBACK = { persistDirFallback: 'D:/tmp/vb-seam-cache' };
  const base = (overrides = {}) => ({
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
    credential: 'VISION_API_KEY',
    cache: { persistDir: '' },
    ...overrides,
  });

  it('resolves the three keys with the documented defaults', () => {
    const resolved = resolveConfig(base(), FALLBACK);
    assert.deepEqual(resolved.seam, { mode: 'auto', include: [], requireReader: true });
    assert.deepEqual(resolveConfig(base({ seam: { mode: 'off', include: ['qax:glm-5.3'], requireReader: false } }), FALLBACK).seam,
      { mode: 'off', include: ['qax:glm-5.3'], requireReader: false });
  });

  it('an invalid include entry refuses the whole generation (refuse-and-keep-old)', () => {
    for (const bad of ['glm-5.3', ':x', 'a:', 'a:b:c', 'a b:c', '', 42]) {
      assert.throws(
        () => resolveConfig(base({ seam: { include: [bad] } }), FALLBACK),
        /seam\.include/,
        'entry ' + JSON.stringify(bad) + ' must be refused',
      );
    }
    assert.throws(() => resolveConfig(base({ seam: { mode: 'yolo' } }), FALLBACK), /seam\.mode/);
    assert.throws(() => resolveConfig(base({ seam: { requireReader: 'yes' } }), FALLBACK), /seam\.requireReader/);
    assert.throws(() => resolveConfig(base({ seam: { include: 'a:b' } }), FALLBACK), /seam\.include/);
  });

  it('seamRouteIncluded: empty = every route, otherwise verbatim provider:model', () => {
    assert.equal(seamRouteIncluded([], 'a', 'b'), true);
    assert.equal(seamRouteIncluded(undefined, 'a', 'b'), true);
    assert.equal(seamRouteIncluded(['a:b'], 'a', 'b'), true);
    assert.equal(seamRouteIncluded(['a:b'], 'a', 'c'), false);
    assert.equal(seamRouteIncluded(['a:b'], 'A', 'b'), false, 'ids match verbatim');
  });
});

/** apply()'s ctx shape (the same minimum the §12 suite uses), with the llm
 * service observable so the wiring can be asserted end to end. */
function makeApplyCtx(llm, { llmRow, failTools = false } = {}) {
  let scope;
  let currentLlm = llm;
  const logger = makeLogger();
  /** Cleanup functions handed to ctx.effect, in registration order: a test can
   * run them to simulate the fiber teardown a throwing apply() triggers. */
  const effects = [];
  const ctx = {
    logger: () => logger,
    logs: logger.lines,
    on() { return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    tools: { register() { if (failTools) throw new Error('tools service rejected the registration'); return () => {}; } },
    systemPrompt: { context() { return () => {}; } },
    inject() { return () => {}; },
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
      /** Cross-namespace read (legacy generation): the §4.5-2 self-check picks
       * its route from this projection. */
      get(namespace) { return namespace === 'llm-pi-ai' ? llmRow : undefined; },
    },
    credentials: { async resolve() { return { value: 'sk-test' }; } },
    attachments: { async readImageRequest(ref) { return { attachment: ref, data: new Uint8Array([1]), mediaType: 'image/png' }; } },
  };
  return {
    ctx,
    effects,
    /** Simulate the llm service arriving after apply() (a future N-I4 retry). */
    setLlm(next) { currentLlm = next; },
    update: (patch) => scope.update(patch),
    logs: logger.lines,
  };
}

/** Hermetic environment: DSH_HOME and the §12 self-heal scan pinned to a temp
 * directory, so apply() never reads or writes the real host state. */
function pinEnv(dir) {
  const previousHome = process.env.DSH_HOME;
  const previousNm = process.env.VISION_BRIDGE_SELF_HEAL_NM;
  process.env.DSH_HOME = dir;
  process.env.VISION_BRIDGE_SELF_HEAL_NM = join(dir, 'nm');
  resetSelfHealCache();
  return () => {
    resetSelfHealCache();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    if (previousNm === undefined) delete process.env.VISION_BRIDGE_SELF_HEAL_NM; else process.env.VISION_BRIDGE_SELF_HEAL_NM = previousNm;
  };
}

describe('apply() wiring — install, live re-seat, dispose (E5/E6)', () => {
  const configFor = (dir) => ({
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
    credential: 'VISION_API_KEY',
    cache: { persistDir: join(dir, 'cache') },
  });

  it('installs the decoration, then the fiber disposer puts the baseline back', async () => {
    const { raw, llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-apply-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx } = makeApplyCtx(llm);
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'apply() decorated the real instance');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text', 'image']);

      await dispose();
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'the disposer deleted the shadow property');
      assert.equal(raw[SEAM_MARK], undefined, 'and cleared the marker');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text']);

      // A fiber restart must install again, never report 'already' (B2/E5b).
      const dispose2 = await apply(makeApplyCtx(llm).ctx, configFor(dir));
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 're-entry installs again');
      await dispose2();
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('E6: a live seam.mode change reaches the running process without a restart', async () => {
    const { raw, llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-live-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, update } = makeApplyCtx(llm);
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true);

      await update({ seam: { mode: 'off' } });
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'mode=off uninstalls in place');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text']);

      await update({ seam: { mode: 'auto' } });
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'mode=auto installs again in place');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text', 'image']);

      // A narrowed include list is applied through the same re-seat.
      await update({ seam: { mode: 'auto', include: ['qax:glm-5.3'] } });
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('qax', 'glm-5.3')), ['text', 'image']);
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('qax', 'glm-5.1')), ['text']);

      await dispose();
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('§4.5-2 seam self-proof through apply()', () => {
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

  it('resolves the picked text-only route and reports seam live', async () => {
    const { llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-livecheck-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, logs } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(logs.info.some((line) => /runtime seam live/.test(line)), true, 'the self-proof reported live');
      assert.match(logs.info.find((line) => /runtime seam live/.test(line)), /qax:glm-5\.3/);
      await dispose();
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failing resolve leaves live unknown, keeps the seam, and never blocks apply()', async () => {
    const { raw, llm } = makeLlm();
    raw.resolveModelInfo = async () => { throw new Error('adapter lookup exploded'); };
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-livefail-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, logs } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(logs.warn.some((line) => /self-check failed \(adapter lookup exploded\)/.test(line)), true);
      assert.equal(logs.info.some((line) => /runtime seam live/.test(line)), false, 'no fake ✓');
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'the seam stays installed');
      await dispose();
      assert.equal(raw.resolveModelInfo !== undefined, true, 'the own property we replaced came back');
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('B-I1 — the seam rides the fiber lifecycle', () => {
  const configFor = (dir) => ({
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
    credential: 'VISION_API_KEY',
    cache: { persistDir: join(dir, 'cache') },
  });

  it('a throw after the install restores the seam and leaves it re-installable', async () => {
    const { raw, llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-bi1-throw-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx } = makeApplyCtx(llm, { failTools: true });
      await assert.rejects(
        () => apply(ctx, configFor(dir)),
        /tools service rejected the registration/,
        'the failing load rejects apply() — exactly the pre-B-I1 situation',
      );
      // ① the decoration is gone, marker included
      assert.equal(raw[SEAM_MARK], undefined, 'the marker was cleared');
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, 'the shadow property was deleted');
      // ② the gate is back to the baseline: no image, so the hard rejection stands
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text']);
      // ③ the next install is a real install, never a stale 'already'
      const again = installSeam(llm);
      assert.equal(again.status, 'installed');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text', 'image']);
      assert.equal(again.restore(), true);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ctx.effect cleanup restores the seam when the fiber is torn down', async () => {
    const { raw, llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-bi1-effect-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, effects } = makeApplyCtx(llm);
      const dispose = await apply(ctx, configFor(dir));
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true, 'installed by the effect callback');
      assert.equal(effects.length > 0, true, 'the install registered a fiber-owned cleanup');
      for (const cleanup of effects) cleanup(); // simulate cordis tearing the fiber down
      assert.equal(raw[SEAM_MARK], undefined, 'the effect cleanup restored the seam');
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text']);
      await dispose(); // still safe on the normal path afterwards (④)
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false);
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('N-I1 — the self-check respects seam.include', () => {
  const TEXT_ONLY_ROW = {
    providers: {
      qax: {
        baseURL: 'https://qax.example/v1',
        models: [{ id: 'glm-5.3', name: 'glm-5.3', input: ['text'] }],
      },
    },
  };
  const configFor = (dir, extra = {}) => ({
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl-model' },
    credential: 'VISION_API_KEY',
    cache: { persistDir: join(dir, 'cache') },
    ...extra,
  });

  it('a whitelist excluding the only text-only route reports why, not a fake dead verdict', async () => {
    const { raw, llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-ni1-excluded-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, logs } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir, { seam: { include: ['zai-coding-cn:glm-5.3'] } }));
      assert.equal(
        logs.warn.some((line) => /no included text-only route/.test(line)),
        true,
        'the reason names the empty whitelist intersection',
      );
      assert.equal(
        logs.warn.some((line) => /NOT injecting/.test(line)),
        false,
        'the seam was never measured, so no dead verdict may be published',
      );
      assert.equal(logs.info.some((line) => /runtime seam live/.test(line)), false, 'and no check mark either');
      // the seam itself still works for a route the config DOES name
      assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')), ['text', 'image']);
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), true);
      await dispose();
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an included text-only route is picked and proves the seam live', async () => {
    const { llm } = makeLlm();
    const dir = mkdtempSync(join(tmpdir(), 'dvb-seam-ni1-included-'));
    const restoreEnv = pinEnv(dir);
    try {
      const { ctx, logs } = makeApplyCtx(llm, { llmRow: TEXT_ONLY_ROW });
      const dispose = await apply(ctx, configFor(dir, { seam: { include: ['qax:glm-5.3'] } }));
      assert.equal(logs.info.some((line) => /runtime seam live/.test(line)), true);
      assert.match(logs.info.find((line) => /runtime seam live/.test(line)), /qax:glm-5\.3/);
      await dispose();
    } finally {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('N-I3 — a non-extensible service degrades to unsupported', () => {
  it('preventExtensions and freeze: no throw, no install, no marker', () => {
    for (const [label, seal] of [
      ['preventExtensions', (raw) => Object.preventExtensions(raw)],
      ['freeze', (raw) => Object.freeze(raw)],
    ]) {
      const { raw, llm } = makeLlm();
      seal(raw);
      const logger = makeLogger();
      const result = installSeam(llm, { logger });
      assert.equal(result.status, 'unsupported', label + ': the three-state contract holds');
      assert.equal(result.restore, undefined);
      assert.equal(Object.hasOwn(raw, 'resolveModelInfo'), false, label + ': nothing was installed');
      assert.equal(raw[SEAM_MARK], undefined, label + ': no marker residue');
      assert.equal(typeof raw.resolveModelInfo, 'function', label + ': the prototype method is untouched');
      assert.equal(logger.lines.warn.length, 1);
      assert.match(logger.lines.warn[0], /not extensible/);
    }
  });

  it('the instance keeps answering normally after the refusal', async () => {
    const { raw, llm } = makeLlm();
    Object.preventExtensions(raw);
    assert.equal(installSeam(llm).status, 'unsupported');
    assert.deepEqual(modalitiesOf(await llm.resolveModelInfo('p', 'm')), ['text']);
    assert.equal(raw.calls.length, 1);
  });
});

