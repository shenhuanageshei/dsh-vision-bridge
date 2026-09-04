import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVisionBridgeReadTool } from '../lib/tools.js';
import { NamespacedNoteCache, InFlightDedup, ConcurrencyGate, noteKey, hashQuestion, fingerprint } from '../lib/cache-backend.js';
import { resolveConfig } from '../lib/config.js';

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const ID_B = 'sha256:12345678abcdef1234567890abcdef1234567890abcdef1234567890abcdef0a';

const tmpDirs = [];
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-tools-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function ref(id) {
  return { attachmentId: id, mediaType: 'image/png', bytes: 100, width: 10, height: 10 };
}
function imageEvent(seq, id) {
  return { type: 'user/message', seq, time: seq, data: { role: 'user', id: 'm' + seq, source: { kind: 'user' }, content: [{ type: 'image', attachment: ref(id) }] } };
}

/**
 * Scripted runtime: sessions from plain event arrays, the VLM from a queue of
 * canned notes, attachments from a fake store. Same seams the real index.js
 * wires, without DSH services.
 */
function makeRuntime({ events = [imageEvent(1, ID_A)], notes = ['image_overview: ok'], mode = 'both' } = {}) {
  const config = resolveConfig({
    provider: { baseURL: 'https://api.example.com/v1', model: 'vl' },
    mode,
    cache: { persistDir: makeDir() },
  }, {});
  const toolCache = new NamespacedNoteCache('tool', config.cache.persistDir, { maxEntries: 16 });
  const noteQueue = [...notes];
  const calls = [];
  const runtime = {
    logger: { info() {}, warn() {}, error() {} },
    lifecycle: new AbortController(),
    getConfig: () => config,
    analyzeCalls: calls,
    async analyzeImage(entry, question, { namespace = 'tool', signal } = {}) {
      const key = noteKey(namespace, String(entry.attachmentId).toLowerCase(), hashQuestion(String(question ?? '')), fingerprint(config));
      const cached = toolCache.get(key);
      if (cached !== null) return cached;
      calls.push({ entry: entry.attachmentId, question, signal });
      if (noteQueue.length === 0) throw new Error('vision bridge: vision model returned an empty response');
      const note = noteQueue.shift();
      toolCache.set(key, note);
      return note;
    },
    combinedSignal: (controller) => AbortSignal.any([runtime.lifecycle.signal, controller.signal]),
  };
  const tool = createVisionBridgeReadTool(runtime);
  const exec = (extra = {}) => ({
    agent: { session: { snapshotEvents: () => (events ?? [imageEvent(1, ID_A)]) } },
    signal: new AbortController().signal,
    ...extra,
  });
  return { runtime, tool, exec, config, toolCache };
}

