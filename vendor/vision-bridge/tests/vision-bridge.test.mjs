import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VisionBridge,
  VISION_CONTEXT_START,
  VISION_CONTEXT_END,
  VISUAL_PRIMITIVES_START,
  VISUAL_PRIMITIVES_END,
} from '../dist/core/vision-bridge.js';
import { mockFn } from './_mock.mjs';

const BASIC_NOTE = [
  'image_overview: A desk screenshot with a red error banner.',
  'user_request_answer: The screenshot shows an error state.',
  'evidence: red banner and visible editor layout.',
  'uncertainty: exact line number is unclear.',
].join('\n');

const pathA = '/tmp/upload-a.png';

function makeAdapter(responseText = BASIC_NOTE) {
  return {
    supportsImages: mockFn(() => true),
    call: mockFn(async () => responseText),
  };
}

function makeBridge(adapter = makeAdapter(), capsResolver, maxCacheEntries = 256) {
  return new VisionBridge({
    adapter,
    config: {
      visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
      visionCapabilitiesResolver: capsResolver ?? (() => null),
    },
    maxCacheEntries,
  });
}

describe('VisionBridge', () => {
  describe('needsBridge', () => {
    it('returns true for text-only model', () => {
      const bridge = makeBridge();
      assert.equal(bridge.needsBridge({ id: 'deepseek-chat', provider: 'deepseek', input: ['text'] }), true);
    });

    it('returns false for vision-capable model', () => {
      const bridge = makeBridge();
      assert.equal(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] }), false);
    });

    it('returns false for model without input array', () => {
      const bridge = makeBridge();
      assert.equal(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai' }), false);
    });
  });

  describe('analyze', () => {
    it('does nothing for image-capable target models', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const result = await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: 'what is this?',
        targetModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      });
      assert.equal(adapter.call.mock.calls.length, 0);
      assert.ok(result.images);
    });

    it('analyzes text-only model images and returns vision notes', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const result = await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      assert.equal(adapter.call.mock.calls.length, 1);
      assert.equal(result.images, undefined);
      assert.equal(result.visionNotes.length, 1);
      assert.match(result.visionNotes[0], /image_overview/);
    });

    it('throws when vision model does not support images', async () => {
      const adapter = makeAdapter();
      adapter.supportsImages = mockFn(() => false);
      const bridge = new VisionBridge({
        adapter,
        config: { visionModel: { id: 'broken', provider: 'test' } },
      });
      await assert.rejects(
        bridge.analyze({
          images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
          userRequest: 'what?',
          targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        }),
        /must support image input/i,
      );
    });

    it('reuses cached analysis for same image + same request', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' };
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: /tmp/other.png]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: ['/tmp/other.png'],
      });
      assert.equal(adapter.call.mock.calls.length, 1);
    });

    it('does not reuse cached analysis for different user request', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' };
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: ${pathA}]\nhow many kittens?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: /tmp/other.png]\nwhat color?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: ['/tmp/other.png'],
      });
      assert.equal(adapter.call.mock.calls.length, 2);
    });
  });

  describe('injectIntoMessages', () => {
    it('injects vision context into user messages with attached image markers', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat is this?` }] },
      ]);
      assert.equal(result.injected, 1);
      const text = result.messages[0].content[0].text;
      assert.match(text, new RegExp(VISION_CONTEXT_START));
      assert.match(text, /image_overview/);
      assert.match(text, new RegExp(VISION_CONTEXT_END));
    });

    it('injects only into the user message that has an image marker', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nfirst question`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nfirst question` }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
      ]);
      assert.equal(result.injected, 1);
      assert.match(result.messages[0].content[0].text, new RegExp(VISION_CONTEXT_START));
      assert.equal(result.messages[2].content[0].text, 'follow-up');
    });

    it('does not double-inject when VISION_CONTEXT already present', () => {
      const bridge = makeBridge();
      const result = bridge.injectIntoMessages([
        { role: 'user', content: `${VISION_CONTEXT_START}\nold note\n${VISION_CONTEXT_END}\n\ntext` },
      ]);
      assert.equal(result.injected, 0);
    });
  });

  describe('disk persistence', () => {
    const tmpDirs = [];
    function makeDir() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
      tmpDirs.push(dir);
      return dir;
    }
    afterEach(() => {
      for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
      tmpDirs.length = 0;
    });

    it('restores vision notes from disk after bridge is gone', async () => {
      const dir = makeDir();
      const sessionId = path.join(dir, 'session');
      const imagePath = path.join(dir, 'upload.png');
      const adapter = makeAdapter();
      const b1 = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          persistDir: dir,
        },
      });
      await b1.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${imagePath}]\nwhat?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [imagePath],
        sessionId,
      });
      const b2 = new VisionBridge({
        adapter: { supportsImages: () => true, call: mockFn() },
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          persistDir: dir,
        },
      });
      const result = b2.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${imagePath}]\nwhat?` }] },
      ], sessionId);
      assert.equal(result.injected, 1);
      assert.match(result.messages[0].content[0].text, new RegExp(VISION_CONTEXT_START));
    });
  });

  describe('grounding: structured mode', () => {
    it('routes Gemini models through box_2d format', async () => {
      const adapter = {
        supportsImages: () => true,
        call: mockFn(async () => JSON.stringify({
          image_overview: 'A UI screenshot.',
          visual_primitives: [{ id: 'banner', type: 'box', label: 'red error banner', box_2d: [100, 200, 180, 760], confidence: 0.92 }],
        })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gemini-flash', provider: 'gemini', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: false, boxOrder: 'yxyx', outputFormat: 'gemini', groundingMode: 'native' }),
        },
      });
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhere is error?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhere is error?` }] },
      ]);
      const text = result.messages[0].content[0].text;
      assert.match(text, new RegExp(VISUAL_PRIMITIVES_START));
      // yxyx [100,200,180,760] -> xyxy [200,100,760,180]
      assert.match(text, /box:\s*\[200,\s*100,\s*760,\s*180\]/);
      assert.match(text, /red error banner/);
      assert.match(text, new RegExp(VISUAL_PRIMITIVES_END));
    });

    it('routes Qwen models through bbox_2d + point_2d format', async () => {
      const adapter = {
        supportsImages: () => true,
        call: mockFn(async () => JSON.stringify({
          image_overview: 'A settings screen.',
          visual_primitives: [
            { id: 'save', label: 'save button', bbox_2d: [710, 820, 930, 890], confidence: 0.84 },
            { id: 'toggle', label: 'theme toggle', point_2d: [320, 240], confidence: 0.77 },
          ],
        })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'qwen', groundingMode: 'native' }),
        },
      });
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhere to save?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhere to save?` }] },
      ]);
      const text = result.messages[0].content[0].text;
      assert.match(text, /box: \[710, 820, 930, 890\]/);
      assert.match(text, /point: \[320, 240\]/);
    });

    it('routes anchor format for computer-use models', async () => {
      const adapter = {
        supportsImages: () => true,
        call: mockFn(async () => JSON.stringify({
          image_overview: 'A browser page.',
          visual_anchors: [{ id: 'submit', label: 'submit button', role: 'button', center: [840, 310], confidence: 0.71 }],
        })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'claude-sonnet', provider: 'anthropic', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted' }),
        },
      });
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat to click?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat to click?` }] },
      ]);
      const text = result.messages[0].content[0].text;
      assert.match(text, /point: \[840, 310\]/);
      assert.match(text, /grounding: prompted/);
    });

    it('keeps unavailable primitive block when no coordinates returned', async () => {
      const adapter = {
        supportsImages: () => true,
        call: mockFn(async () => JSON.stringify({ image_overview: 'A document.', visual_primitives: [] })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted' }),
        },
      });
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is on screen?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat is on screen?` }] },
      ]);
      const text = result.messages[0].content[0].text;
      assert.match(text, new RegExp(VISUAL_PRIMITIVES_START));
      assert.match(text, /grounding="unavailable"/);
    });

    it('uses note-only routing for models without grounding capability', async () => {
      const adapter = {
        supportsImages: () => true,
        call: mockFn(async () => 'image_overview: basic note analysis'),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'kimi', provider: 'kimi', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => null,
        },
      });
      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat?` }] },
      ]);
      const text = result.messages[0].content[0].text;
      assert.match(text, /image_overview: basic note analysis/);
      assert.doesNotMatch(text, new RegExp(VISUAL_PRIMITIVES_START));
    });
  });
});
