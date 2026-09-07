/**
 * Plugin configuration: settings namespace schema, resolution, and validation.
 *
 * Secrets never live here — `credential` is a DSH CredentialRef (an
 * environment-variable-style name) resolved per operation through
 * `ctx.credentials.resolve`; this module never reads `process.env`.
 *
 * The provider endpoint defaults are NOT read live from another plugin's
 * namespace: on first run the launcher copies the vision-toolkit provider
 * values once into a local frozen defaults file (see `loadProviderDefaults`
 * callers in lib/index.js), and from then on only this plugin's frozen copy is
 * consulted (design §5.7 — schema-drift isolation).
 *
 * @module @dsh-external/dsh-vision-bridge/config
 */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

/** Settings document namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = 'vision-bridge';

/** Baked-in last-resort provider defaults (the vision-toolkit schema defaults
 * at the time this plugin shipped). Used only when neither the user section nor
 * the frozen first-run copy provides a value. */
export const BAKED_PROVIDER_DEFAULTS = Object.freeze({
  baseURL: 'https://api.inferera.com/v1',
  model: 'gemini-3.6-flash',
});

/** Prompts/schema contract version of the engine library — part of the cache
 * configuration fingerprint so a library prompt change naturally invalidates
 * persisted notes (design §5.5). */
export const ENGINE_PROMPT_VERSION = 'vision-bridge-prompts-v1';

/** Configuration schema with the documented defaults (design §5.7). The web
 * settings page renders from this schema automatically. */
export const Config = z.object({
  /** tool: model-invoked tool only. auto: pre-step injection only. both: default. */
  mode: z.union(['tool', 'auto', 'both']).default('both'),
  provider: z.object({
    /** OpenAI-compatible chat/completions base URL. Empty = use the frozen
     * first-run default copied from vision-toolkit (or the baked fallback). */
    baseURL: z.string().default(''),
    /** Multimodal model name. Empty = frozen default, as above. */
    model: z.string().default(''),
  }),
  /** DSH CredentialRef holding the API key; shares the toolkit's default
   * entry name so one stored credential serves both plugins. */
  credential: z.string().default('VISION_API_KEY'),
  /** Single VLM call budget in milliseconds. */
  timeoutMs: z.number().default(60000),
  /** In-flight VLM call cap. */
  concurrency: z.number().default(2),
  cache: z.object({
    maxEntries: z.number().default(256),
    /** Persist directory for per-namespace note caches. Empty =
     * <DSH home>/vision-bridge/cache. */
    persistDir: z.string().default(''),
  }),
  maxImageBytes: z.number().default(10485760),
  maxImagePixels: z.number().default(40000000),
  visionCapabilities: z.object({
    /** auto = basic note mode (no grounding prompt). The named formats select
     * the engine's structured grounding prompt for that model family. */
    outputFormat: z.union(['auto', 'hanako', 'gemini', 'qwen', 'anchor']).default('auto'),
  }),
  /** Vision answer language; appended as a directive to the engine request and
   * part of the cache fingerprint. */
  language: z.union(['zh', 'en']).default('zh'),
  /** Extra instructions for the VLM read, appended after the language
   * directive in every engine request (tool and auto share the same assembly
   * point in lib/index.js). Trimmed on resolution; empty = no extra
   * instructions (byte-identical request, design §10.3). Part of the cache
   * fingerprint. */
  promptExtra: z.string().default(''),
  autoMode: z.object({
    /** Maximum images analyzed automatically per user/message event. */
    maxPerTurn: z.number().default(3),
  }),
});

const MAX_TIMEOUT_MS = 600000;
const MIN_TIMEOUT_MS = 1000;
const MAX_IMAGE_BYTES = 268435456;
const MAX_IMAGE_PIXELS = 268435456;
const MAX_CONCURRENCY = 16;
const MAX_CACHE_ENTRIES = 65536;
const MAX_PER_TURN = 16;
const MAX_PROMPT_EXTRA_CHARS = 2000;

/** An unpaired UTF-16 surrogate (a high not followed by a low, or a low not
 * preceded by a high) is not valid text; it would corrupt the engine prompt
 * and the persisted cache keys (design §10.6: lone surrogates are rejected). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Structured grounding capability presets per configured outputFormat
 * ('auto' resolves to null = the engine's basic note prompt). */
