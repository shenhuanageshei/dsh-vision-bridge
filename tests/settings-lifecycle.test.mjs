import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, ensureFrozenDefaults } from '../lib/index.js';

const tmpDirs = [];
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-apply-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Minimal cordis-shaped ctx: captures registrations, resolves services. */
function makeFakeCtx({ credential = { value: 'sk-test', source: 'env' }, fetchBody = null } = {}) {
  const registered = { tools: [], contexts: [], handlers: new Map(), effects: [] };
  let settingsScope = undefined;
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on(name, handler) { registered.handlers.set(name, handler); return () => registered.handlers.delete(name); },
    effect(fn) { registered.effects.push(fn); return fn(); },
    tools: { register(def) { registered.tools.push(def); return () => {}; } },
    systemPrompt: { context(c) { registered.contexts.push(c); return () => {}; } },
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
            for (const w of state.watchers) await w(value);
          },
        };
        // emulate the service: a stored section that fails validate rejects registration
        options.validate?.(resolved());
        settingsScope = scope;
        return scope;
      },
      get(ns) {
        if (ns === 'vision-toolkit') return { provider: { baseUrl: 'https://toolkit.example/v1', model: 'toolkit-vl', credential: 'TOOLKIT_KEY' } };
        return undefined;
      },
    },
    credentials: {
      async resolve() {
        if (credential === null) return undefined;
        return credential;
      },
    },
    attachments: {
      async readImageRequest(ref, policy, signal) {
        ctx.lastReadRef = ref;
        ctx.lastReadPolicy = policy;
        // 1x1 PNG, base64 of a minimal payload
        return { variantId: 'v1', attachment: ref, data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 10, height: 10 };
      },
    },
    registered,
    get settingsScope() { return settingsScope; },
  };
  return ctx;
}

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const ID_B = 'sha256:12345678abcdef1234567890abcdef1234567890abcdef1234567890abcdef0a';
function ref(id) { return { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 10, height: 10 }; }
function imageEvent(seq, id) {
  return { type: 'user/message', seq, time: seq, data: { role: 'user', id: 'm' + seq, source: { kind: 'user' }, content: [{ type: 'image', attachment: ref(id) }] } };
}

describe('ensureFrozenDefaults (first-run toolkit copy, then frozen)', () => {
  it('copies the toolkit provider values once, then only reads the frozen file', () => {
    const dir = makeDir();
    const file = path.join(dir, 'provider-defaults.json');
    const reads = [];
    const settings = { get(ns) { reads.push(ns); return { provider: { baseUrl: 'https://toolkit.example/v1', model: 'toolkit-vl' } }; } };
    const first = ensureFrozenDefaults(settings, file, { warn() {}, info() {} });
    assert.deepEqual(first, { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });
    assert.equal(fs.existsSync(file), true, 'frozen file must be persisted');

    // second run: toolkit namespace is never consulted again
    reads.length = 0;
    const second = ensureFrozenDefaults({ get(ns) { reads.push(ns); return undefined; } }, file, { warn() {}, info() {} });
    assert.deepEqual(second, { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });
    assert.equal(reads.filter((n) => n === 'vision-toolkit').length, 0, 'no live toolkit reads after freezing');
  });

  it('defers the freeze (returns undefined, writes nothing) when the toolkit namespace is unavailable', () => {
    const dir = makeDir();
    const file = path.join(dir, 'provider-defaults.json');
    const frozen = ensureFrozenDefaults({ get() { throw new Error('no such namespace'); } }, file, { warn() {}, info() {} });
    assert.equal(frozen, undefined, 'nothing may be frozen without toolkit values');
    assert.equal(fs.existsSync(file), false, 'the baked fallback must NOT be persisted over a missing toolkit');
  });

  it('a corrupt frozen file degrades gracefully; a later toolkit read repairs it', () => {
    const dir = makeDir();
    const file = path.join(dir, 'provider-defaults.json');
    fs.writeFileSync(file, '{broken json', 'utf8');
    // toolkit still absent: nothing frozen, no crash
    const frozen = ensureFrozenDefaults({ get() { return undefined; } }, file, { warn() {}, info() {} });
    assert.equal(frozen, undefined);
    // toolkit becomes available: the corrupt file is replaced by real values
    const repaired = ensureFrozenDefaults(
      { get() { return { provider: { baseUrl: 'https://toolkit.example/v1', model: 'toolkit-vl' } }; } },
      file,
      { warn() {}, info() {} },
    );
    assert.deepEqual(repaired, { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), repaired);
  });
});

