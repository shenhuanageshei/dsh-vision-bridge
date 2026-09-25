/**
 * Behavioral tests for the browser half's compatibility layer (§4-D/E/H).
 *
 * lib/client.js is a browser bundle: it registers through
 * window.__ModuleLoader__ and takes react from the loader. This suite loads it
 * exactly that way, runs `apply` against a fake kernel, and CALLS the card
 * component with react.createElement replaced by a plain node builder — so the
 * two settings generations, the slot ladder, the three card states and the
 * write path are exercised without a DOM, a reconciler or a real kernel.
 *
 * Every test imports a fresh module instance: the bundle keeps module-level
 * state (the one-shot warnings, the mounted guard), and sharing it would make
 * one case's residue decide the next one's result.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_PATH = path.join(root, 'lib', 'client.js');
const PACKAGE_NAME = '@dsh-external/dsh-vision-bridge';
const SETTINGS_NS = 'vision-bridge';
const LEGACY_SLOT = 'settings.plugin.item';
/** Comfortably past one wake-up interval, well inside the attempt budget. */
const WAKEUP_MS = 900;

/** react.createElement as a plain node builder: {type, props, children}. */
const react = {
  Fragment: Symbol('react.Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
};

let loadCount = 0;

/** Load the bundle the way the kernel does and return its exports. */
async function loadClient() {
  let definition = null;
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
  loadCount += 1;
  await import(pathToFileURL(CLIENT_PATH).href + '?case=' + loadCount);
  assert.ok(definition !== null, 'the bundle registers through window.__ModuleLoader__');
  assert.equal(definition.id, PACKAGE_NAME);
  return definition.factory((id) => {
    if (id === 'react') return react;
    throw new Error('unexpected require: ' + id);
  });
}

/** The style installer runs inside apply, so the module needs a document. */
function fakeDocument() {
  const styles = [];
  return {
    styles,
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() { styles.pop(); } }),
    head: { appendChild: (tag) => { styles.push(tag); } },
  };
}

/**
 * A fake kernel: `get` is the lazy service face, `slots` carries the probe and
 * the two registration verbs, `effect` runs its factory at once (like cordis)
 * and keeps the disposer.
 */
function fakeKernel(options = {}) {
  const { services = {}, declared = { 'plugins.row.config': { kind: 'keyed' } }, probe = true } = options;
  const kernel = {
    services,
    registrations: [],
    waits: [],
    disposers: [],
    unregistered: 0,
    get: (name) => services[name],
    effect(fn) {
      const result = fn();
      if (typeof result === 'function') kernel.disposers.push(result);
      return result;
    },
    locale: {
      registered: null,
      register(namespace, dictionaries) {
        kernel.locale.registered = { namespace, dictionaries };
      },
      bind: () => (key) => key,
    },
    slots: {
      register(cardOptions, component) {
        kernel.registrations.push({ options: cardOptions, component });
        return () => { kernel.unregistered += 1; };
      },
      inject(slot, callback) {
        kernel.waits.push({ slot, callback });
        return () => { kernel.waits.length = 0; };
      },
    },
  };
  if (probe) kernel.slots.specDynamic = (slot) => declared[slot];
  Object.assign(kernel.slots, options.slots ?? {});
  return kernel;
}

/** Apply the bundle and return the card handle (registration + callable props). */
async function applyClient(kernel) {
  const client = await loadClient();
  client.apply(kernel);
  return client;
}

function cardHandle(kernel, router) {
  assert.equal(kernel.registrations.length, 1, 'exactly one card is registered');
  const registered = kernel.registrations[0];
  const injected = registered.options.inject();
  const store = injected.hooks.visionBridgeCard;
  const useVisionBridgeCard = (selector) => selector(store.getSnapshot());
  const props = { ...injected, useVisionBridgeCard, t: (key) => key };
  return {
    options: registered.options,
    component: registered.component,
    store,
    props,
    state: () => store.getSnapshot(),
    render: (view) => registered.component({ ...props, view }),
    unmount() {
      for (const disposer of kernel.disposers.splice(0)) disposer();
    },
  };
}

