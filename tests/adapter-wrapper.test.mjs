import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyGate } from '../lib/cache-backend.js';
import { EmptyResponseError, createWrappedAdapter } from '../lib/adapter-wrapper.js';

function okFetch(body = { choices: [{ message: { content: 'analysis' } }] }) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe('createWrappedAdapter — basic call behavior', () => {
  it('returns model text on success', async () => {
    const adapter = createWrappedAdapter({ fetchImpl: okFetch() });
    const text = await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 });
    assert.equal(text, 'analysis');
  });

  it('surfaces HTTP errors as failures with status text', async () => {
    const adapter = createWrappedAdapter({
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}', json: async () => ({}) }),
      random: () => 0,
    });
    await assert.rejects(
      adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }),
      /API error 401/,
    );
  });
});

describe('empty responses fail (never cached downstream)', () => {
  it('throws EmptyResponseError on blank content', async () => {
    const adapter = createWrappedAdapter({ fetchImpl: okFetch({ choices: [{ message: { content: '' } }] }) });
    await assert.rejects(adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), EmptyResponseError);
  });

  it('throws EmptyResponseError on whitespace-only content', async () => {
    const adapter = createWrappedAdapter({ fetchImpl: okFetch({ choices: [{ message: { content: '   \n  ' } }] }) });
    await assert.rejects(adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), EmptyResponseError);
  });

  it('does not retry an empty response', async () => {
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => '{"choices":[]}', json: async () => ({ choices: [] }) }; },
      random: () => 0,
    });
    await assert.rejects(adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), EmptyResponseError);
    assert.equal(calls, 1);
  });
});

describe('retry with jittered backoff', () => {
  it('retries 5xx then succeeds', async () => {
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502, text: async () => 'bad gateway', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
      random: () => 0,
    });
    const text = await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 });
    assert.equal(text, 'ok');
    assert.equal(calls, 2);
  });

  it('retries 429 then succeeds', async () => {
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) };
        return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
      random: () => 0,
    });
    assert.equal(await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), 'ok');
    assert.equal(calls, 2);
  });

  it('does NOT retry 4xx client errors', async () => {
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async () => { calls += 1; return { ok: false, status: 400, text: async () => 'bad request', json: async () => ({}) }; },
      random: () => 0,
    });
    await assert.rejects(adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), /API error 400/);
    assert.equal(calls, 1);
  });

  it('gives up after 2 retries (3 attempts total)', async () => {
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async () => { calls += 1; return { ok: false, status: 500, text: async () => 'nope', json: async () => ({}) }; },
      random: () => 0,
    });
    await assert.rejects(adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 }), /API error 500/);
    assert.equal(calls, 3);
  });
});

describe('signal wiring (library bug repaired at the wrapper)', () => {
  it('caller cancellation aborts the in-flight request and rejects with the reason', async () => {
    const controller = new AbortController();
    let fetchAborted = false;
    const adapter = createWrappedAdapter({
      fetchImpl: (url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          fetchAborted = true;
          reject(new Error('The operation was aborted'));
        });
      }),
      random: () => 0,
    });
    const pending = adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 30000, signal: controller.signal });
    controller.abort(new Error('turn cancelled'));
    await assert.rejects(pending, /turn cancelled/);
    assert.equal(fetchAborted, true, 'the abort must reach the fetch-level signal');
  });

  it('caller cancellation during retry backoff stops the retry loop', async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter = createWrappedAdapter({
      fetchImpl: async (_url, init) => {
        calls += 1;
        if (init.signal.aborted) throw new Error('aborted');
        return { ok: false, status: 500, text: async () => 'nope', json: async () => ({}) };
      },
      random: () => 0,
    });
    const pending = adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 30000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled mid-retry')), 10);
    await assert.rejects(pending, /cancelled mid-retry/);
    assert.ok(calls < 3, 'cancellation must short-circuit remaining retries');
  });
});

describe('token budgets', () => {
  it('structured calls send maxTokens >= 2048', async () => {
    const seen = [];
    const adapter = createWrappedAdapter({
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"x"}}]}', json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
      },
      structured: true,
    });
    await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 });
    assert.ok(seen[0].max_tokens >= 2048, 'structured mode must budget at least 2048 tokens, got ' + seen[0].max_tokens);
  });

  it('basic calls keep the engine default (no explicit max_tokens override)', async () => {
    const seen = [];
    const adapter = createWrappedAdapter({
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body));
        return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"x"}}]}', json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
      },
    });
    await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 });
    assert.equal(seen[0].max_tokens, 1024);
  });
});

describe('supportsImages', () => {
  it('delegates modality probing to the engine adapter', () => {
    const adapter = createWrappedAdapter({});
    assert.equal(adapter.supportsImages({ id: 'vl', input: ['text', 'image'] }), true);
    assert.equal(adapter.supportsImages({ id: 'text-only', input: ['text'] }), false);
  });
});

describe('shared gate semantics used by the runtime', () => {
  it('gate width from config bounds adapter concurrency', async () => {
    const gate = new ConcurrencyGate(2);
    let active = 0, peak = 0;
    const adapter = createWrappedAdapter({ fetchImpl: okFetch() });
    await Promise.all(Array.from({ length: 5 }, () => gate.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await adapter.call([{ role: 'user', content: 'hi' }], { model: 'vl', timeoutMs: 5000 });
      active -= 1;
    })));
    assert.equal(peak, 2);
  });
});
