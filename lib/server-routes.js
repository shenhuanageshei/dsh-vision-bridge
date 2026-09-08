/**
 * Server-side HTTP routes for the settings card v2 (design §11): mounted on
 * the dsh web server through a scoped `ctx.inject(['webServer'], ...)` — the
 * closure runs when the service appears and never runs where it does not
 * (headless stays untouched; the plugin itself never waits on it). Same
 * shape as the modlens paste route (M0-3 evidence:
 * @liustack/modlens/dsh/index.js:170-195 scoped inject, :486-530 route).
 *
 * Routes (all loopback; the browser half fetches them with relative URLs,
 * as the modlens client half does):
 * - POST /vision-bridge/test          — one-shot connectivity probe (§11.3D):
 *   body {baseURL?, model?, credential?, pendingApiKey?} → a transient
 *   engine (no persistence) analyzes a 1×1 PNG once; the pending key, when
 *   supplied, exists only inside this single request and is never echoed;
 * - GET  /vision-bridge/env           — providers projection (read-only view
 *   of settings.yaml `llm-pi-ai.providers`) + environment checks for the
 *   health panel (§11.3E);
 * - POST /vision-bridge/fix-admission — re-apply the admission-gate patch
 *   through the exported script API (idempotent, `.bak` backups);
 * - POST /vision-bridge/fix-modlens   — append the `pasteToPath: false`
 *   same-id override row to <PROFILE_PATCH> (idempotent, atomic write).
 *
 * M0 premise verification (2026-09-07, design §11.4 "M0 前提核验"):
 *
 * - M0-1 providers projection: settings.yaml `llm-pi-ai.providers` carries
 *   `apiKeyEnv` + `models[].input` for every provider, and a `baseURL` only
 *   for some (profile/settings.yaml: qax and fangzhou-codingplan carry
 *   baseURL; zai-coding-cn and minimax-cn do not — their bases are baked
 *   into the pi-ai adapters, @earendil-works/pi-ai/dist/providers/
 *   zai-coding-cn.js:9 and minimax-cn.js:9, outside the settings document).
 *   Risk #12's registered degradation is therefore PARTIAL per provider:
 *   for providers without a readable baseURL the projection reports the
 *   empty string and the card leaves the field alone with a "fill manually"
 *   hint. The projection reads `settingsGet('llm-pi-ai')` at request time —
 *   read-only.
 * - M0-2 remote.credentials: the client service names are `remote` and
 *   `remote.credentials` (settings-plugins client inject list,
 *   dsh-client-ui-settings-plugins/lib/client.js:1697-1704) with methods
 *   `describe(refs) → {configured, source?, writable}` and
 *   `set(ref, value)` (dsh-api-remotes/lib/client.js:4697-4707; server side
 *   dsh-api-settings-controller/lib/index.js:146-190). There is NO `create`
 *   method and the reference half has no enumeration
 *   (dsh-credentials/lib/types/index.d.ts:166-174 — "configuration surfaces
 *   learn which references exist from settings schemas"). The §11.3C
 *   "create with conflict rejection" semantics are implemented in the card
 *   as describe-then-set (configured ⇒ refuse without overwriting); the
 *   credential dropdown list is derived from the providers projection
 *   (apiKeyEnv) plus the plugin's own ref and VISION_API_KEY.
 * - M0-3 webServer route isomorphism: route registration
 *   `webServer.register({name, kind:'exact', path, handler})` returns a
 *   disposer and throws on duplicate (kind, path)
 *   (dsh-host-webserver/lib/types/index.d.ts:33-41, 88-91) — this module's
 *   installer returns the combined disposers, and the scoped-inject caller
 *   returns THEM so a fiber re-run cannot leak duplicate routes (cordis
 *   collects an apply-returned function, cordis lib/index.js:1142).
 *
 * @module @dsh-external/dsh-vision-bridge/server-routes
 */
import { readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VisionBridge } from '../vendor/vision-bridge/dist/index.js';
import { createWrappedAdapter } from './adapter-wrapper.js';
import { applyAdmissionPatch, detectAdmissionPatch } from '../scripts/patch-admission-gate.mjs';

/** Request-body ceiling for the JSON routes (the probe body is tiny). */
const MAX_BODY_BYTES = 64 * 1024;
/** Budget for the loopback modlens-paste probe inside the env check. */
const MODLENS_PROBE_TIMEOUT_MS = 3000;
/** Connectivity probe payload: a 1×1 transparent PNG, base64. */
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** User request text for the probe — content is irrelevant, the round trip is the fact. */
const PROBE_REQUEST = 'connectivity check: reply with the single word ok';
/** Truncation for error strings crossing the wire (never the key itself). */
const MAX_ERROR_CHARS = 500;

