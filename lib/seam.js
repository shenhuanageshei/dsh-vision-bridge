/**
 * Runtime service seam (design v4.1, docs/design-v4-runtime-seam.md §4.2).
 *
 * DSH decides "can this model receive images?" on two independent paths:
 * the ADMISSION gates ask the in-process service method
 * `llm.resolveModelInfo(provider, model)` (session controller prompt, subagent
 * assertImageCapable, ACP assertImageRoute), while the PROJECTION path
 * (`adapter.prepareCall().model` → `LlmRuntime.adapterStream`) never calls it.
 * Decorating the service method therefore lets a text-only model's image
 * prompt through admission while the runtime still replaces the image with the
 * standard `[image omitted …]` placeholder — which is exactly what this plugin
 * bridges.
 *
 * Hard invariants (all reviewed, see docs/review-design-v4.md B1/B2 and
 * docs/review-design-v4-r2.md N11):
 * - everything is read/written on the REAL service instance
 *   (`Symbol.for('cordis.original')`): `ctx.llm` / `ctx.get('llm')` hand out a
 *   fresh traceable proxy per read and a fresh shadow-method proxy per method
 *   read, so `llm.resolveModelInfo === wrapped` can never hold;
 * - the shadow own-property is created with `Object.defineProperty(…,
 *   { writable: true, configurable: true, enumerable: false })` so it keeps the
 *   prototype method's enumerability (N11a);
 * - restore is a `delete` (own property disappears, the prototype method shows
 *   through again) and clears the marker, so a stop→start cycle re-installs
 *   instead of reporting a false `already` (B1/B2);
 * - `already` is decided by BEHAVIOR (our wrapped layer is still the outermost
 *   one), never by the mere presence of the marker.
 *
 * @module @dsh-external/dsh-vision-bridge/seam
 */

/** Marker on the real service instance; namespaced by package name (N10). */
export const SEAM_MARK = Symbol.for('@dsh-external/dsh-vision-bridge/seam');

/** cordis' own "this proxy really wraps that instance" symbol (cordis 4.0.4). */
export const CORDIS_ORIGINAL = Symbol.for('cordis.original');

const DEFAULT_INCLUDE = () => true;
const DEFAULT_REQUIRE_READER = () => true;

/** Human-readable route label used in the log lines. */
export function routeLabel(provider, model) {
  return String(provider ?? '?') + ':' + String(model ?? '?');
}

/**
 * The real service instance behind any cordis traceable proxy (§4.2: every
 * read and write goes through this).
 * @param llm - a cordis service accessor (`ctx.llm`, `ctx.get('llm')`) or the
 *   raw instance itself.
 * @returns the object that actually owns `resolveModelInfo`.
 */
export function seamTarget(llm) {
  const raw = llm?.[CORDIS_ORIGINAL];
  return raw === undefined || raw === null ? llm : raw;
}

/** The marker object recorded on the real instance, if any. */
export function seamMarker(llm) {
  const raw = seamTarget(llm);
  return raw === null || typeof raw !== 'object' ? undefined : raw[SEAM_MARK];
}

/**
 * Behavioral self-proof (B2): our layer is installed when the instance's
 * CURRENT `resolveModelInfo` IS the function we stored in the marker. A marker
 * without that identity is residue (restore half-done, or another plugin's
 * decoration on top) and must NOT read as "installed".
 */
export function seamInstalled(llm) {
  const raw = seamTarget(llm);
  if (raw === null || typeof raw !== 'object') return false;
  const marker = raw[SEAM_MARK];
  return Boolean(marker) && marker.wrapped === raw.resolveModelInfo;
}

/** Normalize a predicate's answer: boolean, or `{ allowed, reason }`. */
function verdictOf(value, fallbackReason) {
  if (value === undefined || value === null) return { allowed: true, reason: undefined };
  if (typeof value === 'object') {
    return {
      allowed: value.allowed !== false,
      reason: typeof value.reason === 'string' && value.reason !== '' ? value.reason : fallbackReason,
    };
  }
  return { allowed: value !== false, reason: fallbackReason };
}

/**
 * Install the seam on one llm service instance.
 *
 * @param llm - cordis service accessor or the real instance.
 * @param {object} [options]
 * @param {(provider: string, model: string, info: object) => boolean} [options.include]
 *   Call-time route predicate; false leaves that route exactly as the adapter
 *   reported it (§4.3 whitelist). Defaults to "every route".
 * @param {(provider: string, model: string, info: object) => (boolean|{allowed: boolean, reason?: string}|Promise)} [options.requireReader]
 *   Call-time predicate for the reader precondition (§4.5 B5 / N11b): it is
 *   evaluated inside the wrapper on EVERY call, never snapshotted at install
 *   time, so a live configuration change takes effect without reinstalling.
 *   A falsy verdict keeps the hard rejection (the image never gets an
 *   "admitted but unread" success).
 * @param {object} [options.logger] - anything with optional info/warn/error.
 * @returns {{status: 'installed'|'already'|'unsupported', restore?: Function}}
 *   `restore()` returns true when our layer was removed, false when another
 *   decoration sits on top (we never break it, R5) and is idempotent.
 */
