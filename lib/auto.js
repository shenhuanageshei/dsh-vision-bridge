/**
 * Auto mode (design §5.4): new user/message images are analyzed in the
 * background and the resulting description enters the SAME turn via the
 * agent/pre-step waterfall.
 *
 * Race discipline: the in-flight promise is registered SYNCHRONOUSLY at the
 * session/event listener entry, before any await (appendix A③ — a pre-step can
 * fire before any async listener continuation runs). Correlation happens by the
 * attachment ids the entering messages actually carry; only matching results
 * are injected. Timeout, failure, or no match → the decision passes through
 * unchanged (tool mode covers the gap). A PromptContext contribution serves any
 * note that lands after its step already assembled, and prunes after one
 * consumption so long sessions don't pay a per-step token tax.
 *
 * The library's own injectIntoMessages is deliberately NOT used (double
 * injection with pre-step), and system-prompt/assemble is never touched
 * (registered sections restore after that waterfall — appendix A③).
 *
 * @module @dsh-external/dsh-vision-bridge/auto
 */
import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { walkImageBlocks, stripPlaceholders } from './resolve.js';

const CONTEXT_NAME = 'vision-bridge-auto-context';
const CONTEXT_ORDER = 900;
const UNTRUSTED_DISCLAIMER = '[UNTRUSTED EVIDENCE — machine-generated description from a vision model; verify visually before relying on exact details]';

/** Collapse user message text to the normalized question fed to the VLM
 * (DSH placeholders stripped first — appendix B①). Pure image messages pass
 * an empty request and the engine falls back to its generic prompt. */
function questionOf(eventData) {
  let text = '';
  if (Array.isArray(eventData?.content)) {
    for (const block of eventData.content) {
      if (block?.type === 'text') text += block.text ?? '';
    }
  } else if (typeof eventData?.content === 'string') {
    text = eventData.content;
  }
  return stripPlaceholders(text).replace(/\s+/g, ' ').trim();
}

function shortId(attachmentId) {
  return 'sha256:' + String(attachmentId).replace(/^sha256:/i, '').slice(0, 8);
}

/** Bounded wait that releases immediately when the turn is cancelled — no
 * orphan timer keeps the pre-step hanging after an abort. */
