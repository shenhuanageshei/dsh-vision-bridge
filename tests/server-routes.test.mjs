import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  appendModlensOverride,
  classifyTestFailure,
  credentialCandidateRefs,
  findModlensOverride,
  installServerRoutes,
  looksLikePatchList,
  projectProviders,
} from '../lib/server-routes.js';
import { ADMISSION_PATCH_MARKER, admissionPatchTargets, detectAdmissionPatch } from '../scripts/patch-admission-gate.mjs';

// Server-route unit tests (design §11.6 matrix): the four routes are mounted
// on a fake webServer and their handlers invoked directly with Readable
// requests / capture responses; the engine's HTTP hop is stubbed through
// globalThis.fetch (the wrapper reads it per request), the modlens loopback
// probe through deps.fetchImpl, and every file-touching test (admission
// patch, modlens override) runs inside a mkdtemp directory — the real
// <PROFILE_PATCH> (profiles/web/cordis.patch.yml) is NEVER written.

const ROUTE_TEST = '/vision-bridge/test';
const ROUTE_ENV = '/vision-bridge/env';
const ROUTE_FIX_ADMISSION = '/vision-bridge/fix-admission';
const ROUTE_FIX_MODLENS = '/vision-bridge/fix-modlens';
const ROUTE_PATHS = [ROUTE_TEST, ROUTE_ENV, ROUTE_FIX_ADMISSION, ROUTE_FIX_MODLENS];

/** Unpatched admission gate source containing COND_A verbatim. */
const UNPATCHED_GATE = [
  'function admissionGate(model) {',
  '  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image")) {',
  '    return "reject";',
  '  }',
  '  return "accept";',
  '}',
  '',
].join('\n');

const SETTINGS_DOC = {
  providers: {
    'zai-coding-cn': {
      apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
      models: [
        { id: 'glm-5.3-flash', input: ['text', 'image'] },
        { id: 'glm-5.3', input: ['text'] },
      ],
    },
    qax: {
      baseURL: 'https://qax.example/v1',
      apiKeyEnv: 'QAX_KEY',
      models: [
        { id: 'q-plus', name: 'Q Plus', input: ['text', 'image'] },
        { id: 'q-tiny' },
      ],
    },
    broken: 'not-an-object',
  },
};

const PROJECTED_PROVIDERS = [
  {
    id: 'zai-coding-cn',
    baseURL: '',
    apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    models: [
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash', vision: true },
      { id: 'glm-5.3', name: 'glm-5.3', vision: false },
    ],
  },
  {
    id: 'qax',
    baseURL: 'https://qax.example/v1',
    apiKeyEnv: 'QAX_KEY',
    models: [
      { id: 'q-plus', name: 'Q Plus', vision: true },
      { id: 'q-tiny', name: 'q-tiny', vision: false },
    ],
  },
];

/** A request double: async-iterable body (node stream semantics) + method. */
function makeReq(method, bodyObj) {
  const stream = bodyObj === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(bodyObj), 'utf8')]);
  stream.method = method;
  return stream;
}

/** A response double capturing status / headers / body. */
function makeRes() {
  const captured = { status: 0, headers: undefined, body: '' };
  const res = {
    writeHead(code, headers) {
      captured.status = code;
      captured.headers = headers;
      return res;
    },
    end(text) {
      captured.body = text === undefined ? '' : String(text);
      return res;
    },
  };
  return { res, captured };
}

/** Mount the routes on a fake webServer and expose the handlers. */
function createHarness(deps = {}) {
  const routes = new Map();
  const webServer = {
    port: 45999,
    host: '127.0.0.1',
    register({ name, kind, path, handler }) {
      assert.equal(kind, 'exact', 'routes must register as exact matches');
      routes.set(path, { name, handler });
      return () => { routes.delete(path); };
    },
  };
  const dispose = installServerRoutes({ webServer }, deps);
  return {
    routes,
    dispose,
    handler(path) {
      assert.ok(routes.has(path), `route ${path} must be registered`);
      return routes.get(path).handler;
    },
  };
}