async function mountCard(kernel, router) {
  await applyClient(kernel);
  return cardHandle(kernel, router);
}

/** Walk a rendered tree (nodes carry children, text rides as strings). */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === 'object') {
    visit(node);
    walk(node.children, visit);
  }
}

function allNodes(tree) {
  const out = [];
  walk(tree, (node) => out.push(node));
  return out;
}

function textsOf(tree) {
  const out = [];
  walk(tree, (node) => {
    for (const child of node.children) if (typeof child === 'string') out.push(child);
  });
  return out;
}

function nodesOfType(tree, type) {
  return allNodes(tree).filter((node) => node.type === type);
}

function byId(tree, id) {
  return allNodes(tree).find((node) => node.props.id === id) ?? null;
}

function hasText(tree, text) {
  return textsOf(tree).some((item) => item.includes(text));
}

/** Exact copy match — `includes` would let "envLoading" pass as "loading". */
function hasExactText(tree, text) {
  return textsOf(tree).includes(text);
}

/** A 0.1.7 configForms service over a tiny in-memory value store. */
function fakeConfigForm(initial) {
  let value = structuredClone(initial);
  let revision = 1;
  const listeners = new Set();
  const writes = [];
  const setPath = (target, path, next) => {
    let cursor = target;
    for (const key of path.slice(0, -1)) cursor = cursor[key] ??= {};
    cursor[path[path.length - 1]] = next;
  };
  const face = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision, value }),
    mutate(ops, expectedRevision) {
      writes.push([ops, expectedRevision]);
      if (expectedRevision !== undefined && expectedRevision !== revision) return false;
      for (const op of ops) {
        if (op.op === 'set') setPath(value, op.path, op.value);
        else setPath(value, op.path, undefined);
      }
      revision += 1;
      for (const listener of [...listeners]) listener();
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    writes,
    face,
    service: { get: (namespace) => (namespace === SETTINGS_NS ? face : null) },
    listenerCount: () => listeners.size,
  };
}

/** A 0.1.6 settingsScope service: bind() hands back the namespace face. */
function fakeSettingsScope(initial) {
  const binds = [];
  const writes = [];
  const face = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: structuredClone(initial) }),
    mutate(ops) { writes.push(ops); },
  };
  return {
    binds,
    writes,
    face,
    service: {
      bind(options) {
        binds.push(options);
        return face;
      },
    },
  };
}

let fakeDoc = null;