const OUTPUT_FORMAT_CAPABILITIES = Object.freeze({
  hanako: Object.freeze({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'hanako', groundingMode: 'native' }),
  gemini: Object.freeze({ boxes: true, points: false, boxOrder: 'yxyx', outputFormat: 'gemini', groundingMode: 'native' }),
  qwen: Object.freeze({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'qwen', groundingMode: 'native' }),
  anchor: Object.freeze({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted' }),
});

/**
 * Validate and fully resolve a config object. Configuration mistakes fail loud
 * at plugin load (the earliest resolvable point); a live update that fails this
 * function is refused by the settings service and the previous generation keeps
 * serving (design §5.7, toolkit pattern).
 *
 * @param config - parsed config (schema defaults applied by schemastery).
 * @param options - `providerDefaults`: frozen first-run defaults
 *   `{ baseURL, model }`; `persistDirFallback`: absolute default cache
 *   directory when the user leaves `cache.persistDir` empty.
 * @returns the fully resolved, validated configuration.
 */
export function resolveConfig(config = {}, options = {}) {
  const provider = config.provider ?? {};
  const frozen = options.providerDefaults ?? BAKED_PROVIDER_DEFAULTS;

  const baseURL = String(provider.baseURL ?? '').trim() || String(frozen.baseURL ?? '').trim();
  if (!/^https?:\/\//i.test(baseURL) || baseURL.length <= 'https://'.length) {
    throw new TypeError('vision-bridge: provider.baseURL must be an http(s) URL');
  }

  const model = String(provider.model ?? '').trim() || String(frozen.model ?? '').trim();
  if (!model) throw new TypeError('vision-bridge: provider.model must not be empty');

  let credential;
  try {
    credential = credentialRef(String(config.credential ?? 'VISION_API_KEY').trim());
  } catch (error) {
    throw new TypeError(`vision-bridge: credential "${config.credential}" is not a valid credential reference`, { cause: error });
  }

  const timeoutMs = config.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`vision-bridge: timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }

  const concurrency = config.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new TypeError(`vision-bridge: concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }

  const cache = config.cache ?? {};
  const maxEntries = cache.maxEntries ?? 256;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_CACHE_ENTRIES) {
    throw new TypeError(`vision-bridge: cache.maxEntries must be an integer between 1 and ${MAX_CACHE_ENTRIES}`);
  }
  const persistDir = String(cache.persistDir ?? '').trim() || options.persistDirFallback || '';
  if (!persistDir) throw new TypeError('vision-bridge: cache.persistDir must not be empty');

  const maxImageBytes = config.maxImageBytes ?? 10485760;
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1024 || maxImageBytes > MAX_IMAGE_BYTES) {
    throw new TypeError(`vision-bridge: maxImageBytes must be an integer between 1024 and ${MAX_IMAGE_BYTES}`);
  }
  const maxImagePixels = config.maxImagePixels ?? 40000000;
  if (!Number.isInteger(maxImagePixels) || maxImagePixels < 1 || maxImagePixels > MAX_IMAGE_PIXELS) {
    throw new TypeError(`vision-bridge: maxImagePixels must be an integer between 1 and ${MAX_IMAGE_PIXELS}`);
  }

  const outputFormat = config.visionCapabilities?.outputFormat ?? 'auto';
  const language = config.language ?? 'zh';
  const maxPerTurn = config.autoMode?.maxPerTurn ?? 3;
  if (!Number.isInteger(maxPerTurn) || maxPerTurn < 1 || maxPerTurn > MAX_PER_TURN) {
    throw new TypeError(`vision-bridge: autoMode.maxPerTurn must be an integer between 1 and ${MAX_PER_TURN}`);
  }

  const promptExtra = String(config.promptExtra ?? '').trim();
  if (LONE_SURROGATE_RE.test(promptExtra)) {
    throw new TypeError('vision-bridge: promptExtra contains an invalid UTF-16 lone surrogate');
  }
  if (promptExtra.length > MAX_PROMPT_EXTRA_CHARS) {
    throw new TypeError(`vision-bridge: promptExtra must be at most ${MAX_PROMPT_EXTRA_CHARS} characters after trimming`);
  }

  const mode = config.mode ?? 'both';
  if (mode !== 'tool' && mode !== 'auto' && mode !== 'both') {
    throw new TypeError('vision-bridge: mode must be "tool", "auto" or "both"');
  }

  return {
    mode,
    provider: { baseURL, model, credential },
    timeoutMs,
    concurrency,
    cache: { maxEntries, persistDir },
    maxImageBytes,
    maxImagePixels,
    /** null = engine basic note mode; object = structured grounding preset. */
    visionCapabilities: OUTPUT_FORMAT_CAPABILITIES[outputFormat] ?? null,
    outputFormat,
    language,
    promptExtra,
    autoMode: { maxPerTurn },
  };
}

/**
 * Build the cache configuration fingerprint (design §5.5, §10.3): endpoint +
 * model + language + output format + promptExtra + engine prompt/schema
 * version. Any change produces a new fingerprint, so persisted notes miss
 * naturally and age out via LRU. An absent promptExtra fingerprints identically
 * to an empty one (the empty value must not drift the cache keys).
 */
export function configFingerprint(resolved, sha256) {
  const h = sha256 ?? ((s) => s);
  return h([
    resolved.provider.baseURL,
    resolved.provider.model,
    resolved.language,
    resolved.outputFormat,
    resolved.promptExtra ?? '',
    ENGINE_PROMPT_VERSION,
  ].join('\u0000'));
}