/** Deterministic clock for latency assertions: steps[0] at start, steps[1] after. */
function fakeClock(steps = [1000, 1025]) {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)];
}

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dvb-server-routes-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the two admission-gate target files under a temp node_modules root. */
function writeGateFiles(nodeModulesDir, content) {
  for (const file of admissionPatchTargets(nodeModulesDir)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
}

/** Stub fetch answering one successful OpenAI-shaped completion. */
function okFetch(capture) {
  return async (url, init) => {
    if (capture) capture.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
}

/** Stub fetch answering an HTTP error status (adapter throws "OpenAI API error N: text"). */
function httpErrorFetch(status, text = 'stub error body') {
  return async () => ({ ok: false, status, text: async () => text });
}

/** Stub fetch rejecting like an aborted request (the engine timeout shape). */
function abortFetch() {
  return async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  };
}

function baseTestDeps(overrides = {}) {
  return {
    getConfig: () => ({
      provider: { baseURL: 'https://engine.example/v1', model: 'stub-vlm', credential: 'STUB_REF' },
      timeoutMs: 60000,
    }),
    resolveCredentialByName: async (name) => {
      if (name === 'STUB_REF') return 'sk-stored';
      throw new Error('vision bridge: credential "' + name + '" is not configured.');
    },
    settingsGet: () => undefined,
    listLoadedPlugins: () => [],
    ...overrides,
  };
}

/** Swap globalThis.fetch for the duration of one handler call. */
async function withFetchStub(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('installServerRoutes — mounting', () => {
  it('throws when the scope carries no usable webServer', () => {
    assert.throws(() => installServerRoutes({}, {}), /requires a webServer scope/);
    assert.throws(() => installServerRoutes({ webServer: {} }, {}), /requires a webServer scope/);
    assert.throws(() => installServerRoutes({ webServer: { register: 'not-a-fn' } }, {}), /requires a webServer scope/);
  });

  it('registers the four exact routes; the disposer removes them all', () => {
    const harness = createHarness(baseTestDeps());
    try {
      assert.deepEqual([...harness.routes.keys()].sort(), [...ROUTE_PATHS].sort());
      assert.deepEqual(
        [...harness.routes.values()].map((route) => route.name).sort(),
        ['vision-bridge-env', 'vision-bridge-fix-admission', 'vision-bridge-fix-modlens', 'vision-bridge-test'],
      );
    } finally {
      harness.dispose();
    }
    assert.equal(harness.routes.size, 0, 'every route must be disposed');
  });
});

describe('projectProviders — llm-pi-ai projection (§11.2-1 / §11.6 §11.5-2)', () => {
  it('projects id + baseURL + apiKeyEnv + models with the vision flag', () => {
    assert.deepEqual(projectProviders((ns) => (ns === 'llm-pi-ai' ? SETTINGS_DOC : undefined)), PROJECTED_PROVIDERS);
  });

  it('projects the empty string for a provider without a readable baseURL (risk #12)', () => {
    const providers = projectProviders(() => SETTINGS_DOC);
    assert.equal(providers.find((p) => p.id === 'zai-coding-cn').baseURL, '');
    assert.equal(providers.find((p) => p.id === 'qax').baseURL, 'https://qax.example/v1');
  });

  it('drops malformed providers and models; models without input project vision false', () => {
    assert.deepEqual(projectProviders(() => SETTINGS_DOC).find((p) => p.id === 'qax').models, [
      { id: 'q-plus', name: 'Q Plus', vision: true },
      { id: 'q-tiny', name: 'q-tiny', vision: false },
    ]);
    assert.ok(projectProviders(() => SETTINGS_DOC).every((p) => p.id !== 'broken'));
  });

  it('empty / missing / non-object / throwing providers → [] (the card offers only custom)', () => {
    assert.deepEqual(projectProviders(() => undefined), []);
    assert.deepEqual(projectProviders(() => ({})), []);
    assert.deepEqual(projectProviders(() => ({ providers: [] })), []);
    assert.deepEqual(projectProviders(() => ({ providers: 'nope' })), []);
    assert.deepEqual(projectProviders(() => { throw new Error('boom'); }), []);
    assert.deepEqual(projectProviders(() => ({ providers: {} })), []);
  });
});

describe('credentialCandidateRefs — dropdown source list (§11.3C)', () => {
  it('collects provider apiKeyEnvs, the current config ref, and VISION_API_KEY (deduped, ordered)', () => {
    assert.deepEqual(
      credentialCandidateRefs(PROJECTED_PROVIDERS, { provider: { credential: 'QAX_KEY' } }),
      ['ZAI_CODING_CN_API_KEY', 'QAX_KEY', 'VISION_API_KEY'],
    );
    assert.deepEqual(
      credentialCandidateRefs(PROJECTED_PROVIDERS, { provider: { credential: 'MY_REF' } }),
      ['ZAI_CODING_CN_API_KEY', 'QAX_KEY', 'MY_REF', 'VISION_API_KEY'],
    );
  });

  it('works without a config: envs + the shared default', () => {
    assert.deepEqual(
      credentialCandidateRefs(PROJECTED_PROVIDERS, undefined),
      ['ZAI_CODING_CN_API_KEY', 'QAX_KEY', 'VISION_API_KEY'],
    );
  });
});

describe('classifyTestFailure — probe error codes (§11.6 §11.5-5)', () => {
  it('maps 401/403 to auth', () => {
    assert.equal(classifyTestFailure(new Error('OpenAI API error 401: bad key')), 'auth');
    assert.equal(classifyTestFailure(new Error('OpenAI API error 403: forbidden')), 'auth');
  });

  it('maps 404 to endpoint', () => {
    assert.equal(classifyTestFailure(new Error('OpenAI API error 404: no route')), 'endpoint');
  });

  it('maps aborts and timeouts to timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    assert.equal(classifyTestFailure(abort), 'timeout');
    assert.equal(classifyTestFailure(new Error('request timed out')), 'timeout');
    assert.equal(classifyTestFailure(new Error('signal is aborted without reason')), 'timeout');
  });

  it('maps anything else to unknown', () => {
    assert.equal(classifyTestFailure(new Error('ECONNREFUSED')), 'unknown');
    assert.equal(classifyTestFailure(undefined), 'unknown');
  });
});

describe('POST /vision-bridge/test — connectivity probe (§11.3D / §11.6 §11.5-5)', () => {
  it('rejects non-POST with 405', async () => {
    const harness = createHarness(baseTestDeps());
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_TEST)(makeReq('GET'), res);
      assert.equal(captured.status, 405);
      assert.equal(captured.body, '');
    } finally {
      harness.dispose();
    }
  });

  it('answers ok with the measured latency and the probe model', async () => {
    const calls = [];
    await withFetchStub(okFetch(calls), async () => {
      const harness = createHarness(baseTestDeps({ now: fakeClock() }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_TEST)(makeReq('POST', {}), res);
        assert.equal(captured.status, 200);
        assert.equal(captured.headers['content-type'], 'application/json');
        const body = JSON.parse(captured.body);
        assert.equal(body.ok, true);
        assert.equal(body.latencyMs, 25);
        assert.equal(body.model, 'stub-vlm');
        assert.equal(calls.length, 1, 'exactly one round trip');
        assert.ok(calls[0].url.endsWith('/chat/completions'));
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports a 401 endpoint answer as error code auth', async () => {
    await withFetchStub(httpErrorFetch(401, 'Unauthorized'), async () => {
      const harness = createHarness(baseTestDeps({ now: fakeClock() }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_TEST)(makeReq('POST', {}), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'auth');
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports a 404 endpoint answer as error code endpoint', async () => {
    await withFetchStub(httpErrorFetch(404, 'Not Found'), async () => {
      const harness = createHarness(baseTestDeps({ now: fakeClock() }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_TEST)(makeReq('POST', {}), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'endpoint');
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports an aborted engine call as error code timeout', async () => {
    await withFetchStub(abortFetch(), async () => {
      const harness = createHarness(baseTestDeps({ now: fakeClock() }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_TEST)(makeReq('POST', {}), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, 'timeout');
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports an unresolvable credential as error code auth (no engine call)', async () => {
    const harness = createHarness(baseTestDeps({
      now: fakeClock(),
      resolveCredentialByName: async () => { throw new Error('vision bridge: credential "STUB_REF" is not configured.'); },
    }));
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_TEST)(makeReq('POST', {}), res);
      assert.equal(captured.status, 200);
      const body = JSON.parse(captured.body);
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'auth');
    } finally {
      harness.dispose();
    }
  });

  it('uses a pendingApiKey transiently: resolver untouched, key sent once, never echoed', async () => {
    let resolverCalls = 0;
    let seenAuthorization = null;
    let fetchCalls = 0;
    await withFetchStub(async (url, init) => {
      fetchCalls += 1;
      seenAuthorization = init?.headers?.Authorization;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    }, async () => {
      const harness = createHarness(baseTestDeps({
        now: fakeClock(),
        resolveCredentialByName: async () => { resolverCalls += 1; return 'sk-stored'; },
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_TEST)(makeReq('POST', { pendingApiKey: 'sk-transient-999' }), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.ok, true);
        assert.equal(resolverCalls, 0, 'the transient key bypasses the resolver');
        assert.equal(seenAuthorization, 'Bearer sk-transient-999', 'the pending key authorizes the one engine call');
        assert.equal(fetchCalls, 1);
        assert.equal(captured.body.includes('sk-transient-999'), false, 'the key is never echoed');
      } finally {
        harness.dispose();
      }
    });
  });

  it('rejects a non-http(s) draft baseURL with 400', async () => {
    const harness = createHarness(baseTestDeps());
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_TEST)(makeReq('POST', { baseURL: 'not-a-url' }), res);
      assert.equal(captured.status, 400);
      assert.ok(captured.body.includes('baseURL'));
    } finally {
      harness.dispose();
    }
  });
});

describe('GET /vision-bridge/env — providers + environment checks (§11.3E)', () => {
  function envDeps(overrides = {}) {
    return {
      settingsGet: () => SETTINGS_DOC,
      getConfig: () => ({ provider: { credential: 'MY_REF' } }),
      listLoadedPlugins: () => ['@dsh-external/dsh-vision-bridge'],
      fetchImpl: async () => ({ status: 404 }),
      ...overrides,
    };
  }

  it('rejects non-GET with 405', async () => {
    const harness = createHarness(envDeps());
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_ENV)(makeReq('POST'), res);
      assert.equal(captured.status, 405);
    } finally {
      harness.dispose();
    }
  });

  it('returns the providers projection, credential candidates, admission ok, modlens off', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE + '/* ' + ADMISSION_PATCH_MARKER + ' stub */\n');
      const seenNamespaces = [];
      const seenUrls = [];
      const harness = createHarness(envDeps({
        nodeModulesDir: dir,
        settingsGet: (ns) => { seenNamespaces.push(ns); return SETTINGS_DOC; },
        fetchImpl: async (url) => { seenUrls.push(String(url)); return { status: 404 }; },
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.deepEqual(body.providers, PROJECTED_PROVIDERS);
        assert.deepEqual(body.credentialCandidates, ['ZAI_CODING_CN_API_KEY', 'QAX_KEY', 'MY_REF', 'VISION_API_KEY']);
        assert.equal(body.admission.status, 'ok');
        assert.deepEqual(body.admission.files.map((f) => f.status), ['ok', 'ok']);
        assert.deepEqual(body.modlens, { installed: false, paste: 'off', conflict: false });
        assert.deepEqual(seenNamespaces, ['llm-pi-ai'], 'only the llm-pi-ai namespace is read');
        assert.ok(seenUrls[0].includes('/modlens/paste?model='), 'the loopback probe hits the modlens paste route');
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports admission missing when the gate files carry no marker', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE);
      const harness = createHarness(envDeps({ nodeModulesDir: dir }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        const body = JSON.parse(captured.body);
        assert.equal(body.admission.status, 'missing');
        assert.deepEqual(body.admission.files.map((f) => f.status), ['missing', 'missing']);
      } finally {
        harness.dispose();
      }
    });
  });

  it('reports admission unknown when the core-package files are absent', async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness(envDeps({ nodeModulesDir: join(dir, 'no-such-node-modules') }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        const body = JSON.parse(captured.body);
        assert.equal(body.admission.status, 'unknown');
      } finally {
        harness.dispose();
      }
    });
  });

  it('flags the modlens conflict only when installed AND the paste route answers 200', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, 'x');
      const harness = createHarness(envDeps({
        nodeModulesDir: dir,
        listLoadedPlugins: () => ['@liustack/modlens', '@dsh-external/dsh-vision-bridge'],
        fetchImpl: async () => ({ status: 200 }),
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        const body = JSON.parse(captured.body);
        assert.deepEqual(body.modlens, { installed: true, paste: 'active', conflict: true });
      } finally {
        harness.dispose();
      }
    });
  });

  it('installed + route 404 → no conflict (paste takeover already off)', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, 'x');
      const harness = createHarness(envDeps({
        nodeModulesDir: dir,
        listLoadedPlugins: () => ['@liustack/modlens'],
        fetchImpl: async () => ({ status: 404 }),
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        const body = JSON.parse(captured.body);
        assert.deepEqual(body.modlens, { installed: true, paste: 'off', conflict: false });
      } finally {
        harness.dispose();
      }
    });
  });

  it('a failing probe reads as unknown without a conflict', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, 'x');
      const harness = createHarness(envDeps({
        nodeModulesDir: dir,
        listLoadedPlugins: () => ['@liustack/modlens'],
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        const body = JSON.parse(captured.body);
        assert.deepEqual(body.modlens, { installed: true, paste: 'unknown', conflict: false });
      } finally {
        harness.dispose();
      }
    });
  });

  it('still answers 200 when the config source fails (health panel degrades)', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, 'x');
      const harness = createHarness(envDeps({
        nodeModulesDir: dir,
        getConfig: () => { throw new Error('no config'); },
      }));
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_ENV)(makeReq('GET'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.deepEqual(body.credentialCandidates, ['ZAI_CODING_CN_API_KEY', 'QAX_KEY', 'VISION_API_KEY']);
      } finally {
        harness.dispose();
      }
    });
  });
});