const MODLENS_OVERRIDE_BLOCK = [
  '# modlens paste-to-path off (dsh-vision-bridge one-click fix): same-id override row',
  '# (an override row replaces the bundle row config). Delete this row to restore',
  '# modlens paste takeover.',
  '- id: modlens',
  '  config:',
  '    pasteToPath: false',
].join('\n') + '\n';

function truncateText(text) {
  const value = String(text ?? '');
  return value.length > MAX_ERROR_CHARS ? value.slice(0, MAX_ERROR_CHARS) : value;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Read and JSON-parse one request body (bounded); `{}` for an empty body. */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`body over the ${MAX_BODY_BYTES}-byte limit`);
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('body must be a JSON object');
    error.code = 'bad-shape';
    throw error;
  }
  return parsed;
}

/** Drain a body this route does not interpret (keep-alive hygiene). */
async function drainBody(req) {
  try { for await (const _chunk of req) { /* drain */ } } catch { /* peer went away — not ours */ }
}

/** Optional string field: absent/null/blank ⇒ undefined; non-string ⇒ 400. */
function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    const error = new Error(`field "${field}" must be a string`);
    error.code = 'bad-field';
    throw error;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Map a thrown engine/wrapper error onto the probe's error code. */
export function classifyTestFailure(error) {
  const message = String(error?.message ?? error);
  const status = /API error (\d{3}):/.exec(message);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403) return 'auth';
    if (code === 404) return 'endpoint';
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /abort|timeout|timed? ?out/i.test(message)) return 'timeout';
  return 'unknown';
}

/**
 * Read-only projection of settings.yaml `llm-pi-ai.providers` for the card's
 * provider dropdown (design §11.2-1): {id, baseURL ('' when unreadable —
 * risk #12), apiKeyEnv, models[{id, name, vision}]}. `vision` is true only
 * when the model declares image input; `[]` inherits the provider default
 * (text) and projects false.
 * @param {(ns: string) => any} settingsGet - settings service reader.
 * @returns {Array<object>} providers in document order.
 */
/**
 * Built-in provider baseUrl map from the installed pi-ai package
 * (node_modules/@earendil-works/pi-ai/dist/providers/<id>.js, a line
 * `baseUrl: "https://…"`). Read once per call — cheap, and profile
 * updates swap the package without stale caches.
 * @param {string} nodeModulesDir - the profile's node_modules directory.
 * @returns {Record<string, string>} provider id → baseUrl.
 */
export function readCatalogBaseUrls(nodeModulesDir) {
  const out = {};
  if (typeof nodeModulesDir !== 'string' || nodeModulesDir === '') return out;
  let dir;
  try {
    dir = join(nodeModulesDir, '@earendil-works', 'pi-ai', 'dist', 'providers');
  } catch { return out; }
  let files = [];
  try { files = readdirSync(dir); } catch { return out; }
  for (const name of files) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
    let source;
    try { source = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const match = source.match(/baseUrl:\s*["']([^"']+)["']/);
    if (!match) continue;
    let base = match[1];
    // pi-ai catalog bases are protocol-specific; an `/anthropic` tail marks
    // the Anthropic face while this plugin's engine speaks OpenAI chat.
    // The same host serves the OpenAI face at `/v1` (verified live:
    // api.minimaxi.com/anthropic → 404 under our engine; /v1 → 200).
    if (/\/anthropic\/?$/.test(base)) base = base.replace(/\/anthropic\/?$/, '/v1');
    out[name.replace(/\.(m?js)$/, '')] = base;
  }
  return out;
}
export function projectProviders(settingsGet, catalogBaseUrls) {
  let raw;
  try {
    raw = settingsGet('llm-pi-ai');
  } catch {
    raw = undefined;
  }
  // Provider bases DSH itself knows (user feedback: "部分 provider dsh 是内置
  // 了URL"): the pi-ai package under the profile's node_modules carries a
  // built-in baseUrl per provider id (dist/providers/<id>.js). The catalog
  // read is a tiny, failure-tolerant scan — absent package ⇒ empty map, and
  // the settings.yaml value (when present) always wins.
  const catalog = catalogBaseUrls && typeof catalogBaseUrls === 'object' ? catalogBaseUrls : {};
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.providers : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map)
    .filter(([, provider]) => provider && typeof provider === 'object' && !Array.isArray(provider))
    .map(([id, provider]) => ({
      id,
      baseURL: typeof provider.baseURL === 'string' && provider.baseURL.trim() !== ''
        ? provider.baseURL.trim()
        : (typeof catalog[id] === 'string' ? catalog[id] : ''),
      apiKeyEnv: typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv.trim() : '',
      models: (Array.isArray(provider.models) ? provider.models : [])
        .filter((model) => model && typeof model === 'object' && typeof model.id === 'string' && model.id.trim() !== '')
        .map((model) => ({
          id: model.id,
          name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id,
          vision: Array.isArray(model.input) && model.input.includes('image'),
        })),
    }));
}