beforeEach(() => {
  fakeDoc = fakeDocument();
  globalThis.document = fakeDoc;
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

describe('apply — the compatibility wiring (§4-D/E)', () => {
  it('declares only slots + locale and exports name/inject/apply', async () => {
    const client = await loadClient();
    assert.equal(client.name, PACKAGE_NAME);
    assert.deepEqual(client.inject, ['slots', 'locale']);
    assert.equal(typeof client.apply, 'function');
  });

  it('registers the locale dictionary with both new keys in both languages', async () => {
    const kernel = fakeKernel();
    await mountCard(kernel);
    const registered = kernel.locale.registered;
    assert.equal(registered.namespace, 'vision-bridge-ui');
    for (const language of ['en', 'zh']) {
      const dictionary = registered.dictionaries[language];
      assert.equal(typeof dictionary.settingsUnavailable, 'string');
      assert.equal(typeof dictionary.credentialsUnavailable, 'string');
      assert.ok(dictionary.settingsUnavailable.length > 0);
      assert.ok(dictionary.credentialsUnavailable.length > 0);
    }
    assert.notEqual(registered.dictionaries.en.settingsUnavailable, registered.dictionaries.zh.settingsUnavailable);
    assert.notEqual(registered.dictionaries.en.credentialsUnavailable, registered.dictionaries.zh.credentialsUnavailable);
  });

  it('resolves no settings face up front and mounts the card anyway', async () => {
    const kernel = fakeKernel();
    await mountCard(kernel);
    assert.equal(kernel.registrations.length, 1, 'the card mounts while the face is still loading');
    assert.deepEqual(fakeDoc.styles.length, 1, 'the styles tag is installed through ctx.effect');
  });
});

describe('the card slot ladder (§4-E)', () => {
  it('takes this plugin row when the kernel declares it', async () => {
    const kernel = fakeKernel({ declared: { 'plugins.row.config': { kind: 'keyed' } } });
    const card = await mountCard(kernel);
    assert.equal(card.options.name, 'plugins.row.config');
    assert.equal(card.options.key, PACKAGE_NAME + '#vision-bridge');
    assert.equal(card.options.locale, 'vision-bridge-ui');
    assert.deepEqual(kernel.waits, [], 'a declared rung is taken directly');
  });

  it('falls to the bundle cell when only the bundle is declared', async () => {
    const kernel = fakeKernel({ declared: { 'plugins.bundle.config': { kind: 'keyed' } } });
    const card = await mountCard(kernel);
    assert.equal(card.options.name, 'plugins.bundle.config');
    assert.equal(card.options.key, PACKAGE_NAME);
  });

  it('uses the list rung with its own id, order and label when that is declared', async () => {
    const kernel = fakeKernel({ declared: { 'plugins.item': { kind: 'list' } } });
    const card = await mountCard(kernel);
    assert.equal(card.options.name, 'plugins.item');
    assert.equal(card.options.id, 'vision-bridge');
    assert.equal(card.options.order, 40);
    assert.equal(card.options.label(), 'cardTitle');
    assert.equal('key' in card.options, false, 'a list rung carries no cell key');
  });

  it('falls to the 0.1.6 legacy slot when it is the only declared one', async () => {
    const kernel = fakeKernel({ declared: { [LEGACY_SLOT]: { kind: 'keyed' } } });
    const card = await mountCard(kernel);
    assert.equal(card.options.name, LEGACY_SLOT);
    assert.equal(card.options.key, SETTINGS_NS);
  });

  it('waits through slots.inject for a rung the kernel has not declared yet', async () => {
    const kernel = fakeKernel({ declared: {} });
    await applyClient(kernel);
    assert.equal(kernel.registrations.length, 0, 'an undeclared rung is not registered blind');
    assert.equal(kernel.waits.length, 1);
    assert.equal(kernel.waits[0].slot, 'plugins.row.config');
    kernel.waits[0].callback();
    assert.equal(kernel.registrations.length, 1, 'the card mounts when the declaration arrives');
    assert.equal(kernel.registrations[0].options.key, PACKAGE_NAME + '#vision-bridge');
    kernel.waits[0].callback();
    assert.equal(kernel.registrations.length, 1, 'a second declaration does not stack a second card');
  });

  it('walks past a rung whose declared kind does not match', async () => {
    const warnings = [];
    const savedWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      const kernel = fakeKernel({
        declared: { 'plugins.row.config': { kind: 'tabs' }, 'plugins.item': { kind: 'list' } },
      });
      const card = await mountCard(kernel);
      assert.equal(card.options.name, 'plugins.item');
      const mismatches = warnings.filter((message) => /is declared with kind/.test(message));
      assert.equal(mismatches.length, 1, 'the mismatch is reported once');
      assert.match(mismatches[0], /plugins\.row\.config is declared with kind tabs/);
    } finally {
      console.warn = savedWarn;
    }
  });

  it('waits on the legacy rung when the kernel has no probe face at all', async () => {
    const kernel = fakeKernel({ probe: false });
    await applyClient(kernel);
    assert.equal(kernel.registrations.length, 0);
    assert.equal(kernel.waits.length, 1);
    assert.equal(kernel.waits[0].slot, LEGACY_SLOT);
  });

  it('mounts nothing and warns once when no rung fits (§4-H5)', async () => {
    const warnings = [];
    const savedWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      const kernel = fakeKernel({
        declared: {
          'plugins.row.config': { kind: 'tabs' },
          'plugins.bundle.config': { kind: 'tabs' },
          'plugins.item': { kind: 'keyed' },
          [LEGACY_SLOT]: { kind: 'list' },
        },
      });
      await applyClient(kernel);
      assert.equal(kernel.registrations.length, 0, 'no half-built card is left behind');
      assert.equal(kernel.waits.length, 0, 'nothing is waited on either');
      assert.equal(warnings.filter((message) => /no card slot is available/.test(message)).length, 1);
    } finally {
      console.warn = savedWarn;
    }
  });

  it('keeps one card across a re-entrant apply and unmounts it with the effect', async () => {
    const kernel = fakeKernel({ declared: { 'plugins.row.config': { kind: 'keyed' } } });
    const client = await applyClient(kernel);
    client.apply(kernel);
    assert.equal(kernel.registrations.length, 1, 'the module-level guard keeps the first mount');
    const card = cardHandle(kernel);
    card.unmount();
    assert.equal(kernel.unregistered, 1, 'the effect disposer withdraws the registration');
  });
});