describe('POST /vision-bridge/fix-admission — idempotent patch re-apply (§11.3E)', () => {
  it('rejects non-POST with 405', async () => {
    const harness = createHarness({ nodeModulesDir: 'unused' });
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_FIX_ADMISSION)(makeReq('GET'), res);
      assert.equal(captured.status, 405);
    } finally {
      harness.dispose();
    }
  });

  it('applies the patch, backs up, and reports applied + needsRestart', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE);
      const harness = createHarness({ nodeModulesDir: dir });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_ADMISSION)(makeReq('POST'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.applied, true);
        assert.equal(body.alreadyPatched, false);
        assert.equal(body.failed, false);
        assert.equal(body.needsRestart, true);
        for (const entry of body.files) {
          assert.equal(entry.status, 'patched');
          const content = readFileSync(entry.file, 'utf8');
          assert.ok(content.includes(ADMISSION_PATCH_MARKER), 'the marker is on disk');
          assert.ok(content.includes('false /*'), 'the gate condition became false');
          const backup = readFileSync(entry.file + '.bak-vision-bridge', 'utf8');
          assert.equal(backup, UNPATCHED_GATE, 'the pre-patch backup keeps the original');
        }
        // the disk state now detects as ok
        assert.equal(detectAdmissionPatch(dir).status, 'ok');
      } finally {
        harness.dispose();
      }
    });
  });

  it('second call is idempotent: every file skipped, alreadyPatched reported', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE);
      const harness = createHarness({ nodeModulesDir: dir });
      try {
        await harness.handler(ROUTE_FIX_ADMISSION)(makeReq('POST'), makeRes().res);
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_ADMISSION)(makeReq('POST'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.applied, false);
        assert.equal(body.alreadyPatched, true);
        assert.equal(body.needsRestart, true);
        for (const entry of body.files) assert.equal(entry.status, 'skipped');
      } finally {
        harness.dispose();
      }
    });
  });
});

