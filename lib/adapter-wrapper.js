/**
 * Engine adapter wrapper (design §5.6). Wraps the vendored library's LLM
 * adapters — source logic unchanged — and repairs the engineering gaps at the
 * plugin layer:
 *
 * - **signal wiring** (library bug: CallOptions.signal is declared but never
 *   connected to fetch): the wrapper's per-call fetch merges the caller's
 *   AbortSignal into the request via AbortSignal.any, so DIRECT callers of
 *   `call()` can cancel the in-flight HTTP request. Reachability note: the
 *   engine's `analyze()` API takes no signal, so engine-driven requests cannot
 *   pass one — cancellable engine requests await an upstream analyze(signal)
 *   passthrough.
 * - **retry** with 2× jittered backoff on retryable failures — network errors
 *   (fetch TypeError) and HTTP 429/5xx. Engine-internal timeout aborts surface
 *   from fetch as a reason-less AbortError, which is NOT retried; caller
 *   cancellation is NEVER retried and rethrows its reason immediately;
 * - **empty responses fail** instead of returning '' (an empty note must not
 *   be cached or injected);
 * - **structured mode budgets maxTokens ≥ 2048** so structured JSON is not
 *   truncated into the engine's fallback path;
 * - `timeoutMs` defaulting to 60000 (validated 1000..600000 in config).
 *
 * @module @dsh-external/dsh-vision-bridge/adapter-wrapper
 */
import { OpenAICompatibleAdapter } from '../vendor/vision-bridge/dist/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../vendor/vision-bridge/dist/adapters/anthropic.js';

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 300;

function backoffDelay(attempt, random = Math.random) {
  return BACKOFF_BASE_MS * 2 ** attempt + Math.floor(random() * 250);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(getAbortReason(signal) ?? new Error('vision bridge: aborted before retry'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(getAbortReason(signal) ?? new Error('vision bridge: aborted during retry backoff'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** fetch rejects with its own AbortError discarding the abort reason; recover
 * the caller's reason when the external signal is the origin. */
function getAbortReason(signal) {
  return signal?.reason;
}

function statusFromMessage(message) {
  const m = /API error (\d{3}):/.exec(message);
  return m ? Number(m[1]) : undefined;
}

function isRetryableFailure(error, externalSignal) {
  if (externalSignal?.aborted) return false; // caller cancellation is final
  if (error instanceof TypeError && /fetch/.test(error?.message ?? '')) return true;
  const status = statusFromMessage(error?.message ?? '');
  return status === 429 || (status !== undefined && status >= 500);
}

function delayOf(error, attempt, random) {
  const status = statusFromMessage(error?.message ?? '');
  if (status === 429) return backoffDelay(attempt + 1, random);
  return backoffDelay(attempt, random);
}

/**
 * Create the wrapped adapter.
 *
 * @param options - `api`: 'openai' (default) | 'anthropic'; `fetchImpl`:
 *   injectable fetch for tests; `random`: backoff jitter source (tests).
 */
export function createWrappedAdapter(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const random = options.random ?? Math.random;
  const structuredDefault = options.structured === true;
  const api = options.api === 'anthropic' ? 'anthropic' : 'openai';
  const AdapterClass = api === 'anthropic' ? AnthropicAdapter : OpenAICompatibleAdapter;

  return {
    /** Model-family modality probe, straight from the engine adapter. */
    supportsImages(model) {
      return new AdapterClass().supportsImages(model);
    },

    /**
     * One wrapped VLM call.
     * @param messages - engine VisionMessages.
     * @param call - { model, apiKey?, baseURL?, timeoutMs?, maxTokens?,
     *   structured?, signal? }.
     */
    async call(messages, call = {}) {
      const external = call.signal;
      let lastError;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Per-call adapter instance: its fetch closure binds THIS call's
        // external signal (per-call binding; shared instances would race).
        const adapter = new AdapterClass({
          fetch: (url, init = {}) => {
            const merged = external ? AbortSignal.any([init.signal, external].filter(Boolean)) : init.signal;
            return fetchImpl(url, { ...init, signal: merged });
          },
        });
        const structured = call.structured ?? structuredDefault;
        const maxTokens = structured
          ? Math.max(2048, call.maxTokens ?? 2048)
          : call.maxTokens;
        try {
          const text = await adapter.call(messages, {
            model: call.model,
            apiKey: call.apiKey,
            baseURL: call.baseURL,
            timeoutMs: call.timeoutMs,
            maxTokens,
          });
          if (!text || text.trim() === '') {
            throw new EmptyResponseError();
          }
          return text;
        } catch (error) {
          lastError = error;
          if (external?.aborted) {
            const reason = getAbortReason(external);
            throw reason ?? error;
          }
          if (error instanceof EmptyResponseError) throw error; // fail, never retry-then-cache
          const more = attempt < MAX_RETRIES && isRetryableFailure(error, external);
          if (!more) throw error;
          await sleep(delayOf(error, attempt, random), external);
        }
      }
      throw lastError;
    },
  };
}

/** Marker type: an empty (blank) VLM response — treated as a failure by the
 * caller so it is never cached or injected (design §5.6). */
export class EmptyResponseError extends Error {
  constructor() {
    super('vision bridge: vision model returned an empty response');
    this.name = 'EmptyResponseError';
  }
}
