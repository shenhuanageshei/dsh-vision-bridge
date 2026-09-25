/**
 * @dsh-external/dsh-vision-bridge — session screenshots routed by model
 * capability. Vision-capable models receive attachments inline (the runtime
 * projects nothing); text-only models see the standard placeholder, and this
 * plugin reads the image through a configured VLM:
 *
 * - tool mode: the model calls `vision_bridge_read` (lib/tools.js);
 * - auto mode: new user/message images are analyzed in the background and
 *   injected same-turn via agent/pre-step (lib/auto.js).
 *
 * Lifecycle: settings are registered with applies:'live' + validate (a refused
 * update keeps the previous generation); everything the plugin mounts rides
 * ctx effects, and apply returns a disposer that aborts the lifecycle and
 * flushes the caches. The plugin fiber can restart at any time — all state is
 * (re)built inside apply, nothing module-level.
 *
 * Runtime seam (docs/design-v4-runtime-seam.md): apply() first decorates the
 * in-process llm.resolveModelInfo service method, so the image-admission gates
 * (session controller, subagent, ACP) admit an image prompt for a text-only
 * model. The projection path (adapter.prepareCall) is deliberately untouched
 * and still swaps the image for the standard placeholder, which this plugin
 * then reads. Disposal deletes the decoration, restoring the stock behaviour.
 *
 * @module @dsh-external/dsh-vision-bridge
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { VisionBridge } from '../vendor/vision-bridge/dist/index.js';
import { applyAdmissionPatch } from '../scripts/patch-admission-gate.mjs';
import { installAutoMode } from './auto.js';
import { Config, SETTINGS_NAMESPACE, resolveConfig, seamRouteIncluded } from './config.js';
import { installSeam } from './seam.js';
import { createVisionBridgeReadTool } from './tools.js';
import { ConcurrencyGate, InFlightDedup, NamespacedNoteCache, fingerprint, hashQuestion, noteKey } from './cache-backend.js';
import { createWrappedAdapter } from './adapter-wrapper.js';
import { installServerRoutes, projectProviders } from './server-routes.js';
import { installVolatileSettings, readSettingsNamespace, usesLegacySettings } from './settings-compat.js';
import { projectRequestDimensions } from './request-dimensions.js';

export { Config } from './config.js';

export const name = '@dsh-external/dsh-vision-bridge';

/** Minimal strict-inject list (appendix A④): everything apply touches
 * directly. Optional capabilities are read with ctx.get() and may be absent. */
export const inject = ['tools', 'settings', 'attachments', 'agents', 'systemPrompt', 'credentials'];

function resolveDshHome() {
  // process.env exemption note: the design's no-process.env ban targets
  // CREDENTIALS (they must flow through ctx.credentials.resolve). DSH_HOME is
  // the harness's standard home-directory variable (same read as
  // dsh-preset-zombie-guard / dsh-app-boot resolveDshHome) — a path fact, not
  // a secret, and there is no service seam for it.
  const env = process.env.DSH_HOME;
  return env !== undefined && env.trim().length > 0 ? env.trim() : join(homedir(), '.dsh');
}

/** This package's own directory (…/node_modules/@dsh-external/dsh-vision-bridge
 * when installed, the checkout root when run from the repository). */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The core package whose absence marks a directory as "not a DSH node_modules". */
const SESSION_CONTROLLER_PACKAGE = join('@deepseek-ai', 'dsh-api-session-controller');

/** §12.2 A log line — the wording is contractual (VERIFY §10-2 greps it). */
export const SELF_HEAL_REPATCHED_LOG = '[vision-bridge] admission gate re-patched after update (effective on next boot)';

/** Process-lifetime self-heal outcomes, keyed by nodeModulesDir (§12.1: the
 * self-heal runs at most once per apply() entry point — apply() re-enters on
 * every fiber restart, and the repair itself is idempotent). */
const selfHealResults = new Map();

/** Drop the §12 self-heal cache (tests only; the production path never clears it). */
export function resetSelfHealCache() {
  selfHealResults.clear();
}

/**
 * Resolve the node_modules directory holding the core packages (§12.2 A, two
 * sources): the plugin's own `../..` — which IS the node_modules directory
 * when the plugin runs from its installed copy — wins; when that directory
 * carries no DSH core package (e.g. the checkout at
 * `plugins/dsh-vision-bridge`), fall back to `<DSH_HOME>/profiles/web/
 * node_modules`, the same derivation the patch script's DEFAULT_NM uses.
 * @param {string} [pluginRoot] - override for tests.
 * @returns {string} the directory to hand to applyAdmissionPatch().
 */