describe('detectAdmissionPatch — marker detection true/false/unknown (§11.2-4 / §11.6 §11.5-6)', () => {
  it('true: every target carrying the marker reads ok', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE + '/* ' + ADMISSION_PATCH_MARKER + ' stub */\n');
      const result = detectAdmissionPatch(dir);
      assert.equal(result.status, 'ok');
      assert.ok(result.files.every((f) => f.status === 'ok'));
    });
  });

  it('false: readable targets without the marker read missing', async () => {
    await withTempDir(async (dir) => {
      writeGateFiles(dir, UNPATCHED_GATE);
      const result = detectAdmissionPatch(dir);
      assert.equal(result.status, 'missing');
      assert.ok(result.files.every((f) => f.status === 'missing'));
    });
  });

  it('unknown: absent targets read unknown', async () => {
    await withTempDir(async (dir) => {
      const result = detectAdmissionPatch(join(dir, 'absent'));
      assert.equal(result.status, 'unknown');
      assert.ok(result.files.every((f) => f.status === 'unknown'));
    });
  });
});

describe('POST /vision-bridge/fix-modlens — idempotent override append (§11.3E)', () => {
  // Every test runs against a mkdtemp cordis.patch.yml — the REAL profile
  // patch (<PROFILE_PATCH>) is never touched by this suite.

  it('rejects non-POST with 405', async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({ profilePatchPath: join(dir, 'cordis.patch.yml') });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('GET'), res);
        assert.equal(captured.status, 405);
      } finally {
        harness.dispose();
      }
    });
  });

  it('appends the override row to a list-shaped document and reports applied', async () => {
    await withTempDir(async (dir) => {
      const patch = join(dir, 'cordis.patch.yml');
      writeFileSync(patch, '- insert:\n  - id: vision-bridge\n', 'utf8');
      const harness = createHarness({ profilePatchPath: patch });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.applied, true);
        assert.equal(body.alreadyPatched, false);
        assert.equal(body.needsRestart, true);
        assert.equal(body.path, patch);
        const after = readFileSync(patch, 'utf8');
        assert.ok(after.startsWith('- insert:\n  - id: vision-bridge\n'), 'the original rows are preserved');
        assert.ok(after.includes('- id: modlens'));
        assert.ok(after.includes('pasteToPath: false'));
        assert.ok(findModlensOverride(after), 'the written document self-detects');
      } finally {
        harness.dispose();
      }
    });
  });

  it('a second call is a byte-identical no-op (alreadyPatched)', async () => {
    await withTempDir(async (dir) => {
      const patch = join(dir, 'cordis.patch.yml');
      writeFileSync(patch, '- insert:\n  - id: vision-bridge\n', 'utf8');
      const harness = createHarness({ profilePatchPath: patch });
      try {
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), makeRes().res);
        const afterFirst = readFileSync(patch, 'utf8');
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
        assert.equal(captured.status, 200);
        const body = JSON.parse(captured.body);
        assert.equal(body.applied, false);
        assert.equal(body.alreadyPatched, true);
        assert.equal(readFileSync(patch, 'utf8'), afterFirst, 'the file is untouched');
      } finally {
        harness.dispose();
      }
    });
  });

  it('a hand-written override row already present → skipped, file untouched', async () => {
    await withTempDir(async (dir) => {
      const patch = join(dir, 'cordis.patch.yml');
      const original = '# manual fix\n- id: modlens\n  config:\n    pasteToPath: false\n';
      writeFileSync(patch, original, 'utf8');
      const harness = createHarness({ profilePatchPath: patch });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
        const body = JSON.parse(captured.body);
        assert.equal(body.applied, false);
        assert.equal(body.alreadyPatched, true);
        assert.equal(readFileSync(patch, 'utf8'), original);
      } finally {
        harness.dispose();
      }
    });
  });

  it('refuses a non-list document (risk #14): 500 and the original untouched', async () => {
    await withTempDir(async (dir) => {
      const patch = join(dir, 'cordis.patch.yml');
      const original = 'plugins:\n  - id: x\n';
      writeFileSync(patch, original, 'utf8');
      const harness = createHarness({ profilePatchPath: patch });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
        assert.equal(captured.status, 500);
        assert.ok(captured.body.includes('unexpected document structure'));
        assert.equal(readFileSync(patch, 'utf8'), original);
      } finally {
        harness.dispose();
      }
    });
  });

  it('an unreadable patch path answers 500 without touching anything', async () => {
    await withTempDir(async (dir) => {
      const harness = createHarness({ profilePatchPath: join(dir, 'does-not-exist.yml') });
      try {
        const { res, captured } = makeRes();
        await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
        assert.equal(captured.status, 500);
        assert.ok(captured.body.includes('could not read'));
      } finally {
        harness.dispose();
      }
    });
  });

  it('a missing path configuration answers 500 (no dshHome-derived default)', async () => {
    const harness = createHarness({});
    try {
      const { res, captured } = makeRes();
      await harness.handler(ROUTE_FIX_MODLENS)(makeReq('POST'), res);
      assert.equal(captured.status, 500);
      assert.ok(captured.body.includes('profile patch path is not configured'));
    } finally {
      harness.dispose();
    }
  });
});