describe('the three card states (§4-D/H3)', () => {
  it('loading: a skeleton — no control pretends to hold a value', async () => {
    const kernel = fakeKernel();
    const card = await mountCard(kernel);
    assert.equal(card.state().status, 'loading');
    assert.equal(card.state().writable, false);
    const tree = card.render();
    assert.ok(hasExactText(tree, 'loading'), 'the skeleton line is rendered');
    for (const type of ['input', 'select', 'textarea']) {
      assert.equal(nodesOfType(tree, type).length, 0, 'a loading card renders no controls at all');
    }
  });

  it('unavailable: fields stay visible but read-only, with the notice on top', async () => {
    const face = { getSnapshot: () => ({ status: 'unavailable', writable: false, value: undefined }) };
    const kernel = fakeKernel({ services: { configForms: { get: () => face } } });
    const card = await mountCard(kernel);
    assert.equal(card.state().status, 'unavailable');
    assert.equal(card.state().writable, false);
    const tree = card.render();
    const sequence = textsOf(tree);
    assert.ok(sequence.includes('settingsUnavailable'), 'the card says the settings surface is missing');
    assert.ok(sequence.indexOf('settingsUnavailable') < sequence.indexOf('groupEngine'), 'the notice sits above the fields');
    const notice = allNodes(tree).find((node) => node.props.role === 'status'
      && node.children.includes('settingsUnavailable'));
    assert.ok(notice, 'the notice carries role=status');
    const baseURL = byId(tree, 'vision-bridge-card-baseURL');
    assert.ok(baseURL !== null, 'the fields are still rendered');
    assert.equal(baseURL.props.disabled, true);
    assert.equal(baseURL.props.value, '', 'an unknown value renders empty, never invented');
    assert.equal(byId(tree, 'vision-bridge-card-mode').props.value, '', 'an off-list select renders empty too');
    const save = nodesOfType(tree, 'button').find((node) => node.children.includes('save'));
    assert.equal(save.props.disabled, true, 'saving is disabled on an unavailable face');
  });

  it('ready: the live values and an enabled save appear', async () => {
    const form = fakeConfigForm({ provider: { baseURL: 'https://vision.example/v1', model: 'm1' }, mode: 'auto' });
    const kernel = fakeKernel({ services: { configForms: form.service } });
    const card = await mountCard(kernel);
    assert.equal(card.state().status, 'ready');
    assert.equal(card.state().writable, true);
    assert.equal(form.listenerCount(), 1, 'the change feed is attached once');
    const tree = card.render();
    assert.equal(byId(tree, 'vision-bridge-card-baseURL').props.value, 'https://vision.example/v1');
    assert.equal(byId(tree, 'vision-bridge-card-mode').props.value, 'auto');
    assert.equal(byId(tree, 'vision-bridge-card-model').props.value, 'm1');
    assert.equal(hasExactText(tree, 'settingsUnavailable'), false);
    assert.equal(hasExactText(tree, 'readOnly'), false);
  });

  it('answers the detail-page summary with the description', async () => {
    const kernel = fakeKernel();
    const card = await mountCard(kernel);
    assert.equal(card.render('summary'), 'description');
  });

  it('re-resolves the face on every operation, so a late service is picked up', async () => {
    const kernel = fakeKernel({ services: {} });
    const card = await mountCard(kernel);
    assert.equal(card.state().status, 'loading');
    const form = fakeConfigForm({ provider: { model: 'late' } });
    kernel.services.configForms = form.service;
    // The store only republishes when something publishes it: the registry's
    // own wake-up poll is what turns a late service into a re-render.
    await new Promise((resolve) => setTimeout(resolve, WAKEUP_MS));
    const tree = card.render();
    assert.equal(card.state().status, 'ready', 'the face was resolved again, not declared away');
    assert.equal(hasExactText(tree, 'loading'), false, 'the card left the skeleton by itself');
    assert.equal(byId(tree, 'vision-bridge-card-model').props.value, 'late');
    card.unmount();
  });
});