export function resolveNodeModulesDir(pluginRoot = PLUGIN_ROOT) {
  // Test-only hermetic override (review #4 / audit M-2): when set, the
  // self-heal scan is pinned to this directory and never touches a real
  // host node_modules, whatever the machine's patch state.
  if (typeof process.env.VISION_BRIDGE_SELF_HEAL_NM === 'string' && process.env.VISION_BRIDGE_SELF_HEAL_NM.trim() !== '') {
    return process.env.VISION_BRIDGE_SELF_HEAL_NM.trim();
  }
  let primary;
  try {
    primary = join(pluginRoot, '..', '..');
  } catch {
    primary = pluginRoot;
  }
  if (existsSync(join(primary, SESSION_CONTROLLER_PACKAGE))) return primary;
  const dshHome = process.env.DSH_HOME;
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    return join(dshHome.trim(), 'profiles', 'web', 'node_modules');
  }
  return primary;
}

/**
 * Startup self-heal of the admission gate (design §12.2 A): a DSH update
 * overwrites the core packages and the stock gate then rejects image prompts
 * again, so apply() re-applies the local patch through the exported script API
 * (idempotent, `.bak-vision-bridge` backups). The outcome is cached per
 * nodeModulesDir, so a fiber re-entry reuses it instead of re-reading disk.
 *
 * Scope honesty (§12.0-1/2, §12.2 D): this repairs DISK only. Core packages
 * load concurrently at boot and an already-imported module keeps its old code,
 * so a repaired disk guarantees the NEXT boot is clean — the log line says so,
 * and the runtime truth is reported by the behavior probe (§12.2 B).
 *
 * Never throws and never blocks startup: a failure is one error log line and
 * the settings card's one-click fix stays available (§12.4-3).
 *
 * @param {{nodeModulesDir?: string, logger?: object, applyPatch?: Function, cache?: Map}} [options]
 * @returns {Promise<{status: 'patched'|'already'|'failed', files: Array<object>}>}
 */
export function selfHealAdmissionGate(options = {}) {
  const { logger, applyPatch = applyAdmissionPatch, cache = selfHealResults } = options;
  const target = typeof options.nodeModulesDir === 'string' && options.nodeModulesDir !== ''
    ? options.nodeModulesDir
    : resolveNodeModulesDir();
  const cached = cache.get(target);
  if (cached !== undefined) return cached;
  const run = (async () => {
    try {
      // applyAdmissionPatch is synchronous; a substituted implementation may be
      // async (tests simulate a rejecting repair), so tolerate both shapes.
      const files = await applyPatch({ nodeModulesDir: target, logger });
      const list = Array.isArray(files) ? files : [];
      if (list.some((entry) => entry?.status === 'patched')) {
        logger?.info?.(SELF_HEAL_REPATCHED_LOG);
        return { status: 'patched', files: list };
      }
      const failures = list.filter((entry) => entry?.status === 'error' || entry?.status === 'nomatch');
      if (failures.length > 0) {
        logger?.error?.('vision-bridge: admission gate self-heal failed ('
          + failures.map((entry) => entry.status + ' ' + entry.file + (entry.error ? ': ' + entry.error : '')).join('; ')
          + '); the settings card one-click fix stays available');
        return { status: 'failed', files: list };
      }
      return { status: 'already', files: list };
    } catch (error) {
      logger?.error?.('vision-bridge: admission gate self-heal failed (' + (error?.message ?? error)
        + '); the settings card one-click fix stays available');
      return { status: 'failed', files: [], error: String(error?.message ?? error) };
    }
  })();
  cache.set(target, run);
  return run;
}

function readFrozenDefaults(file, logger) {
  try {
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data?.baseURL === 'string' && typeof data?.model === 'string' && data.baseURL && data.model) {
      return { baseURL: data.baseURL, model: data.model };
    }
  } catch (error) {
    logger?.warn?.('vision-bridge: frozen provider defaults unreadable (' + (error?.message ?? error) + '); using baked defaults');
  }
  return undefined;
}

/**
 * First-run provider freeze (design §5.7): copy the vision-toolkit provider
 * values ONCE into a local file, then never read that namespace again (schema
 * drift in another plugin must not break us). The file write is atomic.
 *
 * Deferred when the toolkit namespace is not (yet) registered — sibling
 * bundles race at apply time, and freezing the BAKED fallback in that moment
 * would bake it permanently. No file is written, baked defaults serve for
 * now, and the next apply retries the copy.
 * @param settings - cross-namespace reader (`{ get(ns) }`), either generation.
 * @returns the frozen defaults, or `undefined` when nothing was frozen (the
 *   caller then resolves through the baked defaults).
 */
