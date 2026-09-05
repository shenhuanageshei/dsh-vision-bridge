import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installAutoMode } from '../lib/auto.js';

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const ID_B = 'sha256:fedcba0989abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const ID_ORPHAN = 'sha256:00000000000000000000000000000000000000000000000000000000000000ff';

function ref(id) {
  return { attachmentId: id, mediaType: 'image/png', bytes: 100, width: 10, height: 10 };
}
function imageMessage(id, text = '') {
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'image', attachment: ref(id) });
  return { role: 'user', id: 'm-' + id.slice(7, 15), content, source: { kind: 'user' } };
}
function imageEvent(seq, id, text = '') {
  return { type: 'user/message', seq, time: seq, data: imageMessage(id, text) };
}

function makeCtx() {
  const handlers = new Map();
  const contexts = [];
  const logs = { info: [], warn: [], error: [] };
  return {
    handlers,
    contexts,
    logs,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    systemPrompt: { context(c) { contexts.push(c); return () => {}; } },
    logger: { info: (...a) => logs.info.push(a.join(' ')), warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.join(' ')) },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Scripted runtime: analysis queue of deferreds resolved by the test.
 *
 * Modality-gate knobs:
 * - sessionModelInput: the input modalities llm.resolveModelInfo reports for
 *   the session model — undefined (absent = unknown), ['text'],
 *   ['text','image'], or 'throw' (lookup fails).
 * - agentOptions: false simulates an agent with NO explicit model selection
 *   (the registry lookup misses; the deployment default is consulted). */
function makeRuntime({ mode = 'both', timeoutMs = 60000, maxPerTurn = 3, sessionModelInput, agentOptions = true } = {}) {
  const ctx = makeCtx();
  // Modality-gate harness: agents registry + the optional llm/agentDefaultModel reads.
  ctx.agents = {
    get: (id) => (agentOptions ? { id, options: { provider: 'p', model: 'session-model' } } : undefined),
  };
  ctx.get = (name) => {
    if (name === 'llm') {
      return {
        resolveModelInfo: async (provider, model) => {
          if (sessionModelInput === 'throw') throw new Error('model lookup failed');
          return { provider, id: model, name: model, ...(sessionModelInput === undefined ? {} : { inputModalities: sessionModelInput }) };
        },
      };
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'p', model: 'default-model' }) };
    }
    return undefined;
  };
  const queue = [];
  const analyzed = [];
  const lifecycle = new AbortController();
  const runtime = {
    logger: ctx.logger,
    lifecycle,
    config: { mode, timeoutMs, autoMode: { maxPerTurn } },
    getConfig() { return runtime.config; },
    analyzeImage(attachmentRef, question, { signal } = {}) {
      analyzed.push({ id: attachmentRef.attachmentId, question, signal });
      const d = deferred();
      queue.push(d);
      return d.promise;
    },
    combinedSignal: (controller) => AbortSignal.any([lifecycle.signal, controller.signal]),
  };
  const disposer = installAutoMode(ctx, runtime);
  return { ctx, runtime, queue, analyzed, disposer, lifecycle, contexts: ctx.contexts, logs: ctx.logs };
}

function session(id = 'session-1') {
  return { id };
}

async function preStep(ctx, payload, next = async () => ({ kind: 'enter', messages: payload.messages })) {
  return ctx.handlers.get('agent/pre-step')(payload, next);
}