describe('the write path (§4-D/H4)', () => {
  it('0.1.7: one write through configForms.mutate, fenced by the snapshot revision', async () => {
    const form = fakeConfigForm({ provider: { model: 'm1' } });
    const kernel = fakeKernel({ services: { configForms: form.service } });
    const card = await mountCard(kernel);
    const revision = card.state().revision ?? card.store.getSnapshot().revision;
    card.props.edit('model', 'qwen2.5-vl');
    assert.equal(byId(card.render(), 'vision-bridge-card-model').props.value, 'qwen2.5-vl', 'the draft is shown');
    card.props.save();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(form.writes.length, 1, 'one atomic write');
    assert.deepEqual(form.writes[0][0], [{ op: 'set', path: ['provider', 'model'], value: 'qwen2.5-vl' }]);
    assert.equal(form.writes[0][1], 1, 'the write carries the revision the card last saw');
    const tree = card.render();
    assert.equal(card.state().failed, false);
    assert.ok(hasExactText(tree, 'savedFlash'), 'a landed save flashes');
    assert.equal(hasText(tree, 'saveRejected'), false);
  });

  it('0.1.7: a refused write surfaces the existing rejection copy', async () => {
    const face = {
      getSnapshot: () => ({ status: 'ready', writable: true, revision: 4, value: { provider: { model: 'm1' } } }),
      mutate: () => false,
      subscribe: () => () => {},
    };
    const kernel = fakeKernel({ services: { configForms: { get: () => face } } });
    const card = await mountCard(kernel);
    card.props.edit('model', 'm2');
    card.props.save();
    await new Promise((resolve) => setImmediate(resolve));
    const tree = card.render();
    assert.equal(card.state().failed, true);
    assert.ok(hasText(tree, 'saveRejected'), 'the refusal reuses the §10 copy');
    assert.equal(hasExactText(tree, 'savedFlash'), false);
  });

  it('0.1.6: settingsScope.bind runs once and mutate takes no revision', async () => {
    const legacy = fakeSettingsScope({ provider: { model: 'legacy-model' } });
    const kernel = fakeKernel({ services: { settingsScope: legacy.service } });
    const card = await mountCard(kernel);
    assert.equal(card.state().status, 'ready');
    assert.deepEqual(legacy.binds, [{ namespace: SETTINGS_NS }], 'the scope is bound once, by namespace');
    assert.equal(byId(card.render(), 'vision-bridge-card-model').props.value, 'legacy-model');
    card.props.edit('model', 'legacy-next');
    card.props.save();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(legacy.writes.length, 1);
    assert.equal(legacy.writes[0].length, 1, 'the 0.1.6 face is called without a revision');
    assert.deepEqual(legacy.writes[0][0], { op: 'set', path: ['provider', 'model'], value: 'legacy-next' });
    assert.deepEqual(legacy.binds.length, 1, 'later operations do not bind again');
  });

  it('prefers the 0.1.7 face when both generations are present', async () => {
    const form = fakeConfigForm({ provider: { model: 'new' } });
    const legacy = fakeSettingsScope({ provider: { model: 'old' } });
    const kernel = fakeKernel({ services: { configForms: form.service, settingsScope: legacy.service } });
    const card = await mountCard(kernel);
    assert.equal(byId(card.render(), 'vision-bridge-card-model').props.value, 'new');
    assert.deepEqual(legacy.binds, [], 'the older generation is never even bound');
    assert.equal(card.state().kind ?? null, null);
  });
});

