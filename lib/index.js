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
 * @module @dsh-external/dsh-vision-bridge
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { VisionBridge } from '../vendor/vision-bridge/dist/index.js';
import { installAutoMode } from './auto.js';
import { Config, SETTINGS_NAMESPACE, resolveConfig } from './config.js';
import { createVisionBridgeReadTool } from './tools.js';
import { ConcurrencyGate, InFlightDedup, NamespacedNoteCache, fingerprint, hashQuestion, noteKey } from './cache-backend.js';
import { createWrappedAdapter } from './adapter-wrapper.js';
import { installServerRoutes } from './server-routes.js';

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

/** Plugin entry. */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger('vision-bridge');
  const dshHome = resolveDshHome();
  const pluginDir = join(dshHome, 'vision-bridge');
  const defaultsFile = join(pluginDir, 'provider-defaults.json');
  const persistDirFallback = join(pluginDir, 'cache');

  // ① First-run freeze BEFORE registration so the very first resolution uses it.
  const providerDefaults = ensureFrozenDefaults(ctx.settings, defaultsFile, logger);

  // ② Settings: schema defaults → composition base → user layer; validate
  // rejects a resolved section the runtime could not serve (loud at load,
  // refuse-and-keep-old on live updates).
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'live',
    validate: (value) => { resolveConfig(value, { providerDefaults, persistDirFallback }); },
  });

  // ③ Mutable runtime state — fully rebuildable (fiber re-entry rebuilds it).
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
      const image = await ctx.attachments.readImageRequest(
        {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
        { maxPixels: resolved.maxImagePixels, maxBytes: resolved.maxImageBytes },
        signal,
      );
      // Directive assembly (design §10.3): fixed order question → language →
      // promptExtra; an empty promptExtra changes nothing (zero byte drift),
      // and promptExtra rides the cache fingerprint so answers miss naturally.
      const languageDirective = resolved.language === 'zh' ? '\n\n请用简体中文回答。' : '\n\nPlease answer in English.';
      const promptExtraDirective = resolved.promptExtra ? '\n\n' + resolved.promptExtra : '';
      // Assign the per-operation key immediately before analyze with no awaits
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

  // ④ Tool mode.
  disposers.push(ctx.effect(() => ctx.tools.register(createVisionBridgeReadTool(runtime)), 'vision-bridge: vision_bridge_read tool'));

  // ⑤ Auto mode: listeners install unconditionally; the mode setting is
  // checked live per event/step, so switching tool↔auto↔both applies instantly.
  disposers.push(installAutoMode(ctx, runtime));

  // ⑥ Live settings: refuse-and-keep-old on validation failure, rebuild
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
      state.gate = new ConcurrencyGate(resolvedNext.concurrency);
      state.bridge = buildBridge(resolvedNext);
      logger.info('vision-bridge: configuration applied live (model ' + resolvedNext.provider.model
        + ', mode ' + resolvedNext.mode + ', fingerprint ' + fingerprint(resolvedNext).slice(0, 12) + ')');
    } catch (error) {
      logger.error('vision-bridge: rebuild after settings change failed; previous runtime keeps serving (' + (error?.message ?? error) + ')');
    }
  }));

  // ⑦ Settings-card server routes (design §11): a scoped webServer inject —
  // the closure runs only where a web server exists (headless stays
  // untouched) and RETURNS the route disposers, so a fiber re-run cannot
  // leak duplicate (kind, path) registrations (modlens-isomorphic shape).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => installServerRoutes(scope, {
      logger,
      dshHome,
      getConfig: () => state.config,
      resolveCredentialByName,
      settingsGet: (ns) => ctx.settings.get(ns),
      listLoadedPlugins: () => pluginRegistryNames(ctx),
    }));
  }

  // ⑧ Disposer: abort lifecycle (in-flight auto analyses observe it), then
  // flush the caches — awaited so a dispose-then-reload never races the final
  // cache write (async disposers are awaited by cordis fiber teardown and by
  // tests; a caller that ignores the promise degrades to today's behavior).
  return async () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* disposal must not mask the rest */ }
    }
    lifecycle.abort();
    await Promise.allSettled([state.toolCache?.close(), state.autoCache?.close()]);
  };
}