/**
 * Credential references the card should describe (design §11.3C): every
 * provider's apiKeyEnv, the plugin's current credential, and the shared
 * VISION_API_KEY default — deduplicated, order preserved. The reference half
 * of the credential seam has no enumeration (M0-2), so the list is derived
 * from the settings schema exactly as its documentation prescribes.
 * @param {Array<object>} providers - projection rows.
 * @param {{provider?: {credential?: string}}} [config] - resolved config.
 * @returns {Array<string>} unique reference names.
 */
export function credentialCandidateRefs(providers, config) {
  const refs = [];
  const add = (ref) => {
    if (typeof ref === 'string' && ref.trim() !== '' && !refs.includes(ref)) refs.push(ref);
  };
  for (const provider of providers) add(provider.apiKeyEnv);
  add(config?.provider?.credential);
  add('VISION_API_KEY');
  return refs;
}

/**
 * Locate the modlens override row state in the patch text (review #2 makes
 * this tri-state): "applied" (row exists with pasteToPath:false), "present"
 * (row exists WITHOUT it — must merge, never append a duplicate id), or
 * "absent" (no row; safe to append).
 * @param {string} text - the patch YAML document.
 * @returns {{status: 'applied'|'present'|'absent', insertAfter?: number, indent?: string}}
 */
export function modlensOverrideState(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s+id:\s*['"]?modlens['"]?\s*(?:#.*)?$/.test(lines[i])) continue;
    // The entry body runs until the next column-0 item; nested list items
    // inside the entry do not end it (a premature break would miss a
    // pasteToPath that follows them).
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^-\s/.test(lines[j])) { end = j; break; }
      if (/^\s*pasteToPath:\s*false\s*(?:#.*)?$/.test(lines[j])) return { status: 'applied' };
    }
    // Row present without pasteToPath:false — find where to merge the config
    // line: prefer an existing `config:` key line, else insert a new block
    // right after the id line.
    const idIndent = lines[i].match(/^(\s*)/)[1];
    for (let j = i + 1; j < end; j++) {
      if (/^\s*config:\s*(?:#.*)?$/.test(lines[j])) {
        return { status: 'present', insertAfter: j, indent: '  ' + (lines[j].match(/^(\s*)/)[1]) };
      }
    }
    return { status: 'present', insertAfter: i, indent: idIndent + '  ' };
  }
  return { status: 'absent' };
}

/** Legacy boolean face: row exists AND already carries pasteToPath:false. */
export function findModlensOverride(text) {
  return modlensOverrideState(text).status === 'applied';
}

/**
 * Merge pasteToPath:false into an existing modlens row (review #2), or
 * append a fresh override block when no row exists.
 */
export function appendModlensOverride(text) {
  const state = modlensOverrideState(text);
  if (state.status === 'present') {
    const lines = String(text ?? '').split(/\r?\n/);
    const inject = state.indent + 'pasteToPath: false';
    lines.splice(state.insertAfter + 1, 0, inject);
    return lines.join('\n').replace(/\n*$/, '\n');
  }
  const base = text === '' ? '' : /\n$/.test(text) ? text : text + '\n';
  return base + MODLENS_OVERRIDE_BLOCK;
}

/** The document shape a safe line-based append requires: only list rows,
 * indented continuations, comments, and separators — a column-0 mapping key
 * would defeat both the override search and the append. */
export function looksLikePatchList(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line) || /^---\s*$/.test(line)) continue;
    if (/^[\s-]/.test(line)) continue;
    return false;
  }
  return true;
}



/** Atomic text write (tmp + rename); the tmp file is cleaned on failure. */
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-vision-bridge';
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw error;
  }
}