describe('the credential area without its service (§4-H2②)', () => {
  it('reports the missing service and offers no paste form, keeping the fields', async () => {
    const form = fakeConfigForm({ provider: { baseURL: 'https://vision.example/v1', model: 'm1' } });
    const kernel = fakeKernel({ services: { configForms: form.service } });
    const card = await mountCard(kernel);
    const tree = card.render();
    assert.equal(card.state().status, 'ready', 'the settings face still works');
    assert.equal(card.state().credentialsAvailable, false);
    assert.ok(hasText(tree, 'credentialsUnavailable'), 'the area states the unavailable service');
    assert.equal(byId(tree, 'vision-bridge-card-baseURL').props.value, 'https://vision.example/v1', 'other fields are untouched');
    const options = nodesOfType(tree, 'option').map((node) => node.props.value);
    assert.equal(options.includes('__paste'), false, 'the paste form writes through that service, so it is not offered');
    assert.equal(options.includes('__manual'), true, 'the manual reference form keeps working');
  });

  it('offers the paste form once the credential service answers', async () => {
    const form = fakeConfigForm({ provider: { model: 'm1' } });
    const credentials = { describe: async () => ({ ok: true, value: {} }) };
    const kernel = fakeKernel({ services: { configForms: form.service, 'remote.credentials': credentials } });
    const card = await mountCard(kernel);
    const tree = card.render();
    assert.equal(card.state().credentialsAvailable, true);
    assert.equal(hasText(tree, 'credentialsUnavailable'), false);
    assert.equal(nodesOfType(tree, 'option').map((node) => node.props.value).includes('__paste'), true);
  });

  it('reads the credential service through remote when only remote is provided', async () => {
    const form = fakeConfigForm({ provider: { model: 'm1' } });
    const credentials = { describe: async () => ({ ok: true, value: {} }) };
    const kernel = fakeKernel({ services: { configForms: form.service, remote: { credentials } } });
    const card = await mountCard(kernel);
    assert.equal(card.state().credentialsAvailable, true);
  });
});
describe('§4.6 — the environment check renders the seam rows honestly', () => {
  /** The env payload the card fetches at construction; only `seam` varies. */
  const envPayload = (seam) => ({
    providers: [],
    credentialCandidates: ['VISION_API_KEY'],
    admission: { status: 'unknown', files: [], disk: 'unknown', runtime: 'skipped', reason: 'seam-live', conflict: false },
    seam,
    modlens: { installed: false, paste: 'off', conflict: false },
  });

  // The fetch stub stays installed for the whole test (the connectivity probe
  // runs after mounting) and is withdrawn by the describe-level afterEach.
  let restoreFetch = null;
  afterEach(() => {
    if (restoreFetch !== null) {
      globalThis.fetch = restoreFetch;
      restoreFetch = null;
    }
  });

  async function mountWithEnv(payload, value = { provider: { baseURL: 'https://vision.example/v1', model: 'm1' }, credential: 'VISION_API_KEY', mode: 'both' }, extraServices = {}) {
    if (restoreFetch === null) restoreFetch = globalThis.fetch;
    // Routes by URL so the connectivity probe (POST /vision-bridge/test) can be
    // driven too — the collapsed summary needs connectivityOk.
    globalThis.fetch = async (url) => (String(url).includes('/test')
      ? { ok: true, status: 200, json: async () => ({ ok: true, latencyMs: 7, model: 'm1' }) }
      : { ok: true, status: 200, json: async () => payload });
    const form = fakeConfigForm(value);
    const kernel = fakeKernel({ services: { configForms: form.service, ...extraServices } });
    const card = await mountCard(kernel);
    for (let i = 0; i < 50 && card.state().envStatus !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(card.state().envStatus, 'ready', 'the env payload landed');
    return { card, form };
  }

  /** Drive the connectivity probe and wait for its verdict. */
  async function settleTest(card) {
    card.props.runTest();
    for (let i = 0; i < 50 && card.state().test.status !== 'ok'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(card.state().test.status, 'ok', 'the connectivity probe settled');
  }

  /** The class of the span carrying one row's label key. */
  function labelClass(tree, key) {
    const node = allNodes(tree).find((item) => item.type === 'span'
      && Array.isArray(item.children) && item.children.includes(key));
    return node === undefined ? null : node.props.className;
  }

  it('a live seam is ✓ and the legacy disk row reports the takeover', async () => {
    const { card } = await mountWithEnv(envPayload({ status: 'installed', live: true, reason: 'self-check passed (qax:glm-5.3)', mode: 'auto', include: [], requireReader: true }));
    const tree = card.render();
    assert.equal(labelClass(tree, 'seamLive'), 'dvb-ok');
    assert.equal(labelClass(tree, 'markerOk'), 'dvb-ok');
    assert.equal(labelClass(tree, 'legacySuperseded'), 'dvb-ok', 'no §12 verdict and no fix button while the seam is live');
    assert.equal(hasText(tree, 'fixAdmission'), false, 'nothing left to repair');
  });

  it('installed but not self-proven is NEUTRAL — the exact state that must never show ✓', async () => {
    const { card } = await mountWithEnv(envPayload({ status: 'installed', live: null, reason: 'no included text-only route', mode: 'auto', include: ['zai:x'], requireReader: true, residue: false }));
    const tree = card.render();
    assert.equal(labelClass(tree, 'seamUnproven'), 'dvb-unknown');
    assert.notEqual(labelClass(tree, 'seamUnproven'), 'dvb-ok');
    // F3: not self-proven is NOT a residue — a warning here would contradict row 1.
    assert.equal(hasText(tree, 'markerResidue'), false, 'no contradictory residue warning');
    assert.equal(labelClass(tree, 'markerOk'), 'dvb-ok', 'the marker itself agrees with the installed layer');
    assert.ok(hasText(tree, 'no included text-only route'), 'the raw server reason is shown, not swallowed');
  });

  it('a real residue (server flag) is the only thing that warns on row 2', async () => {
    const { card } = await mountWithEnv(envPayload({ status: 'unsupported', live: null, reason: 'not installed', mode: 'auto', include: [], requireReader: true, residue: true }));
    const tree = card.render();
    assert.equal(labelClass(tree, 'markerResidue'), 'dvb-warn');
    assert.equal(hasText(tree, 'markerResidueHint'), true);
  });

  it('an unsupported seam is ✗ and says why', async () => {
    const { card } = await mountWithEnv(envPayload({ status: 'unsupported', live: null, reason: 'llm service unavailable or has no resolveModelInfo', mode: 'auto', include: [], requireReader: true }));
    const tree = card.render();
    assert.equal(labelClass(tree, 'seamUnsupported'), 'dvb-warn');
    assert.ok(hasText(tree, 'llm service unavailable or has no resolveModelInfo'), 'the reason travels with the ✗');
    assert.equal(labelClass(tree, 'legacySuperseded'), null, 'the disk row keeps its §12 verdict when the seam is not live');
  });

  it('an unconfigured reader states that the hard rejection is by design', async () => {
    const { card } = await mountWithEnv(
      envPayload({ status: 'installed', live: true, reason: 'ok', mode: 'auto', include: [], requireReader: true }),
      { provider: { baseURL: 'https://vision.example/v1', model: 'm1' }, credential: '', mode: 'both' },
    );
    const tree = card.render();
    assert.equal(labelClass(tree, 'readerMissing'), 'dvb-warn');
  });

  it('seam.mode = off reports the seam row and marks the reader row not applicable', async () => {
    const { card } = await mountWithEnv(envPayload({ status: 'off', live: null, reason: 'seam.mode=off', mode: 'off', include: [], requireReader: true }));
    const tree = card.render();
    assert.equal(labelClass(tree, 'seamOff'), 'dvb-unknown');
    assert.equal(labelClass(tree, 'readerOff'), 'dvb-unknown');
  });

  it('requireReader = false is a warning: the seam injects with nobody reading', async () => {
    const { card } = await mountWithEnv(
      envPayload({ status: 'installed', live: true, reason: 'ok', mode: 'auto', include: [], requireReader: false }),
      { provider: { baseURL: 'https://vision.example/v1', model: 'm1' }, credential: 'VISION_API_KEY', mode: 'both' },
    );
    const tree = card.render();
    assert.equal(labelClass(tree, 'readerDisabled'), 'dvb-warn');
  });
  it('F1: a deployment running on the DISK PATCH collapses again when the seam is off', async () => {
    const payload = envPayload({ status: 'off', live: null, reason: 'seam.mode=off', mode: 'off', include: [], requireReader: true, residue: false });
    payload.admission = { status: 'ok', files: [], disk: 'patched', runtime: 'dead', reason: undefined, conflict: false };
    const { card } = await mountWithEnv(payload);
    await settleTest(card);
    const tree = card.render();
    assert.ok(hasText(tree, 'envReady'), 'the working disk-patch path still reaches the ready summary');
    assert.equal(hasText(tree, 'seamOff'), false, 'and the rows are collapsed away');
  });

  it('F1: an unavailable seam on a working disk patch collapses too (reader configured)', async () => {
    const payload = envPayload({ status: 'unsupported', live: null, reason: 'no llm service', mode: 'auto', include: [], requireReader: true, residue: false });
    payload.admission = { status: 'ok', files: [], disk: 'patched', runtime: 'dead', reason: undefined, conflict: false };
    const credentials = { describe: async () => ({ ok: true, value: { VISION_API_KEY: { configured: true } } }) };
    const { card } = await mountWithEnv(payload, undefined, { 'remote.credentials': credentials });
    for (let i = 0; i < 50 && card.state().credentialCheck?.status !== 'ok'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(card.state().credentialCheck?.status, 'ok', 'the credential describe landed');
    await settleTest(card);
    assert.ok(hasText(card.render(), 'envReady'));
  });

  it('F1 guard: an installed-but-unproven seam never collapses, even when the disk patch works', async () => {
    const payload = envPayload({ status: 'installed', live: null, reason: 'self-proof unavailable', mode: 'auto', include: [], requireReader: true, residue: false });
    payload.admission = { status: 'ok', files: [], disk: 'patched', runtime: 'dead', reason: undefined, conflict: false };
    // Review N-B3-1: without a configured reader this case asserted a constant
    // (reader.ok stayed false, so allOk was false under every mutation). Wire the
    // credential check exactly like the twin case above, so dropping !seamUnproven
    // makes this assertion fail instead of silently passing.
    const credentials = { describe: async () => ({ ok: true, value: { VISION_API_KEY: { configured: true } } }) };
    const { card } = await mountWithEnv(payload, undefined, { 'remote.credentials': credentials });
    for (let i = 0; i < 50 && card.state().credentialCheck?.status !== 'ok'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(card.state().credentialCheck?.status, 'ok', 'the credential describe landed');
    await settleTest(card);
    const tree = card.render();
    assert.equal(hasText(tree, 'envReady'), false, 'a neutral seam row may not hide behind the ready line');
    assert.equal(labelClass(tree, 'seamUnproven'), 'dvb-unknown');
  });
});