describe('vision_bridge_read', () => {
  it('analyzes an image cited by its 8-hex placeholder prefix', async () => {
    const { tool, exec, runtime } = makeRuntime({ notes: ['image_overview: red error banner'] });
    const value = await tool.execute({ ref: ID_A.slice(7, 15), question: '报错是什么？' }, exec());
    assert.match(value, /UNTRUSTED EVIDENCE/);
    assert.match(value, /image_overview: red error banner/);
    assert.match(value, /sha256:12345678/);
    assert.equal(runtime.analyzeCalls.length, 1);
    assert.equal(runtime.analyzeCalls[0].question, '报错是什么？');
  });

  it('defaults the ref to the latest session image', async () => {
    const { tool, exec, runtime } = makeRuntime({
      events: [imageEvent(1, ID_B), imageEvent(2, ID_A)],
      notes: ['image_overview: newest'],
    });
    const value = await tool.execute({}, exec());
    assert.match(value, /image_overview: newest/);
    assert.equal(runtime.analyzeCalls[0].entry, ID_A);
  });

  it('a bad ref rejects with actionable guidance', async () => {
    const { tool, exec } = makeRuntime();
    await assert.rejects(
      tool.execute({ ref: 'not-hex' }, exec()),
      /attachment id/,
    );
  });

  it('an unknown ref lists available images', async () => {
    const { tool, exec } = makeRuntime();
    await assert.rejects(
      tool.execute({ ref: '00000000' }, exec()),
      /no session image matches.*Available images.*12345678/s,
    );
  });

  it('an ambiguous prefix returns the candidate list without guessing', async () => {
    const { tool, exec } = makeRuntime({ events: [imageEvent(1, ID_A), imageEvent(2, ID_B)] });
    await assert.rejects(
      tool.execute({ ref: '12345678' }, exec()),
      /matches 2 images.*seq 1.*seq 2/s,
    );
  });

  it('a session with no images explains itself', async () => {
    const { tool, exec } = makeRuntime({ events: [] });
    await assert.rejects(
      tool.execute({}, exec()),
      /no image attachments exist in this session/,
    );
  });

  it('serves a cached note without re-calling the VLM (same image + question)', async () => {
    const { tool, exec, runtime } = makeRuntime({ notes: ['first-answer'] });
    const first = await tool.execute({ ref: ID_A.slice(7, 15), question: 'same question' }, exec());
    const second = await tool.execute({ ref: ID_A.slice(7, 15), question: 'same question' }, exec());
    assert.match(first, /first-answer/);
    assert.match(second, /first-answer/);
    assert.equal(runtime.analyzeCalls.length, 1, 'second call must hit the cache');
  });

  it('same image + different question misses the cache', async () => {
    const { tool, exec, runtime } = makeRuntime({ notes: ['answer-1', 'answer-2'] });
    await tool.execute({ ref: ID_A.slice(7, 15), question: 'question one' }, exec());
    await tool.execute({ ref: ID_A.slice(7, 15), question: 'question two' }, exec());
    assert.equal(runtime.analyzeCalls.length, 2);
  });

  it('an empty VLM response surfaces as a failure (isError path)', async () => {
    const { tool, exec, runtime } = makeRuntime({ notes: [] });
    await assert.rejects(tool.execute({ ref: ID_A.slice(7, 15) }, exec()), /empty/);
    assert.equal(runtime.analyzeCalls.length, 1, 'no cache write happened');
  });

  it('turn cancellation aborts the in-flight analysis', async () => {
    const abortController = new AbortController();
    const dir = makeDir();
    const config = resolveConfig({ provider: { baseURL: 'https://api.example.com/v1', model: 'vl' }, cache: { persistDir: dir } }, {});
    const toolCache = new NamespacedNoteCache('tool', dir);
    const observed = [];
    const runtime = {
      logger: { info() {}, warn() {} },
      lifecycle: new AbortController(),
      getConfig: () => config,
      async analyzeImage(entry, question, { signal } = {}) {
        observed.push(signal);
        // simulate the wrapped adapter honoring the signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled', { cause: signal.reason })));
        });
      },
      combinedSignal: (c) => AbortSignal.any([runtime.lifecycle.signal, c.signal]),
    };
    const tool = createVisionBridgeReadTool(runtime);
    const pending = tool.execute({ ref: ID_A.slice(7, 15) }, {
      agent: { session: { snapshotEvents: () => [imageEvent(1, ID_A)] } },
      signal: abortController.signal,
    });
    abortController.abort(new Error('turn cancelled by user'));
    await assert.rejects(pending, /cancelled/);
    assert.equal(observed[0].aborted, true, 'the exec signal must be aborted');
    assert.equal(toolCache.size, 0, 'cancelled analyses must not be cached');
  });

  it('is disabled with an actionable error when mode excludes tool', async () => {
    const { tool, exec } = makeRuntime({ mode: 'auto' });
    await assert.rejects(
      tool.execute({}, exec()),
      /mode="auto".*vision-bridge.mode/,
    );
  });
});