/**
 * Mount the four vision-bridge routes on a webServer-carrying scope.
 *
 * @param {{webServer: any}} scope - the webServer-injected context.
 * @param {object} deps - injectable collaborators (tests substitute these):
 *   `logger`, `dshHome` (derives nodeModulesDir + profilePatchPath),
 *   `getConfig()` → the current resolved config, `resolveCredentialByName(name)`
 *   → the stored key (throws when unconfigured), `settingsGet(ns)`,
 *   `listLoadedPlugins()` → registry display names, `fetchImpl`, `now`.
 * @returns {() => void} disposer removing every route.
 */
export function installServerRoutes(scope, deps = {}) {
  const webServer = scope?.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('vision-bridge: installServerRoutes requires a webServer scope');
  }
  const logger = deps.logger ?? { info() {}, warn() {}, error() {} };
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const getConfig = deps.getConfig ?? (() => { throw new Error('vision-bridge: no config source wired'); });
  const resolveCredentialByName = deps.resolveCredentialByName;
  const settingsGet = deps.settingsGet ?? (() => undefined);
  const listLoadedPlugins = deps.listLoadedPlugins ?? (() => []);
  const nodeModulesDir = deps.nodeModulesDir
    ?? (deps.dshHome !== undefined ? join(deps.dshHome, 'profiles', 'web', 'node_modules') : undefined);
  const profilePatchPath = deps.profilePatchPath
    ?? (deps.dshHome !== undefined ? join(deps.dshHome, 'profiles', 'web', 'cordis.patch.yml') : undefined);

  function safeConfig() {
    try {
      return getConfig();
    } catch (error) {
      const wrapped = new Error('vision-bridge: current configuration unavailable (' + (error?.message ?? error) + ')');
      wrapped.code = 'no-config';
      throw wrapped;
    }
  }

  /** POST /vision-bridge/test — one-shot connectivity probe (§11.3D). */
  async function handleTest(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error?.code === 'too-large' ? 413 : 400, { error: truncateText(error?.message) });
      return;
    }
    let config;
    try {
      config = safeConfig();
    } catch (error) {
      sendJson(res, 500, { error: truncateText(error?.message) });
      return;
    }
    try {
      const draftBaseURL = optionalString(body, 'baseURL');
      const draftModel = optionalString(body, 'model');
      const draftCredential = optionalString(body, 'credential');
      const pendingApiKey = optionalString(body, 'pendingApiKey');

      const baseURL = draftBaseURL ?? config.provider.baseURL;
      if (!/^https?:\/\//i.test(baseURL)) {
        sendJson(res, 400, { error: 'baseURL must be an http(s) URL' });
        return;
      }
      const model = draftModel ?? config.provider.model;
      if (!model) {
        sendJson(res, 400, { error: 'model must not be empty' });
        return;
      }
      const credential = draftCredential ?? config.provider.credential;

      let apiKey;
      if (pendingApiKey !== undefined) {
        // Transient: lives only inside this request; never persisted, never
        // echoed back (the response carries only ok/latency/error).
        apiKey = pendingApiKey;
      } else {
        if (typeof resolveCredentialByName !== 'function') {
          sendJson(res, 500, { error: 'vision-bridge: credential resolver unavailable' });
          return;
        }
        try {
          apiKey = await resolveCredentialByName(credential);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: { code: 'auth', message: truncateText(error?.message) } });
          return;
        }
      }

      const started = now();
      // Transient engine: no persist backend and no persistDir ⇒ nothing is
      // cached or written; the probe is a single chat/completions round trip.
      const adapter = createWrappedAdapter({ api: 'openai' });
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: model, baseURL, apiKey, provider: 'vision-bridge-test', input: ['text', 'image'] },
          timeoutMs: config.timeoutMs,
        },
      });
      try {
        await bridge.analyze({
          images: [{ type: 'image', mimeType: 'image/png', data: PROBE_PNG }],
          userRequest: PROBE_REQUEST,
        });
        sendJson(res, 200, { ok: true, latencyMs: now() - started, model });
      } catch (error) {
        logger.warn?.('vision-bridge: connectivity probe failed (' + (error?.message ?? error) + ')');
        sendJson(res, 200, { ok: false, error: { code: classifyTestFailure(error), message: truncateText(error?.message) } });
      }
    } catch (error) {
      sendJson(res, error?.code === 'bad-field' ? 400 : 500, { error: truncateText(error?.message) });
    }
  }

  /** GET /modlens/paste through the loopback server: 'active' | 'off' | 'unknown'. */
  async function probeModlensPaste() {
    try {
      // Review #5: the port attribute name is unverified across host
      // versions; probe the documented shapes and fall back to unknown.
      const port = webServer.port ?? webServer.address?.()?.port;
      const host = (webServer.host ?? '127.0.0.1') || '127.0.0.1';
      if (!port) return 'unknown';
      const url = `http://${host}:${port}/modlens/paste?model=${encodeURIComponent('x')}`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(MODLENS_PROBE_TIMEOUT_MS) });
      if (response.status === 200) return 'active';
      if (response.status === 404) return 'off';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** The three modlens facts (§11.2-5): loaded? route verdict? conflict? */
  async function checkModlens() {
    const installed = listLoadedPlugins().some((name) => String(name ?? '').toLowerCase().includes('modlens'));
    const paste = await probeModlensPaste();
    return { installed, paste, conflict: installed && paste === 'active' };
  }

  /** GET /vision-bridge/env — providers projection + environment checks. */
  async function handleEnv(req, res) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      const providers = projectProviders(settingsGet, readCatalogBaseUrls(nodeModulesDir));
      let config;
      try {
        config = safeConfig();
      } catch {
        config = undefined; // the health panel still renders without a config source
      }
      const admission = detectAdmissionPatch(nodeModulesDir);
      const modlens = await checkModlens();
      sendJson(res, 200, {
        providers,
        credentialCandidates: credentialCandidateRefs(providers, config),
        admission: {
          status: admission.status,
          files: admission.files.map((f) => ({ file: f.file, status: f.status })),
        },
        modlens,
      });
    } catch (error) {
      sendJson(res, 500, { error: truncateText(error?.message) });
    }
  }

  /** POST /vision-bridge/fix-admission — idempotent patch re-apply. */
  async function handleFixAdmission(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    await drainBody(req);
    try {
      const files = applyAdmissionPatch({ nodeModulesDir, logger });
      const applied = files.some((f) => f.status === 'patched');
      const alreadyPatched = files.length > 0 && files.every((f) => f.status === 'skipped');
      const failed = files.some((f) => f.status === 'error' || f.status === 'nomatch');
      sendJson(res, 200, { applied, alreadyPatched, failed, files, needsRestart: true });
    } catch (error) {
      sendJson(res, 500, { error: truncateText(error?.message) });
    }
  }

  /** POST /vision-bridge/fix-modlens — idempotent override-row append. */
  async function handleFixModlens(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    await drainBody(req);
    if (typeof profilePatchPath !== 'string' || profilePatchPath === '') {
      sendJson(res, 500, { error: 'vision-bridge: profile patch path is not configured' });
      return;
    }
    let text;
    try {
      text = readFileSync(profilePatchPath, 'utf8');
    } catch (error) {
      sendJson(res, 500, { error: 'vision-bridge: could not read ' + profilePatchPath + ' (' + truncateText(error?.message) + ')' });
      return;
    }
    try {
      if (findModlensOverride(text)) {
        sendJson(res, 200, { applied: false, alreadyPatched: true, needsRestart: true, path: profilePatchPath });
        return;
      }
      if (!looksLikePatchList(text)) {
        // Risk #14: refuse to touch a document our line-based append cannot
        // reason about; the original file stays untouched.
        sendJson(res, 500, { error: 'vision-bridge: ' + profilePatchPath + ' has an unexpected document structure; refusing the automatic write' });
        return;
      }
      writeFileAtomic(profilePatchPath, appendModlensOverride(text));
      logger.info?.('vision-bridge: appended the modlens pasteToPath:false override row to ' + profilePatchPath + ' (needs restart)');
      sendJson(res, 200, { applied: true, alreadyPatched: false, needsRestart: true, path: profilePatchPath });
    } catch (error) {
      sendJson(res, 500, { error: 'vision-bridge: could not write ' + profilePatchPath + ' (' + truncateText(error?.message) + '); the original file was left untouched' });
    }
  }

  const disposers = [
    webServer.register({ name: 'vision-bridge-test', kind: 'exact', path: '/vision-bridge/test', handler: handleTest }),
    webServer.register({ name: 'vision-bridge-env', kind: 'exact', path: '/vision-bridge/env', handler: handleEnv }),
    webServer.register({ name: 'vision-bridge-fix-admission', kind: 'exact', path: '/vision-bridge/fix-admission', handler: handleFixAdmission }),
    webServer.register({ name: 'vision-bridge-fix-modlens', kind: 'exact', path: '/vision-bridge/fix-modlens', handler: handleFixModlens }),
  ];
  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* disposal must not mask the rest */ }
    }
  };
}