export function installSeam(llm, options = {}) {
  const {
    include = DEFAULT_INCLUDE,
    requireReader = DEFAULT_REQUIRE_READER,
    logger,
  } = options;

  const raw = seamTarget(llm);
  if (raw === null || raw === undefined || typeof raw.resolveModelInfo !== 'function') {
    // Warn, not error: the CALLER knows whether the host is simply without an
    // llm registry (legitimate) or the service exists and lost the method
    // (R1 — a kernel rename), and escalates the latter to error (§4.5-1).
    logger?.warn?.('vision-bridge seam: llm service unavailable or has no resolveModelInfo; image admission is unchanged');
    return { status: 'unsupported' };
  }

  const marker = raw[SEAM_MARK];
  if (marker !== undefined && marker.wrapped === raw.resolveModelInfo) {
    // Behavior self-proof passed: our layer is still the outermost one.
    return { status: 'already', restore: marker.restore };
  }

  const original = raw.resolveModelInfo;
  // §4.2 uses `delete` because resolveModelInfo is a PROTOTYPE method; remember
  // an own property (some deployment could ship one) so restore is lossless.
  const ownDescriptor = Object.hasOwn(raw, 'resolveModelInfo')
    ? Object.getOwnPropertyDescriptor(raw, 'resolveModelInfo')
    : undefined;

  async function inject(info, provider, model) {
    if (info === null || typeof info !== 'object') return info;
    if (!include(provider, model, info)) return info;
    if (info.inputModalities === undefined) return info; // undeclared = not gated; keep byte-identical
    if (!Array.isArray(info.inputModalities) || info.inputModalities.includes('image')) return info;
    const verdict = verdictOf(
      await requireReader(provider, model, info),
      'reader-unavailable',
    );
    if (!verdict.allowed) {
      // B5: never manufacture a "sent successfully, nobody read it" path — the
      // hard rejection stays, and the reason is said out loud.
      logger?.warn?.('vision-bridge seam: not injecting image capability for ' + routeLabel(provider, model)
        + ' (' + (verdict.reason ?? 'reader-unavailable') + '); the admission gate keeps rejecting image prompts');
      return info;
    }
    return { ...info, inputModalities: [...info.inputModalities, 'image'] };
  }

  const wrapped = async function resolveModelInfoSeam(provider, model, signal) {
    const info = await original.call(this, provider, model, signal);
    try {
      return await inject(info, provider, model);
    } catch (error) {
      // Our own predicate bugs must never break the host's model lookup: fall
      // back to the adapter's answer (no injection = fail closed).
      logger?.error?.('vision-bridge seam: capability injection failed for ' + routeLabel(provider, model)
        + ' (' + (error?.message ?? error) + '); the adapter answer stands');
      return info;
    }
  };

  const restore = () => {
    // Only when our layer is still the outermost one (B1: decided on the REAL
    // instance). Another plugin's decoration on top is left untouched (R5).
    if (raw.resolveModelInfo !== wrapped) return false;
    if (ownDescriptor !== undefined) Object.defineProperty(raw, 'resolveModelInfo', ownDescriptor);
    else delete raw.resolveModelInfo;
    delete raw[SEAM_MARK];
    return true;
  };

  // N11a: the prototype method is non-enumerable; a plain assignment through
  // cordis' set trap would create an ENUMERABLE own property instead.
  // N-I3: a frozen / non-extensible service instance must degrade to the
  // documented three-state contract instead of throwing the whole plugin load
  // away — nothing is installed, so a retry stays possible.
  try {
    Object.defineProperty(raw, 'resolveModelInfo', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (error) {
    logger?.warn?.('vision-bridge seam: the llm instance is not extensible, so the decoration was refused ('
      + (error?.message ?? error) + '); image admission is unchanged');
    return { status: 'unsupported' };
  }
  raw[SEAM_MARK] = { wrapped, restore, original };
  logger?.info?.('vision-bridge seam: installed on llm.resolveModelInfo (image capability injection active)');
  return { status: 'installed', restore };
}

/**
 * Resolve a route's model info WITHOUT this plugin's injection.
 *
 * auto mode must know whether the SESSION model really accepts images
 * (design §5.4 round-3 modality gate). Reading the decorated method would
 * answer "images are fine" for exactly the text-only models the seam targets,
 * and auto mode would then skip the read — the silent "nobody looked at the
 * screenshot" path §4.5/B5 forbids. This helper talks to the pre-seam layer.
 *
 * @param llm - cordis service accessor or the real instance.
 * @param provider - provider id.
 * @param model - model id.
 * @param signal - optional abort signal.
 * @returns the adapter's `resolveModelInfo` answer, or undefined when the
 *   service is absent.
 */
export function resolveModelInfoUnseamed(llm, provider, model, signal) {
  const raw = seamTarget(llm);
  const marker = raw === null || typeof raw !== 'object' ? undefined : raw[SEAM_MARK];
  if (marker !== undefined && typeof marker.original === 'function') {
    return marker.original.call(raw, provider, model, signal);
  }
  const fn = llm?.resolveModelInfo;
  if (typeof fn !== 'function') return undefined;
  return fn.call(llm, provider, model, signal);
}
