// Real-call smoke test (methodology: 冒烟测试真实调用一次).
// Opt-in — skipped unless every VISION_BRIDGE_SMOKE_* variable is set:
//   VISION_BRIDGE_SMOKE=1
//   VISION_BRIDGE_SMOKE_BASEURL=https://.../v1   (OpenAI-compatible)
//   VISION_BRIDGE_SMOKE_MODEL=<multimodal model id>
//   VISION_BRIDGE_SMOKE_KEY=<api key>            (test-only injection; the
//   plugin itself never reads process.env — this harness stubs the credential
//   service with it)
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const enabled = process.env.VISION_BRIDGE_SMOKE === '1'
  && !!process.env.VISION_BRIDGE_SMOKE_BASEURL
  && !!process.env.VISION_BRIDGE_SMOKE_MODEL
  && !!process.env.VISION_BRIDGE_SMOKE_KEY;

// 1x1 red PNG
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('smoke: real VLM call (opt-in)', { skip: !enabled }, () => {
  it('vision_bridge_read answers a question about a real image', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbb-smoke-'));
    tmpDirs.push(dir);
    const ctx = {
      logger: () => ({ info() {}, warn() {}, error() {} }),
      on(name, handler) { return () => {}; },
      effect(fn) { return fn(); },
      tools: { register: (def) => def },
      systemPrompt: { context: () => () => {} },
      settings: {
        register(ns, schema, options = {}) {
          return {
            get: () => schema(options.base ?? {}),
            watch: () => () => {},
          };
        },
        get: () => undefined,
      },
      credentials: {
        async resolve() {
          return { value: process.env.VISION_BRIDGE_SMOKE_KEY, source: 'smoke-env' };
        },
      },
      attachments: {
        async readImageRequest(ref, _policy, _signal) {
          return {
            variantId: 'smoke',
            attachment: ref,
            data: new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64')),
            mediaType: 'image/png',
            width: 1,
            height: 1,
          };
        },
      },
      registered: { tools: [] },
    };
    // capture the tool by intercepting registration
    let tool;
    ctx.tools.register = (def) => { tool = def; return () => {}; };

    const disposer = await apply(ctx, {
      provider: {
        baseURL: process.env.VISION_BRIDGE_SMOKE_BASEURL,
        model: process.env.VISION_BRIDGE_SMOKE_MODEL,
      },
      credential: 'SMOKE_KEY',
      timeoutMs: 60000,
      cache: { persistDir: path.join(dir, 'cache') },
    });
    try {
      assert.ok(tool, 'tool must be registered');
      const ID = 'sha256:' + 'ab'.repeat(32);
      const value = await tool.execute(
        { ref: 'abababab', question: 'What color is this image? Answer in one word.' },
        {
          agent: {
            session: {
              snapshotEvents: () => [{
                type: 'user/message', seq: 1, time: 1,
                data: { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: ID, mediaType: 'image/png', bytes: 100, width: 1, height: 1 } }] },
              }],
            },
          },
          signal: new AbortController().signal,
        },
      );
      assert.match(value, /UNTRUSTED EVIDENCE/);
      assert.ok(value.length > 40, 'a real note should carry substance');
      console.log('smoke note:\n' + value.slice(0, 400));
    } finally {
      await disposer();
    }
  });
});