function sleepUntil(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => done();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Stable per-question hash for the in-flight dedup key (same image + same
 * question dedupes; same image + a different question analyzes again). */
function questionHash(question) {
  return createHash('sha256').update(String(question ?? '')).digest('hex').slice(0, 16);
}

/**
 * Install auto-mode listeners. All registrations ride the plugin fiber's
 * effect system; the returned disposer is a final safety net.
 *
 * @param ctx - plugin context (inject: system-prompt; events ride ctx.on).
 * @param runtime - shared runtime: getConfig(), analyzeImage(ref, question,
 *   { namespace, signal }), logger, lifecycle (AbortController).
 * @returns disposer.
 */
export function installAutoMode(ctx, runtime) {
  const logger = runtime.logger;
  /** Map<sessionId::attachmentIdLower, { seq, controller, result?, promise }> */
  const inflight = new Map();
  /** Map<sessionId, Array<{ attachmentId, question, note }>> awaiting one consumption */
  const pendingNotes = new Map();

  const enabled = () => {
    const mode = runtime.getConfig().mode;
    return mode === 'auto' || mode === 'both';
  };

  const onSessionEvent = (session, event) => {
    if (!enabled()) return;
    if (event?.type !== 'user/message') return;
    // ── synchronous section: register in-flight BEFORE any await (§5.4) ──
    const refs = [];
    walkImageBlocks(event.data?.content, (ref) => refs.push(ref));
    if (refs.length === 0) return;
    const config = runtime.getConfig();
    const question = questionOf(event.data);
    const seq = event.seq;
    const capped = refs.slice(0, config.autoMode.maxPerTurn);
    if (refs.length > capped.length) {
      logger?.warn?.('vision-bridge auto: ' + (refs.length - capped.length)
        + ' image(s) beyond autoMode.maxPerTurn=' + config.autoMode.maxPerTurn + ' not analyzed (use vision_bridge_read)');
    }
    for (const ref of capped) {
      // Dedup key = session + attachment + question: the same image with a
      // DIFFERENT question analyzes again (its own answer/cache entry); the
      // same image with the same question dedupes.
      const key = session.id + '::' + String(ref.attachmentId).toLowerCase() + '::' + questionHash(question);
      if (inflight.has(key)) continue; // same attachment + question already in flight: keep the first
      const controller = new AbortController();
      const entry = { seq, controller, result: undefined, attachmentId: String(ref.attachmentId) };
      entry.promise = (async () => {
        try {
          const note = await runtime.analyzeImage(ref, question, {
            namespace: 'auto',
            // Turn cancellation aborts via pre-step linkage (below); plugin
            // disposal aborts via the lifecycle controller.
            signal: runtime.combinedSignal(controller),
          });
          entry.result = { status: 'ok', note, question };
          pushPending(session.id, ref.attachmentId, question, note);
          return entry.result;
        } catch (error) {
          entry.result = { status: 'failed', error: error?.message ?? String(error) };
          logger?.warn?.('vision-bridge auto: analysis failed for ' + shortId(ref.attachmentId) + ' (' + entry.result.error + '); turn continues unchanged');
          return entry.result;
        }
      })();
      inflight.set(key, entry);
      entry.promise
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        })
        .catch(() => {});
    }
  };

  function pushPending(sessionId, attachmentId, question, note) {
    const list = pendingNotes.get(sessionId) ?? [];
    if (list.some((p) => p.attachmentId === attachmentId)) return; // dedupe re-pushes
    list.push({ attachmentId, question, note });
    pendingNotes.set(sessionId, list);
  }

  /** Pre-step injection claims its notes: remove them from the PromptContext
   * fallback queue so one request never carries the same note twice. */
  function removePending(sessionId, attachmentId) {
    const list = pendingNotes.get(sessionId);
    if (!list) return;
    const next = list.filter((p) => p.attachmentId !== attachmentId);
    if (next.length === 0) pendingNotes.delete(sessionId);
    else pendingNotes.set(sessionId, next);
  }

  const onPreStep = async (payload, next) => {
    // The loop's decision (claimed messages + runtime context) always wins as
    // the base; we only APPEND a vision-context message when correlation hits.
    const decision = await next();
    try {
      if (decision?.kind !== 'enter') return decision;
      if (!enabled()) return decision;
      const signal = payload.signal;

      const sessionId = String(payload.agent.session.id);
      const ids = [];
      for (const message of decision.messages ?? []) {
        walkImageBlocks(message.content, (ref) => {
          const id = String(ref.attachmentId).toLowerCase();
          if (!ids.includes(id)) ids.push(id);
        });
      }
      if (ids.length === 0) return decision;

      const waiters = [];
      const pushed = new Set();
      for (const message of decision.messages ?? []) {
        const qHash = questionHash(questionOf(message));
        for (const id of ids) {
          // Exact key first: this message's own question. Fallback: any
          // in-flight analysis of the same image (the normalized question may
          // differ slightly from the message text).
          const entries = [];
          const exact = inflight.get(sessionId + '::' + id + '::' + qHash);
          if (exact) entries.push(exact);
          else {
            const prefix = sessionId + '::' + id + '::';
            for (const [key, entry] of inflight) {
              if (key.startsWith(prefix)) entries.push(entry);
            }
          }
          for (const entry of entries) {
            if (pushed.has(entry)) continue;
            pushed.add(entry);
            // Link this turn's cancellation into the analysis controller: a
            // cancelled turn stops its in-flight VLM call (test matrix).
            if (signal) {
              const onAbort = () => entry.controller.abort(signal.reason);
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
              entry.promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
            }
            waiters.push(entry);
          }
        }
      }
      if (waiters.length === 0) return decision;
      if (signal?.aborted) return decision; // linkage above already aborted the orphans

      // Bounded wait: the VLM call itself is capped by timeoutMs; the wait here
      // mirrors it. On timeout — or on turn cancellation, which releases the
      // wait immediately — the step passes through and the note lands via the
      // PromptContext fallback once it settles.
      const budget = Math.max(1, runtime.getConfig().timeoutMs);
      await Promise.race([
        Promise.allSettled(waiters.map((w) => w.promise)),
        sleepUntil(budget, signal),
      ]);

      const notes = [];
      for (const entry of waiters) {
        if (entry.result?.status === 'ok') {
          notes.push({ question: entry.result.question, note: entry.result.note });
          // Claim this note for the step: keep it out of the PromptContext
          // fallback queue so the same request never shows it twice.
          removePending(sessionId, entry.attachmentId);
        }
      }
      if (notes.length === 0) return decision;

      const sections = notes.map((n, idx) => {
        const scope = n.question
          ? 'the attached image; the user asked when sending it: "' + n.question + '"'
          : 'the attached image (no explicit question when it was sent)';
        return '[image ' + (idx + 1) + ' — 该解读回答的是附图当时的问题 (this interpretation answers the question asked when the image was sent)]\n'
          + 'scope: ' + scope + '\n'
          + n.note;
      });
      const text = '<vision-context>\n'
        + UNTRUSTED_DISCLAIMER + '\n'
        + 'Descriptions below were generated by an external vision model for image(s) attached to THIS step.\n\n'
        + sections.join('\n\n') + '\n'
        + '</vision-context>';

      logger?.info?.('vision-bridge auto: injecting ' + notes.length
        + ' vision note(s) into turn ' + payload.turn + ' step ' + payload.step);

      const visionMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'vision-bridge',
          form: 'notice',
          summary: 'untrusted VLM description of attached screenshot(s)',
        },
      });
      return { kind: 'enter', messages: [...decision.messages, visionMessage] };
    } catch (error) {
      logger?.warn?.('vision-bridge auto: pre-step injection skipped (' + (error?.message ?? error) + ')');
      return decision;
    }
  };

  // agent/created backfill: resume/fork seeds do not emit session/event, so
  // prime per-session diagnostics (known image count) from the full log.
  const onAgentCreated = ({ agent }) => {
    try {
      const index = collectSessionImagesSafe(agent);
      logger?.info?.('vision-bridge auto: session ' + agent.session.id
        + ' backfill: ' + index + ' known image attachment(s); only NEW user/message images are auto-analyzed');
    } catch (error) {
      logger?.warn?.('vision-bridge auto: agent/created backfill failed: ' + (error?.message ?? error));
    }
  };

  function collectSessionImagesSafe(agent) {
    // local import cycle avoidance: count image blocks directly
    let count = 0;
    for (const event of agent.session.snapshotEvents()) {
      if (event?.type === 'user/message') walkImageBlocks(event.data?.content, () => { count += 1; });
      else if (event?.type === 'tool/result') walkImageBlocks(event.data?.message?.content, () => { count += 1; });
    }
    return count;
  }

  // PromptContext fallback: serves ONLY notes whose step did not inject them
  // (pre-step claims its notes via removePending) — a genuinely late analysis,
  // or a note whose image was not part of the entering messages. Consumed on
  // first render — pruned so later steps do not keep paying for it.
  const contextDisposer = ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (assembly) => {
      const agent = assembly?.agent;
      if (!agent || !enabled()) return '';
      const sessionId = String(agent.session.id);
      const pending = pendingNotes.get(sessionId);
      if (!pending || pending.length === 0) return '';
      pendingNotes.delete(sessionId); // consume → prune (§5.4)
      const sections = pending.map((p, idx) => '[image ' + (idx + 1) + ' (' + shortId(p.attachmentId) + '…) — answered the question asked when it was sent'
        + (p.question ? ': "' + p.question + '"' : '') + ']\n' + p.note);
      return '<vision-context>\n' + UNTRUSTED_DISCLAIMER
        + '\nVision description(s) for image attachment(s) sent earlier in this session, shown here because they were NOT injected when their turn assembled (late analysis; each shown once):\n\n'
        + sections.join('\n\n') + '\n</vision-context>';
    },
  });

  const offEvent = ctx.on('session/event', onSessionEvent);
  const offPreStep = ctx.on('agent/pre-step', onPreStep);
  const offCreated = ctx.on('agent/created', onAgentCreated);

  return () => {
    offEvent?.();
    offPreStep?.();
    offCreated?.();
    contextDisposer?.();
    inflight.clear();
    pendingNotes.clear();
  };
}
