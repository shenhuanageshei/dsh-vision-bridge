/**
 * Settings-face compatibility for DSH 0.1.6 / 0.1.7 (design §4-A/B/C).
 *
 * 0.1.6 hands a settings section back through `ctx.settings.register(...)`: the
 * handle exposes `.get()` / `.watch()`. 0.1.7 dropped that method; the editable
 * parts of the schema are declared volatile instead, and the only live values
 * are the references embedded in the config `apply(ctx, config)` receives — the
 * loader updates them in place and re-emits
 * (`cordis-plugin-loader/lib/index.js:393-425`).
 *
 * This module owns that second face — dispatch, reading, change propagation and
 * the validation interception point — so callers keep one downstream path for
 * both generations. No runtime dependency is added: the reference protocol is
 * recognised by duck type, never by importing its package (class identity is
 * not stable across ESM/CJS copies of cosmokit).
 *
 * Nothing here may throw into `apply()`: a misbehaving settings face has to
 * degrade to a visible warning, never to a dead plugin.
 *
 * @module @dsh-external/dsh-vision-bridge/settings-compat
 */

/** A settings reference: any `{ get() }` object (cosmokit's frozen volatile
 * reference). Detected structurally on purpose — the class identity differs
 * between copies of the defining package. */
const isRef = (node) => typeof node?.get === 'function';

/** Log line for a kernel that hands over no volatile reference at all: an
 * ambiguous state ("no reference" also means "config was not schema-resolved",
 * design §2.1-9) that must not pass silently. */
export const NO_VOLATILE_REFS_WARN = 'vision-bridge: this kernel handed the plugin no volatile settings reference — the settings surface is inert (live edits will not reach the running plugin; restart to apply)';

/** Log line for a reference whose `get()` throws: reads keep serving the last
 * good generation and every later read reports the failure again. */
export const REF_READ_FAILED_WARN = 'vision-bridge: a volatile settings reference could not be read — keeping the previous configuration';

function warn(logger, message, cause) {
  logger?.warn?.(cause === undefined ? message : message + ' (' + (cause?.message ?? cause) + ')');
}

/**
 * Read live effective values out of an `apply()` config: every volatile
 * reference is replaced by its current snapshot, every other value passes
 * through untouched. Recomputed per call, never cached — the loader updates
 * references in place, so a cached copy would freeze the first generation.
 *
 * @param config - the (possibly reference-bearing) config object.
 * @returns `{ value, refs, error }`: `refs` counts the references seen (0 on a
 *   kernel without the volatile face); `error` carries the first failing
 *   getter, whose node reads as `undefined` instead of throwing.
 */
function readSection(config) {
  let refs = 0;
  let error;
  const visit = (node) => {
    if (isRef(node)) {
      refs += 1;
      try {
        return visit(node.get());
      } catch (cause) {
        error ??= cause;
        return undefined;
      }
    }
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(visit);
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
  };
  return { value: visit(config), refs, error };
}

/**
 * Effective values of one config object — the 0.1.7 counterpart of the 0.1.6
 * handle's `.get()`, shaped exactly like a settings section so the existing
 * `resolveConfig(…)` path serves both generations unchanged.
 *
 * @param config - the config object `apply()` received.
 * @returns the config with every volatile reference replaced by its snapshot.
 */
export function snapshotOf(config) {
  return readSection(config).value;
}

/**
 * 0.1.6 keeps `settings.register`; 0.1.7 dropped it. The probe asks for the
 * capability, never for a host version (a version string is not a contract) and
 * never for the presence of references (ambiguous, design §2.1-9).
 *
 * @param ctx - plugin context.
 * @returns true when the legacy register/handle face is available.
 */
export function usesLegacySettings(ctx) {
  return typeof ctx?.settings?.register === 'function';
}

/**
 * Read another plugin's settings namespace (design §2.1-18): 0.1.6 exposes
 * `settings.get(ns)`; 0.1.7 dropped it together with `register` and lists the
 * active entries through `describe()` instead, whose descriptor rows carry both
 * the namespace and its value (volatile nodes already unwrapped).
 *
 * A namespace missing from the table — not running, or no volatile shape — is a
 * legitimate state, not an error: this returns `undefined` and consumers keep
 * their existing fallbacks (empty provider projection, deferred first-run
 * freeze).
 *
 * @param ctx - plugin context.
 * @param legacy - the `usesLegacySettings` verdict: one dispatch is produced
 *   once and consumed both here and by the settings-face assembly.
 * @param ns - namespace to read.
 * @param logger - optional logger for the degraded paths.
 * @returns the namespace value, or `undefined` when it is not available.
 */
export function readSettingsNamespace(ctx, legacy, ns, logger) {
  if (legacy) return ctx.settings.get(ns);
  let rows;
  try {
    rows = ctx.settings.describe();
  } catch (error) {
    warn(logger, 'vision-bridge: settings.describe() failed while reading namespace "' + ns + '" — treating it as unavailable', error);
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  return rows.find((row) => row?.ns === ns)?.value;
}

/**
 * 0.1.7 settings-face assembly: the stand-in for the 0.1.6 register handle
 * (design §4-C).
 *
 * - `get()` recomputes the effective section on every call, so the runtime can
 *   read live values exactly like it does through the legacy handle;
 * - `watch(cb)` fires after the loader committed a volatile update of THIS
 *   fiber's config, with the same whole-section argument the legacy handle
 *   passes;
 * - `internal/config` is registered as the validation interception point — the
 *   only place the loader consults before committing, so a rejected candidate
 *   throws, the loader warns, and the references keep their previous values;
 * - a config that carries no reference at all gets one visible warning.
 *
 * @param ctx - the context `apply()` received (identity-compared in the guard).
 * @param config - the config `apply()` received (volatile references inside).
 * @param [options] - `logger` for the degraded paths; `validate` runs on this
 *   fiber's config candidates and throws to refuse them.
 * @returns `{ get, watch }` — shape-compatible with the legacy settings handle.
 */
export function installVolatileSettings(ctx, config, options = {}) {
  const { logger, validate } = options;
  const first = readSection(config);
  if (first.refs === 0) warn(logger, NO_VOLATILE_REFS_WARN);
  if (first.error) warn(logger, REF_READ_FAILED_WARN, first.error);

  // Waterfall `(this: Fiber, config, next)` (cordis lib/types/events.d.ts:226),
  // dispatched with the resolving fiber as `this` — the same fiber whose ctx is
  // the one apply() received. Every fiber's resolution reaches this listener, so
  // the guard lets foreign candidates through untouched; a throw from validate
  // is caught by the loader, which then warns and keeps the previous reference
  // values (refuse-and-keep-old, design §2.1-7).
  ctx.on('internal/config', function (raw, next) {
    if (this?.ctx !== ctx) return next();
    validate?.(raw);
    return next();
  });

  return {
    get: () => readSection(config).value,
    watch(onChange) {
      // The loader scopes the emit to the fiber whose references changed, so
      // every delivery concerns us and the changed paths need no matching
      // (cordis-plugin-loader/lib/index.js:411-419).
      return ctx.on('loader/volatile-update', () => {
        const next = readSection(config);
        if (next.error) {
          warn(logger, REF_READ_FAILED_WARN, next.error);
          return;
        }
        onChange(next.value);
      });
    },
  };
}