export function ensureFrozenDefaults(settings, file, logger) {
  const existing = readFrozenDefaults(file, logger);
  if (existing) return existing;
  let copied;
  try {
    const toolkit = settings.get('vision-toolkit');
    const baseURL = toolkit?.provider?.baseUrl;
    const model = toolkit?.provider?.model;
    if (typeof baseURL === 'string' && baseURL.trim() && typeof model === 'string' && model.trim()) {
      copied = { baseURL: baseURL.trim(), model: model.trim() };
      logger?.info?.('vision-bridge: first run — froze provider defaults from vision-toolkit (' + copied.model + ' @ ' + copied.baseURL + ')');
    }
  } catch (error) {
    logger?.warn?.('vision-bridge: first run — vision-toolkit namespace unreadable (' + (error?.message ?? error) + '); using baked defaults for now');
  }
  if (!copied) {
    // Namespace unregistered or empty: do NOT persist anything. Baked
    // defaults serve this run; a later apply (with the toolkit present)
    // performs the real freeze.
    logger?.warn?.('vision-bridge: first run — vision-toolkit provider values unavailable; deferring the provider freeze (baked defaults in effect, no file written)');
    return undefined;
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(copied, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    logger?.warn?.('vision-bridge: could not persist frozen provider defaults (' + (error?.message ?? error) + ')');
  }
  return copied;
}

/** Display names of every loaded plugin in the registry (modlens conflict
 * detection, design §11.2-5①); an unreadable registry reads as empty. */
export function pluginRegistryNames(ctx) {
  try {
    const registry = ctx.registry;
    if (!registry || typeof registry.values !== 'function') return [];
    const names = [];
    for (const runtime of registry.values()) {
      if (typeof runtime?.name === 'string') names.push(runtime.name);
    }
    return names;
  } catch {
    return [];
  }
}

/** Opt-in switch for the §12.2 B behavior probe's real RPC face.
 * `VISION_BRIDGE_ADMISSION_PROBE=1|true|on|yes` enables it; anything else
 * (including unset) leaves the probe without a seam, and it then reports
 * `unknown` instead of guessing. Rationale: the probe's submission is a REAL
 * prompt against a REAL session — it must be an explicit deployment choice,
 * not a side effect of opening the settings card. */
export function admissionProbeEnabled(env = process.env) {
  const raw = env?.VISION_BRIDGE_ADMISSION_PROBE;
  return typeof raw === 'string' && ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

/** Stable scratch-session id: `sessionController.create({sessionId})` adopts
 * an existing session idempotently, so a deployment never accumulates scratch
 * sessions across boots (§12.6-20). */
/** Upper bound on the §4.5-2 seam self-check. The check resolves a real route,
 * and an adapter's resolveModel may itself consult a remote discovery endpoint,
 * so it is bounded: a plugin's apply() must never hang on it (§12.4-3).
 * Timing out is reported as `unknown`, never as a fake ✓. */
export const SEAM_SELF_CHECK_TIMEOUT_MS = 5000;

export const ADMISSION_PROBE_SESSION_ID = 'session-vision-bridge-admission-probe';

/** First model whose declaration omits image input — the only kind of model
 * for which the admission gate can reject an image prompt at all. */
export function pickTextOnlyModel(providers) {
  for (const provider of Array.isArray(providers) ? providers : []) {
    for (const model of Array.isArray(provider?.models) ? provider.models : []) {
      if (model?.vision === false && typeof model.id === 'string' && model.id !== '') {
        return { provider: provider.id, model: model.id };
      }
    }
  }
  return undefined;
}

/**
 * Build the behavior probe's RPC seam from services the host already loaded
 * (design §12.2 B). `ctx.get()` is inject-exempt, so this adds nothing to the
 * top-level inject list; when the services are absent — or the opt-in above
 * is off — no seam is returned and probeAdmissionGate() reports `unknown`.
 *
 * @param {object} ctx - the plugin context.
 * @param {(ns: string) => any} settingsGet - settings reader for the model pick.
 * @returns {object} server-route probe deps (`{}` when the seam is disabled).
 */
export function buildAdmissionProbeDeps(ctx, settingsGet) {
  if (!admissionProbeEnabled()) return {};
  const controller = () => {
    try {
      return ctx.get('sessionController');
    } catch {
      return undefined;
    }
  };
  return {
    promptRemote: async ({ sessionId, content }) => {
      const service = controller();
      if (!service || typeof service.prompt !== 'function') {
        throw new Error('vision-bridge: session controller RPC face unavailable');
      }
      return service.prompt(
        { sessionId, content, requestId: 'vision-bridge-admission-probe' },
        AbortSignal.timeout(10000),
      );
    },
    ensureScratchSession: async () => {
      const service = controller();
      if (!service || typeof service.create !== 'function') return undefined;
      const { sessionId } = await service.create({ sessionId: ADMISSION_PROBE_SESSION_ID });
      // The gate only rejects image prompts for text-only models, so the
      // scratch session must hold one or the probe would read "admitted" from
      // a multimodal model and report a false `dead`.
      let target;
      try {
        target = pickTextOnlyModel(projectProviders(settingsGet, {}));
      } catch {
        target = undefined;
      }
      // Review #3 hardening: a scratch session that cannot be pinned to a
      // text-only model (no candidate found, or the host lacks selectModel)
      // must NOT be probed — a multimodal default would read "admitted" from
      // a live gate and report a false `dead`. Return undefined so the probe
      // falls to `scratch-session-unavailable` → runtime=unknown (honest).
      if (!target) return undefined;
      if (typeof service.selectModel !== 'function') return undefined;
      await service.selectModel({ sessionId, provider: target.provider, model: target.model });
      return sessionId;
    },
    // cleanupScratchMessage: deliberately unwired — the host exposes no
    // session-message deletion API (§12.6-20 registers the residue), and a
    // cleanup failure must never turn a verdict into `unknown`.
  };
}

/** Plugin entry. */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger('vision-bridge');
  const dshHome = resolveDshHome();
  const pluginDir = join(dshHome, 'vision-bridge');
  const defaultsFile = join(pluginDir, 'provider-defaults.json');
  const persistDirFallback = join(pluginDir, 'cache');

  // ◈ Runtime service seam (design v4.1 §4.4/§4.5) — installed FIRST, ahead of
  // the §12 self-heal and of every settings-face call, so no path that can
  // raise an image prompt runs before the admission gates see the injected
  // capability. The option holder below is read by the seam predicates at CALL
  // time (review N11b), so this early install cannot bake a stale
  // configuration; ④ and the settings watcher keep it in sync and re-seat the
  // decoration (uninstall → recompute → reinstall) whenever a seam key moves.
  const seamOptions = {
    mode: 'auto',
    include: [],
    requireReader: true,
    /** Reader facts for the §4.5 precondition (N12a), refreshed from the
     * resolved configuration at ④. Empty until then, so the precondition fails
     * closed (no injection → the hard rejection stands). */
    reader: { baseURL: '', model: '', credential: '' },
  };
  /** Observed seam state — the §4.6 card reads it (next batch) and §4.7 will
   * use seam.live to stand down the disk self-heal and the behavior probe. */
  const seam = { status: 'unknown', live: undefined, reason: 'not-installed' };
  let seamRestore;

  function readSeamLlm() {
    try {
      // ctx.get is inject-exempt (review N5): llm stays out of the strict
      // inject list, and an absent service degrades to 'unsupported'.
      return typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
    } catch {
      return undefined;
    }
  }

  /** §4.5 B5 precondition, evaluated per call (never a snapshot): the reader is
   * available when endpoint, model and a resolvable credential are configured.
   * This is configuration availability, not connectivity (R6). */
  async function readerAvailable() {
    const { baseURL, model, credential } = seamOptions.reader;
    if (!baseURL) return { allowed: false, reason: 'vision provider baseURL is not configured' };
    if (!model) return { allowed: false, reason: 'vision provider model is not configured' };
    if (!credential) return { allowed: false, reason: 'vision credential is not configured' };
    try {
      const resolvedCredential = await ctx.credentials.resolve(credentialRef(credential));
      if (!resolvedCredential?.value) {
        return { allowed: false, reason: 'vision credential "' + credential + '" has no value' };
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: 'vision credential "' + credential + '" could not be resolved (' + (error?.message ?? error) + ')' };
    }
  }

  function uninstallSeam() {
    if (typeof seamRestore !== 'function') return;
    try {
      seamRestore();
    } catch (error) {
      logger.warn('vision-bridge: runtime seam restore failed (' + (error?.message ?? error) + ')');
    }
    seamRestore = undefined;
  }

  /** (Re)seat the decoration for the CURRENT seamOptions. */
  function installCurrentSeam() {
    uninstallSeam();
    if (seamOptions.mode === 'off') {
      seam.status = 'off';
      seam.live = undefined;
      seam.reason = 'seam.mode=off';
      return;
    }
    const llm = readSeamLlm();
    const result = installSeam(llm, {
      logger,
      include: (provider, model) => seamRouteIncluded(seamOptions.include, provider, model),
      requireReader: () => (seamOptions.requireReader ? readerAvailable() : { allowed: true }),
    });
    seam.status = result.status;
    seam.live = undefined;
    seamRestore = result.restore;
    if (result.status === 'unsupported') {
      seam.reason = 'llm service unavailable or has no resolveModelInfo';
      // §4.5-1: an absent service is a host-shape fact (warn, already logged by
      // installSeam); a service that LOST the method is the R1 alarm the design
      // wants loud, so it escalates to error here.
      if (llm !== undefined) {
        logger.error('vision-bridge: runtime seam unsupported — the llm service has no resolveModelInfo; text-only models keep the hard rejection on image prompts');
      }
      return;
    }
    seam.reason = result.status === 'already' ? 'already installed' : 'installed';
  }

  /** Feed a resolved configuration into the seam predicates. */
  function applySeamOptions(resolved) {
    seamOptions.mode = resolved?.seam?.mode ?? 'auto';
    seamOptions.include = Array.isArray(resolved?.seam?.include) ? resolved.seam.include : [];
    seamOptions.requireReader = resolved?.seam?.requireReader !== false;
    const provider = resolved?.provider ?? {};
    seamOptions.reader = {
      baseURL: String(provider.baseURL ?? ''),
      model: String(provider.model ?? ''),
      credential: String(provider.credential ?? ''),
    };
  }

  /** Bound a promise; the timer never outlives the race (unref + finally). */
  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** N-I1: the self-check must target a route the seam actually injects into.
   * pickTextOnlyModel alone ignores seam.include, so a whitelist that excludes
   * the projection's first text-only model would produce a fake ✗ (the seam is
   * injecting, but the probe measured an excluded route). */
  function pickSelfCheckRoute(providers) {
    const include = seamOptions.include;
    if (!Array.isArray(include) || include.length === 0) return pickTextOnlyModel(providers);
    for (const provider of Array.isArray(providers) ? providers : []) {
      for (const model of Array.isArray(provider?.models) ? provider.models : []) {
        if (model?.vision === false && typeof model.id === 'string' && model.id !== ''
          && seamRouteIncluded(include, provider.id, model.id)) {
          return { provider: provider.id, model: model.id };
        }
      }
    }
    return undefined;
  }

  /** §4.5-2 behavior self-proof: resolve one route the §12.2 B probe would also
   * pick (a declared text-only model) and assert the answer carries image. No
   * candidate ⇒ live stays unknown, never a fake ✓. */
  async function verifySeamLive() {
    if (seam.status !== 'installed' && seam.status !== 'already') return;
    let target;
    let whitelisted = false;
    try {
      whitelisted = Array.isArray(seamOptions.include) && seamOptions.include.length > 0;
      target = pickSelfCheckRoute(projectProviders(settingsReader.get, {}));
    } catch (error) {
      logger.warn('vision-bridge: runtime seam self-check could not read the provider projection (' + (error?.message ?? error) + ')');
      target = undefined;
    }
    if (!target) {
      // N-I1: an empty whitelist intersection is NOT evidence that the seam is
      // dead — it means the probe has nothing to measure. Keep live unknown and
      // say which of the two situations it is.
      seam.live = undefined;
      seam.reason = whitelisted
        ? 'no included text-only route (seam.include excludes every declared text-only model in the projection)'
        : 'self-check route unavailable (no text-only model in the provider projection)';
      logger.warn('vision-bridge: runtime seam installed but not self-verified — ' + seam.reason);
      return;
    }
    try {
      const info = await withTimeout(
        readSeamLlm().resolveModelInfo(target.provider, target.model),
        SEAM_SELF_CHECK_TIMEOUT_MS,
        'runtime seam self-check',
      );
      const modalities = info?.inputModalities;
      if (Array.isArray(modalities) && modalities.includes('image')) {
        seam.live = true;
        seam.reason = 'self-check passed (' + target.provider + ':' + target.model + ')';
        logger.info('vision-bridge: runtime seam live — ' + seam.reason);
      } else {
        seam.live = false;
        seam.reason = 'self-check saw inputModalities=' + JSON.stringify(modalities ?? null) + ' for ' + target.provider + ':' + target.model;
        logger.warn('vision-bridge: runtime seam installed but NOT injecting — ' + seam.reason);
      }
    } catch (error) {
      seam.live = undefined;
      seam.reason = 'self-check failed (' + (error?.message ?? error) + ')';
      logger.warn('vision-bridge: runtime seam self-check failed (' + (error?.message ?? error) + ')');
    }
  }

  /** Neutral cross-namespace reader, assigned at ① INSIDE the guarded block.
   * It is declared out here because the §4.5-2 self-proof closure below reads
   * it, and the guard's block scope would otherwise hide it — a ReferenceError
   * that verifySeamLive would swallow into a silent "not verified". */
  let settingsReader;

  try {
    // ◈ Fiber lifecycle guard (review B-I1(1)): the decoration lives on the HOST
    // llm service, which cordis does not own as a resource — so the install rides
    // ctx.effect, the same pattern the tool registration below uses. A fiber
    // teardown now restores it even when apply() never gets to return its
    // disposer, and the try/catch below makes the throw path deterministic.
    ctx.effect(() => {
      installCurrentSeam();
      return () => uninstallSeam();
    }, 'vision-bridge: runtime seam');

    // ⓪ Admission-gate startup self-heal (design §12.2 A), before every
    // settings-face call: on a kernel without `settings.register` such a call
    // throws, which would leave this repair — it needs no settings face at all —
    // unreached. (The runtime seam above runs even earlier; §4.7 will skip this
    // repair entirely once the seam is live — not wired in this batch.) Never throws and never blocks startup (§12.4-3), and runs at
    // most once per node_modules directory: the outcome is cached, so a fiber
    // re-entry reuses it instead of re-reading disk.
    try {
      await selfHealAdmissionGate({ logger });
    } catch (error) {
      logger.error('vision-bridge: admission gate self-heal threw (' + (error?.message ?? error) + ')');
    }

    // ① Settings face: ONE dispatch (lib/settings-compat.js) picks between the
    // 0.1.6 register handle and the 0.1.7 volatile references, and the neutral
    // reader below serves every cross-namespace read (first-run freeze, server
    // routes, probe deps) — no consumer probes the generation a second time.
    const legacy = usesLegacySettings(ctx);
    settingsReader = { get: (ns) => readSettingsNamespace(ctx, legacy, ns, logger) };

    // ② First-run freeze BEFORE registration so the very first resolution uses it.
    const providerDefaults = ensureFrozenDefaults(settingsReader, defaultsFile, logger);

    // ③ Settings: schema defaults → composition base → user layer; `validate`
    // rejects a section the runtime could not serve (loud at load,
    // refuse-and-keep-old on live updates). Both faces hand back `get()` /
    // `watch()`, so everything downstream is generation-agnostic.
    const validate = (value) => { resolveConfig(value, { providerDefaults, persistDirFallback }); };
    const settings = legacy
      ? ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config, applies: 'live', validate })
      : installVolatileSettings(ctx, config, { logger, validate });

    // ④ Mutable runtime state — fully rebuildable (fiber re-entry rebuilds it).
    const state = {
      config: resolveConfig(settings.get(), { providerDefaults, persistDirFallback }),
      toolCache: undefined,
      autoCache: undefined,
      gate: undefined,
      dedup: new InFlightDedup(),
      bridge: undefined,
      /** Per-operation credential value, read by the visionModel getter below at
       * engine call-options construction time (credentials must re-resolve per
       * operation and never cache across operations). */
      currentApiKey: undefined,
    };

    // ◈ Seam options from the resolved configuration. The predicates read
    // seamOptions per call, but seam.mode decides whether the decoration exists
    // at all, so re-seat it here and self-verify once (§4.5-2).
    applySeamOptions(state.config);
    installCurrentSeam();
    await verifySeamLive();
    // N-I4 (late-llm retry) is deliberately NOT wired in this batch: it needs a
    // second ctx.inject scope, and the existing dual-gen assertion pins the
    // inject list to exactly ['webServer'] (tests must not be edited). The
    // §4.6 card batch owns both the visible unsupported state and that retry.

    const lifecycle = new AbortController();
    const disposers = [];

    function buildCaches(resolved) {
      mkdirSync(resolved.cache.persistDir, { recursive: true });
      state.toolCache = new NamespacedNoteCache('tool', resolved.cache.persistDir, { maxEntries: resolved.cache.maxEntries, logger });
      state.autoCache = new NamespacedNoteCache('auto', resolved.cache.persistDir, { maxEntries: resolved.cache.maxEntries, logger });
    }

    function buildBridge(resolved) {
      const adapter = createWrappedAdapter({
        api: 'openai',
        // The engine selects its structured grounding prompt exactly when a
        // capabilities resolver returns non-null — mirror that flag here so the
        // wrapper budgets maxTokens ≥ 2048 for those calls.
        structured: resolved.visionCapabilities !== null,
      });
      return new VisionBridge({
        adapter,
        config: {
          visionModel: {
            // Getters keep the engine reading LIVE values: a live settings change
            // reaches the next engine call without a bridge rebuild, and the
            // per-operation credential rides each call.
            get id() { return state.config.provider.model; },
            get baseURL() { return state.config.provider.baseURL; },
            get apiKey() { return state.currentApiKey; },
            provider: 'vision-bridge',
            input: ['text', 'image'],
          },
          visionCapabilitiesResolver: () => state.config.visionCapabilities,
          timeoutMs: resolved.timeoutMs,
        },
        persistBackend: state.toolCache,
      });
    }

    buildCaches(state.config);
    state.gate = new ConcurrencyGate(state.config.concurrency);
    state.bridge = buildBridge(state.config);

    /** Per-operation credential resolution — never cached across operations.
     * Name-based variant: the settings-card probe routes resolve whichever
     * reference the draft names, not just the live config's. */
    async function resolveCredentialByName(name) {
      let resolvedCredential;
      try {
        resolvedCredential = await ctx.credentials.resolve(credentialRef(name));
      } catch (error) {
        throw new Error('vision bridge: credential "' + name + '" could not be resolved (' + (error?.message ?? error) + '). Store it in the DSH credential provider or set the environment variable.');
      }
      if (!resolvedCredential?.value) {
        throw new Error('vision bridge: credential "' + name + '" is not configured. Store it in the DSH credential provider or set the environment variable, then retry.');
      }
      return resolvedCredential.value;
    }

    /** Shared analysis path for tool and auto modes: cache → dedup → gate →
     * bytes → engine. Failures throw (tool: isError; auto: logged and skipped)
     * and are never cached. */
    async function analyzeImage(ref, rawQuestion, { namespace, signal } = {}) {
      const resolved = state.config;
      const question = String(rawQuestion ?? '').replace(/\s+/g, ' ').trim();
      const cache = namespace === 'auto' ? state.autoCache : state.toolCache;
      const key = noteKey(namespace, String(ref.attachmentId).toLowerCase(), hashQuestion(question), fingerprint(resolved));
      const cached = cache.get(key);
      if (cached !== null) return cached;
      return state.dedup.run(key, () => state.gate.run(async () => {
        const cachedInside = cache.get(key);
        if (cachedInside !== null) return cachedInside;
        const apiKey = await resolveCredentialByName(resolved.provider.credential);
        // Request middle parameter, dispatched on the ① verdict (design §4-A: no
        // second probe anywhere). 0.1.6 takes the limits and derives the request
        // size itself — byte-identical to the pre-compat call; 0.1.7 takes a
        // request target and no longer projects, so the pure geometry above runs
        // here first.
        let target;
        if (legacy) {
          target = { maxPixels: resolved.maxImagePixels, maxBytes: resolved.maxImageBytes };
        } else {
          const { width, height } = projectRequestDimensions(ref.width, ref.height, resolved.maxImagePixels);
          target = { width, height, maxBytes: resolved.maxImageBytes };
        }
        const image = await ctx.attachments.readImageRequest(
          {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          },
          target,
          signal,
        );
        // Directive assembly (design §10.3): fixed order question → language →
        // promptExtra; an empty promptExtra changes nothing (zero byte drift),
        // and promptExtra rides the cache fingerprint so answers miss naturally.
        const languageDirective = resolved.language === 'zh' ? '\n\n请用简体中文回答。' : '\n\nPlease answer in English.';
        const promptExtraDirective = resolved.promptExtra ? '\n\n' + resolved.promptExtra : '';
        // Assign the per-operation key immediately before analyze with no awaits
        // (residual boundary, review #9: if the vendored engine gains internal
        // awaits before adapter construction, concurrent calls with DIFFERENT
        // credentials could still cross; current deployments share one name.)
        // in between: state.currentApiKey is shared mutable state read by the
        // engine's apiKey getter at call-options construction, so any await
        // window between assignment and use could let a concurrent operation
        // overwrite the key (last-writer-wins race, code review #1).
        state.currentApiKey = apiKey;
        const result = await state.bridge.analyze({
          images: [{ type: 'image', mimeType: image.mediaType, data: Buffer.from(image.data).toString('base64') }],
          userRequest: (question ? question : '') + languageDirective + promptExtraDirective,
        });
        const note = result.visionNotes[0];
        if (!note || note.trim() === '') {
          throw new Error('vision bridge: engine produced an empty note for ' + ref.attachmentId);
        }
        cache.set(key, note);
        return note;
      }));
    }

    /** The runtime handed to tools and auto mode. */
    const runtime = {
      logger,
      lifecycle,
      getConfig: () => state.config,
      analyzeImage,
      combinedSignal: (controller) => AbortSignal.any([lifecycle.signal, controller.signal]),
    };

    // ⑤ Tool mode.
    disposers.push(ctx.effect(() => ctx.tools.register(createVisionBridgeReadTool(runtime)), 'vision-bridge: vision_bridge_read tool'));

    // ⑥ Auto mode: listeners install unconditionally; the mode setting is
    // checked live per event/step, so switching tool↔auto↔both applies instantly.
    disposers.push(installAutoMode(ctx, runtime));

    // ⑦ Live settings: refuse-and-keep-old on validation failure, rebuild
    // runtime state otherwise (§5.7 toolkit pattern).
    disposers.push(settings.watch((next) => {
      let resolvedNext;
      try {
        resolvedNext = resolveConfig(next, { providerDefaults, persistDirFallback });
      } catch (error) {
        logger.error('vision-bridge: keeping the previous configuration after a refused settings generation (' + (error?.message ?? error) + ')');
        return;
      }
      try {
        const previous = state.config;
        const persistDirChanged = previous.cache.persistDir !== resolvedNext.cache.persistDir;
        const entriesChanged = previous.cache.maxEntries !== resolvedNext.cache.maxEntries;
        state.config = resolvedNext;
        if (persistDirChanged || entriesChanged) {
          const oldTool = state.toolCache;
          const oldAuto = state.autoCache;
          buildCaches(resolvedNext);
          void oldTool?.close();
          void oldAuto?.close();
        } else {
          state.toolCache.maxEntries = resolvedNext.cache.maxEntries;
          state.autoCache.maxEntries = resolvedNext.cache.maxEntries;
        }
        // §4.4: seam.mode / seam.include / seam.requireReader are live — a change
        // must never leave "config says off, the process still injects". The
        // re-seat is uninstall → recompute → reinstall, then a fresh self-proof.
        applySeamOptions(resolvedNext);
        installCurrentSeam();
        void verifySeamLive();
        state.gate = new ConcurrencyGate(resolvedNext.concurrency);
        state.bridge = buildBridge(resolvedNext);
        logger.info('vision-bridge: configuration applied live (model ' + resolvedNext.provider.model
          + ', mode ' + resolvedNext.mode + ', fingerprint ' + fingerprint(resolvedNext).slice(0, 12) + ')');
      } catch (error) {
        logger.error('vision-bridge: rebuild after settings change failed; previous runtime keeps serving (' + (error?.message ?? error) + ')');
      }
    }));

    // ⑧ Settings-card server routes (design §11): a scoped webServer inject —
    // the closure runs only where a web server exists (headless stays
    // untouched) and RETURNS the route disposers, so a fiber re-run cannot
    // leak duplicate (kind, path) registrations (modlens-isomorphic shape).
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => installServerRoutes(scope, {
        logger,
        dshHome,
        getConfig: () => state.config,
        resolveCredentialByName,
        settingsGet: settingsReader.get,
        listLoadedPlugins: () => pluginRegistryNames(ctx),
        ...buildAdmissionProbeDeps(ctx, settingsReader.get),
      }));
    }

    // ⑨ Disposer: abort lifecycle (in-flight auto analyses observe it), then
    // flush the caches — awaited so a dispose-then-reload never races the final
    // cache write (async disposers are awaited by cordis fiber teardown and by
    // tests; a caller that ignores the promise degrades to today's behavior).
    return async () => {
      // The seam must never outlive the fiber (§4.4): restore before anything
      // else, so a stop→start cycle re-installs instead of reading a false
      // 'already' (B2).
      uninstallSeam();
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* disposal must not mask the rest */ }
      }
      lifecycle.abort();
      await Promise.allSettled([state.toolCache?.close(), state.autoCache?.close()]);
    };
  } catch (error) {
    // B-I1(2): any throw after the decoration was installed must restore it
    // BEFORE the error propagates — "the gate admits images while the plugin is
    // not loaded" is the silent path §4.5/B5 forbids, and a leftover wrapper
    // would make a later install read a false already (B2).
    uninstallSeam();
    throw error;
  }
}