/** One macrotask: lets the async modality gate resolve and the analysis task
 * actually call analyzeImage. In-flight ENTRY registration stays synchronous
 * (the design's race discipline) — only the VLM call start moved one tick. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('auto mode', () => {
  it('fast path: analysis settles before pre-step → same-turn injection correlated by attachment id', async () => {
    const { ctx, queue, analyzed } = makeRuntime();
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, '这是什么报错？'));
    await tick();

    // the in-flight entry was registered synchronously; the analysis task
    // starts right after the (fast) modality gate
    assert.equal(analyzed.length, 1);
    assert.equal(analyzed[0].id, ID_A);
    assert.equal(analyzed[0].question, '这是什么报错？');

    const decisionIn = { kind: 'enter', messages: [imageMessage(ID_A, '这是什么报错？')] };
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: decisionIn.messages, turn: 1, step: 1, signal: new AbortController().signal });
    queue[0].resolve('image_overview: 红色报错横幅');
    const decision = await decisionPromise;

    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, decisionIn.messages.length + 1);
    const injected = decision.messages.at(-1);
    assert.equal(injected.role, 'user');
    assert.equal(injected.source.kind, 'plugin');
    assert.equal(injected.source.plugin, 'vision-bridge');
    const text = injected.content[0].text;
    assert.match(text, /<vision-context>/);
    assert.match(text, /UNTRUSTED EVIDENCE/);
    assert.match(text, /image_overview: 红色报错横幅/);
    assert.match(text, /回答的是附图当时的问题/);
    assert.match(text, /这是什么报错？/);
  });

  it('slow path: analysis pending past the budget → decision unchanged; the note lands via PromptContext once', async () => {
    const { ctx, queue, contexts } = makeRuntime({ timeoutMs: 20 });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, 'slow question'));
    const decisionIn = { kind: 'enter', messages: [imageMessage(ID_A)] };
    const decision = await preStep(ctx, { agent: { session: session() }, messages: decisionIn.messages, turn: 1, step: 1, signal: new AbortController().signal });
    assert.equal(decision.messages.length, decisionIn.messages.length, 'timeout must pass the step through unchanged');

    // analysis lands later → PromptContext fallback
    queue[0].resolve('late note: 登录按钮在右下角');
    await new Promise((r) => setTimeout(r, 5));
    const promptContext = contexts.at(-1);
    const agent = { session: session() };
    const first = promptContext.text({ agent });
    assert.match(first, /<vision-context>/);
    assert.match(first, /late note: 登录按钮在右下角/);
    const second = promptContext.text({ agent });
    assert.equal(second, '', 'consumed notes must be pruned (no per-step token tax)');
  });

  it('failed path: analysis failure logs a warning, injects nothing, caches nothing in PromptContext', async () => {
    const { ctx, queue, contexts, logs } = makeRuntime({ timeoutMs: 30 });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A));
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    await tick();
    queue[0].reject(new Error('vlm down'));
    const decision = await decisionPromise;
    assert.equal(decision.messages.length, 1, 'failed analysis must not inject');
    assert.match(logs.warn.join('\n'), /vlm down/);
    await new Promise((r) => setTimeout(r, 5));
    const promptContext = contexts.at(-1);
    assert.equal(promptContext.text({ agent: { session: session() } }), '');
  });

  it('multi-message order: entering messages get their own notes in order; unrelated images pass through; injected notes stay out of PromptContext', async () => {
    const { ctx, queue, contexts } = makeRuntime();
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, 'first'));
    ctx.handlers.get('session/event')(session(), imageEvent(2, ID_B, 'second'));

    const payload = { agent: { session: session() }, messages: [imageMessage(ID_B), imageMessage(ID_ORPHAN)], turn: 1, step: 1, signal: new AbortController().signal };
    const decisionPromise = preStep(ctx, payload);
    await tick();
    queue[0].resolve('note-A');
    queue[1].resolve('note-B');
    const decision = await decisionPromise;

    // only ID_B correlates with the entering messages (ID_A not entering; orphan has no analysis)
    const text = decision.messages.at(-1).content[0].text;
    assert.match(text, /note-B/);
    assert.doesNotMatch(text, /note-A/);

    // ID_B was injected → claimed out of the fallback queue; ID_A was never
    // injected → PromptContext serves exactly that one, once.
    const later = contexts.at(-1).text({ agent: { session: session() } });
    assert.doesNotMatch(later, /note-B/, 'injected note must not resurface via PromptContext');
    assert.match(later, /note-A/, 'non-injected note is the PromptContext fallback\u2019s only content');
    assert.equal(contexts.at(-1).text({ agent: { session: session() } }), '', 'fallback is consumed on first render');
  });

  it('pre-step injected note is NOT rendered again by PromptContext (no double injection in one request)', async () => {
    const { ctx, queue, contexts } = makeRuntime();
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, 'quick'));
    const decisionIn = { kind: 'enter', messages: [imageMessage(ID_A)] };
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: decisionIn.messages, turn: 1, step: 1, signal: new AbortController().signal });
    await tick();
    queue[0].resolve('same-note');
    const decision = await decisionPromise;
    assert.match(decision.messages.at(-1).content[0].text, /same-note/, 'in-step injection happened');

    // the very same session/assembly must not see the note again
    const promptContext = contexts.at(-1);
    assert.equal(promptContext.text({ agent: { session: session() } }), '', 'PromptContext must stay empty after in-step injection');
  });

  it('synchronous registration wins the race: pre-step fired before any microtask still correlates', async () => {
    const { ctx, queue } = makeRuntime();
    const s = session();
    ctx.handlers.get('session/event')(s, imageEvent(1, ID_A, 'quick'));
    // no awaits between event dispatch and pre-step: the in-flight ENTRY is
    // already registered synchronously, so correlation must hit even though
    // the gated analysis call itself has not started yet
    const decisionPromise = preStep(ctx, { agent: { session: s }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    await tick();
    queue[0].resolve('sync note');
    const decision = await decisionPromise;
    assert.match(decision.messages.at(-1).content[0].text, /sync note/);
  });

  it('mode=tool disables auto entirely', async () => {
    const { ctx, analyzed, queue } = makeRuntime({ mode: 'tool' });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A));
    assert.equal(analyzed.length, 0);
    const decision = await preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    assert.equal(decision.messages.length, 1);
  });

  it('autoMode.maxPerTurn caps per-event analyses', async () => {
    const { ctx, analyzed, queue } = makeRuntime({ maxPerTurn: 2 });
    const ids = ['sha256:aa00000000000000000000000000000000000000000000000000000000000000',
                 'sha256:bb00000000000000000000000000000000000000000000000000000000000000',
                 'sha256:cc00000000000000000000000000000000000000000000000000000000000000'];
    const content = ids.map((id) => ({ type: 'image', attachment: ref(id) }));
    ctx.handlers.get('session/event')(session(), { type: 'user/message', seq: 1, time: 1, data: { role: 'user', id: 'm1', content, source: { kind: 'user' } } });
    await tick();
    assert.equal(analyzed.length, 2, 'cap must limit analyses per user message');
    assert.match(ctx.logs.warn.join('\n'), /maxPerTurn/);

    const payload = { agent: { session: session() }, messages: [{ role: 'user', id: 'm1', content, source: { kind: 'user' } }], turn: 1, step: 1, signal: new AbortController().signal };
    const decisionPromise = preStep(ctx, payload);
    await tick();
    queue[0].resolve('note-0');
    queue[1].resolve('note-1');
    const decision = await decisionPromise;
    const text = decision.messages.at(-1).content[0].text;
    assert.match(text, /note-0/);
    assert.match(text, /note-1/);
  });

  it('turn cancellation aborts the correlated in-flight analysis', async () => {
    const { ctx, analyzed, queue } = makeRuntime();
    const signalController = new AbortController();
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A));
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: signalController.signal });
    signalController.abort(new Error('user hit stop'));
    await decisionPromise.catch(() => {});
    // pre-step aborted before waiting? The abort fires DURING the wait; either
    // the decision passes through or the analysis gets aborted — assert the
    // analysis signal carries the cancellation.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(analyzed[0].signal.aborted, true, 'turn cancellation must abort the VLM call');
  });

  it('agent/created backfill counts known images from the full log', async () => {
    const { ctx, logs } = makeRuntime();
    const events = [
      imageEvent(1, ID_A),
      { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, step: 1, message: { role: 'user', id: 't', content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'image', attachment: ref(ID_B) }] }], source: { kind: 'tool', tool: { callId: 'c', name: 'x' } } } } },
    ];
    ctx.handlers.get('agent/created')({ agent: { session: { id: 'session-1', snapshotEvents: () => events } } });
    assert.match(logs.info.join('\n'), /backfill: 2 known image/);
  });

  it('same image + different question analyzes twice (dedup key includes the question)', async () => {
    const { ctx, analyzed, queue } = makeRuntime();
    const s = session();
    ctx.handlers.get('session/event')(s, imageEvent(1, ID_A, '第一问'));
    ctx.handlers.get('session/event')(s, imageEvent(2, ID_A, '第二问'));
    await tick();
    assert.equal(analyzed.length, 2, 'different questions on the same image must each analyze');
    assert.equal(queue.length, 2);
  });

  it('same image + same question dedupes to one analysis', async () => {
    const { ctx, analyzed, queue } = makeRuntime();
    const s = session();
    ctx.handlers.get('session/event')(s, imageEvent(1, ID_A, 'same question'));
    ctx.handlers.get('session/event')(s, imageEvent(2, ID_A, 'same question'));
    await tick();
    assert.equal(analyzed.length, 1, 'same image + same question stays deduped');
    assert.equal(queue.length, 1);
  });

  it('turn cancellation releases the pre-step bounded wait immediately (no orphan timer)', async () => {
    const { ctx, queue } = makeRuntime({ timeoutMs: 5000 });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A));
    const signalController = new AbortController();
    const started = Date.now();
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: signalController.signal });
    await new Promise((r) => setTimeout(r, 20));
    signalController.abort(new Error('user hit stop'));
    const decision = await decisionPromise;
    const elapsed = Date.now() - started;
    assert.equal(decision.messages.length, 1, 'cancelled wait passes the step through unchanged');
    assert.ok(elapsed < 1000, `cancellation must release the wait immediately (took ${elapsed}ms of a 5000ms budget)`);
    // the analysis itself was linked-aborted; nothing injected later
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(queue[0] !== undefined);
  });

  it('image-capable session (model input includes image) → zero analysis, zero injection, empty PromptContext', async () => {
    const { ctx, analyzed, queue, contexts } = makeRuntime({ sessionModelInput: ['text', 'image'] });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, '这是什么？'));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(analyzed.length, 0, 'a native-vision session must not be analyzed');

    const decision = await preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    assert.equal(decision.messages.length, 1, 'no vision-context injected for image-capable sessions');
    assert.equal(contexts.at(-1).text({ agent: { session: session() } }), '', 'and nothing lands in the PromptContext fallback');
    assert.equal(queue.length, 0, 'no analysis task was ever queued');
  });

  it('text-only session (model input is text only) → analyzes and injects normally', async () => {
    const { ctx, analyzed, queue } = makeRuntime({ sessionModelInput: ['text'] });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, '这是什么？'));
    await tick();
    assert.equal(analyzed.length, 1, 'text-only session must be analyzed');

    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    await tick();
    queue[0].resolve('text-only note');
    const decision = await decisionPromise;
    assert.match(decision.messages.at(-1).content[0].text, /text-only note/);
  });

  it('unresolvable model (lookup fails) → conservative fallback analyzes', async () => {
    const { ctx, analyzed, queue, logs } = makeRuntime({ sessionModelInput: 'throw' });
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A, 'fallback'));
    await tick();
    assert.equal(analyzed.length, 1, 'unknown model keeps the pre-gate behavior (analyze)');
    const decisionPromise = preStep(ctx, { agent: { session: session() }, messages: [imageMessage(ID_A)], turn: 1, step: 1, signal: new AbortController().signal });
    await tick();
    queue[0].resolve('fallback note');
    const decision = await decisionPromise;
    assert.match(decision.messages.at(-1).content[0].text, /fallback note/);
  });

  it('agent without an explicit model falls back to the deployment default selection', async () => {
    const { ctx, analyzed } = makeRuntime({ sessionModelInput: ['text', 'image'], agentOptions: false });
    // agents.get misses; the default selection resolves to an image-capable
    // model → the gate still skips the bridge.
    ctx.handlers.get('session/event')(session(), imageEvent(1, ID_A));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(analyzed.length, 0, 'the default-selection path must feed the same gate');
  });
});