describe('apply() — settings, tool, auto wiring', () => {
  it('registers the namespace live, mounts the tool and auto listeners, disposes cleanly', async () => {
    const dir = makeDir();
    const ctx = makeFakeCtx();
    const disposer = await apply(ctx, {
      provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
      credential: 'VISION_API_KEY',
      cache: { persistDir: path.join(dir, 'cache') },
    });
    assert.ok(ctx.settingsScope, 'settings namespace must be registered');
    assert.equal(ctx.registered.tools.length, 1);
    assert.equal(ctx.registered.tools[0].name, 'vision_bridge_read');
    assert.ok(ctx.registered.handlers.get('session/event'));
    assert.ok(ctx.registered.handlers.get('agent/pre-step'));
    assert.ok(ctx.registered.handlers.get('agent/created'));
    assert.equal(ctx.registered.contexts.length, 1, 'PromptContext fallback registered');

    await disposer();
  });

  it('an invalid stored section rejects registration (loud failure at load)', async () => {
    const dir = makeDir();
    const ctx = makeFakeCtx();
    // bad timeout inside the composition base → validate throws during register
    await assert.rejects(
      apply(ctx, {
        provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
        timeoutMs: 5,
        cache: { persistDir: path.join(dir, 'cache') },
      }),
      /timeoutMs/,
    );
  });

  it('a refused live update keeps the previous configuration', async () => {
    const dir = makeDir();
    const ctx = makeFakeCtx();
    const disposer = await apply(ctx, {
      provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
      cache: { persistDir: path.join(dir, 'cache') },
    });
    // schema would coerce garbage; use an out-of-range integer to trip validate
    await assert.rejects(
      ctx.settingsScope.update({ timeoutMs: 999999999 }),
      /timeoutMs/,
    );
    await disposer();
  });

  it('first run freezes toolkit defaults into DSH_HOME; empty provider section keeps serving', async () => {
    const dir = makeDir();
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeFakeCtx();
      const disposer = await apply(ctx, { cache: { persistDir: path.join(dir, 'cache') } });
      const frozenFile = path.join(dir, 'vision-bridge', 'provider-defaults.json');
      assert.equal(fs.existsSync(frozenFile), true, 'frozen defaults must live under <DSH_HOME>/vision-bridge');
      assert.deepEqual(JSON.parse(fs.readFileSync(frozenFile, 'utf8')), { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });
      // the schema-level section stays empty (user may override); the runtime
      // resolution uses the frozen defaults
      assert.equal(ctx.settingsScope.get().provider.baseURL, '');
      await disposer();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});

describe('apply() — credential + attachment chain through the tool', () => {
  it('missing credential surfaces an actionable error and caches nothing', async () => {
    const dir = makeDir();
    const ctx = makeFakeCtx({ credential: null });
    const disposer = await apply(ctx, {
      provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
      cache: { persistDir: path.join(dir, 'cache') },
    });
    const tool = ctx.registered.tools[0];
    const exec = {
      agent: { session: { snapshotEvents: () => [imageEvent(1, ID_A)] } },
      signal: new AbortController().signal,
    };
    await assert.rejects(tool.execute({ ref: ID_A.slice(7, 15) }, exec), /VISION_API_KEY.*not configured/);
    await disposer();
  });

  it('happy path: tool → credential resolve → readImageRequest → engine request (fetch stubbed)', async () => {
    const dir = makeDir();
    const realFetch = globalThis.fetch;
    let seenInit;
    let fetchCalls = 0;
    globalThis.fetch = async (url, init) => {
      fetchCalls += 1;
      seenInit = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'image_overview: end-to-end ok' } }] }),
      };
    };
    try {
      const ctx = makeFakeCtx();
      const disposer = await apply(ctx, {
        provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
        cache: { persistDir: path.join(dir, 'cache') },
      });
      const tool = ctx.registered.tools[0];
      const exec = {
        agent: { session: { snapshotEvents: () => [imageEvent(1, ID_A)] } },
        signal: new AbortController().signal,
      };
      const value = await tool.execute({ ref: ID_A.slice(7, 15), question: '什么内容' }, exec);
      assert.match(value, /UNTRUSTED EVIDENCE/);
      assert.match(value, /image_overview: end-to-end ok/);
      assert.match(seenInit.url, /https:\/\/api\.example\.com\/v1\/chat\/completions/);
      const body = JSON.parse(seenInit.init.body);
      assert.equal(body.model, 'vl');
      assert.equal(body.messages[0].content[1].type, 'image_url');
      assert.match(seenInit.init.headers.Authorization, /^Bearer sk-test$/);
      assert.equal(ctx.lastReadRef.attachmentId, ID_A, 'the durable ref must reach readImageRequest');
      assert.equal(ctx.lastReadPolicy.maxPixels, 40000000);
      assert.equal(fetchCalls, 1, 'exactly one VLM HTTP call for the first answer');
      // cache: second identical call serves from cache — no second VLM request
      await tool.execute({ ref: ID_A.slice(7, 15), question: '什么内容' }, exec);
      assert.equal(ctx.lastReadRef.attachmentId, ID_A);
      assert.equal(fetchCalls, 1, 'cache hit must not refetch');
      await disposer();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('mode=tool gates the auto event path: an image event triggers no VLM work', async () => {
    const dir = makeDir();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
    };
    try {
      const ctx = makeFakeCtx();
      const disposer = await apply(ctx, {
        provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
        mode: 'tool',
        cache: { persistDir: path.join(dir, 'cache') },
      });
      // drive the real listener the way the runtime would
      const onEvent = ctx.registered.handlers.get('session/event');
      onEvent({ id: 'session-x' }, imageEvent(1, ID_A));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(fetchCalls, 0, 'mode=tool must not auto-analyze new images');
      // and the PromptContext fallback stays empty for that session
      const promptText = ctx.registered.contexts[0].text({ agent: { session: { id: 'session-x' } } });
      assert.equal(promptText, '');
      await disposer();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('toolkit namespace unregistered → freeze is deferred (no file, no baked persistence)', async () => {
    const dir = makeDir();
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dir;
    try {
      const ctx = makeFakeCtx();
      ctx.settings.get = () => undefined; // sibling bundle not registered yet
      const disposer = await apply(ctx, { cache: { persistDir: path.join(dir, 'cache') } });
      const frozenFile = path.join(dir, 'vision-bridge', 'provider-defaults.json');
      assert.equal(fs.existsSync(frozenFile), false, 'no freeze file must be written without toolkit values');
      // the schema section stays empty; runtime resolution fell back to baked
      // defaults WITHOUT persisting them
      assert.equal(ctx.settingsScope.get().provider.baseURL, '');
      await disposer();

      // a later apply WITH the toolkit present performs the real freeze
      const ctx2 = makeFakeCtx();
      const disposer2 = await apply(ctx2, { cache: { persistDir: path.join(dir, 'cache') } });
      assert.equal(fs.existsSync(frozenFile), true, 'the deferred freeze lands once the toolkit namespace exists');
      assert.deepEqual(JSON.parse(fs.readFileSync(frozenFile, 'utf8')), { baseURL: 'https://toolkit.example/v1', model: 'toolkit-vl' });
      await disposer2();
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });
});