describe('modlens override helpers (unit)', () => {
  it('findModlensOverride: detects the row in plain, quoted, and comment forms', () => {
    assert.equal(findModlensOverride('- id: modlens\n  config:\n    pasteToPath: false\n'), true);
    assert.equal(findModlensOverride("- id: 'modlens'\n  config:\n    pasteToPath: false # off\n"), true);
    assert.equal(findModlensOverride('- id: modlens # comment\n  config:\n    pasteToPath: false\n'), true);
    assert.equal(findModlensOverride('- id: "modlens"\n  config:\n    pasteToPath: false\n'), true);
  });

  it('findModlensOverride: nested list items inside the entry do not end it', () => {
    assert.equal(findModlensOverride('- id: modlens\n  insert:\n    - one\n    - two\n  config:\n    pasteToPath: false\n'), true);
  });

  it('findModlensOverride: false for other ids, absent keys, or pasteToPath not false', () => {
    assert.equal(findModlensOverride('- id: other\n  config:\n    pasteToPath: false\n'), false);
    assert.equal(findModlensOverride('- id: modlens\n  config:\n    pasteToPath: true\n'), false);
    assert.equal(findModlensOverride('- id: modlens\n'), false);
    assert.equal(findModlensOverride(''), false);
    assert.equal(findModlensOverride(undefined), false);
  });

  it('looksLikePatchList: only list rows, continuations, comments, separators', () => {
    assert.equal(looksLikePatchList('- insert: [{id: a}]\n- id: b\n'), true);
    assert.equal(looksLikePatchList('  - id: indented\n'), true);
    assert.equal(looksLikePatchList('# comment\n\n---\n'), true);
    assert.equal(looksLikePatchList(''), true);
    assert.equal(looksLikePatchList('plugins:\n  - id: x\n'), false);
    assert.equal(looksLikePatchList('key: value\n'), false);
  });

  it('appendModlensOverride: newline hygiene and block content', () => {
    const block = appendModlensOverride('');
    assert.ok(block.startsWith('# modlens paste-to-path off'));
    assert.ok(block.includes('- id: modlens'));
    assert.ok(block.includes('pasteToPath: false'));
    assert.ok(block.endsWith('\n'));
    assert.equal(appendModlensOverride('x'), 'x\n' + block);
    assert.equal(appendModlensOverride('x\n'), 'x\n' + block);
    // the appended document self-detects and stays list-shaped
    assert.equal(findModlensOverride(appendModlensOverride('- id: a\n')), true);
    assert.equal(looksLikePatchList(appendModlensOverride('- id: a\n')), true);
  });
});
