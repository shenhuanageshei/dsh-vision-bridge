import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisionBridge, VISION_CONTEXT_START, VISION_CONTEXT_END, VISUAL_PRIMITIVES_START, VISUAL_PRIMITIVES_END } from '../src/core/vision-bridge.js';
import type { LLMAdapter } from '../src/adapters/types.js';
import type { VisionCapabilitiesResolver } from '../src/core/vision-bridge.js';

const BASIC_NOTE = [
  'image_overview: A desk screenshot with a red error banner.',
  'user_request_answer: The screenshot shows an error state.',
  'evidence: red banner and visible editor layout.',
  'uncertainty: exact line number is unclear.',
].join('\n');

const pathA = '/tmp/upload-a.png';

function makeAdapter(responseText = BASIC_NOTE): LLMAdapter {
  return {
    supportsImages: vi.fn(() => true),
    call: vi.fn(async () => responseText),
  };
}

function makeBridge(
  adapter: LLMAdapter = makeAdapter(),
  capsResolver?: VisionCapabilitiesResolver,
  maxCacheEntries = 256,
) {
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
      expect(bridge.needsBridge({ id: 'deepseek-chat', provider: 'deepseek', input: ['text'] })).toBe(true);
    });

    it('returns false for vision-capable model', () => {
      const bridge = makeBridge();
      expect(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] })).toBe(false);
    });

    it('returns false for model without input array', () => {
      const bridge = makeBridge();
      expect(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai' })).toBe(false);
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
      expect(adapter.call).not.toHaveBeenCalled();
      expect(result.images).toBeDefined();
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
      expect(adapter.call).toHaveBeenCalledTimes(1);
      expect(result.images).toBeUndefined();
      expect(result.visionNotes).toHaveLength(1);
      expect(result.visionNotes[0]).toContain('image_overview');
    });

    it('throws when vision model does not support images', async () => {
      const adapter = makeAdapter();
      adapter.supportsImages = vi.fn(() => false);
      const bridge = new VisionBridge({
        adapter,
        config: { visionModel: { id: 'broken', provider: 'test' } },
      });
      await expect(bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: 'what?',
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
      })).rejects.toThrow(/must support image input/i);
    });

    it('reuses cached analysis for same image + same request', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const img = { type: 'image' as const, mimeType: 'image/png', data: 'BASE64' };
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
      expect(adapter.call).toHaveBeenCalledTimes(1);
    });

    it('does not reuse cached analysis for different user request', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const img = { type: 'image' as const, mimeType: 'image/png', data: 'BASE64' };
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
      expect(adapter.call).toHaveBeenCalledTimes(2);
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
      expect(result.injected).toBe(1);
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISION_CONTEXT_START);
      expect(text).toContain('image_overview');
      expect(text).toContain(VISION_CONTEXT_END);
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
      expect(result.injected).toBe(1);
      expect((result.messages[0].content as any)[0].text).toContain(VISION_CONTEXT_START);
      expect((result.messages[2].content as any)[0].text).toBe('follow-up');
    });

    it('does not double-inject when VISION_CONTEXT already present', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const result = bridge.injectIntoMessages([
        { role: 'user', content: `${VISION_CONTEXT_START}\nold note\n${VISION_CONTEXT_END}\n\ntext` },
      ]);
      expect(result.injected).toBe(0);
    });
  });

  describe('disk persistence', () => {
    const tmpDirs: string[] = [];
    function makeDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
      tmpDirs.push(dir);
      return dir;
    }
    afterEach(() => {
      for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true }); }
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
        adapter: { supportsImages: () => true, call: vi.fn() },
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          persistDir: dir,
        },
      });
      const result = b2.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${imagePath}]\nwhat?` }] },
      ], sessionId);
      expect(result.injected).toBe(1);
      expect((result.messages[0].content as any)[0].text).toContain(VISION_CONTEXT_START);
    });
  });

  describe('grounding: structured mode', () => {
    it('routes Gemini models through box_2d format', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A UI screenshot.',
          visual_primitives: [{ id: 'banner', type: 'box', label: 'red error banner', box_2d: [100, 200, 180, 760], confidence: 0.92 }],
        })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gemini-flash', provider: 'gemini', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: false, boxOrder: 'yxyx', outputFormat: 'gemini', groundingMode: 'native' } as any),
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
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISUAL_PRIMITIVES_START);
      // yxyx [100,200,180,760] -> xyxy [200,100,760,180]
      expect(text).toMatch(/box:\s*\[200,\s*100,\s*760,\s*180\]/);
      expect(text).toContain('red error banner');
    });

    it('routes Qwen models through bbox_2d + point_2d format', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
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
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'qwen', groundingMode: 'native' } as any),
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
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('box: [710, 820, 930, 890]');
      expect(text).toContain('point: [320, 240]');
    });

    it('routes anchor format for computer-use models', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A browser page.',
          visual_anchors: [{ id: 'submit', label: 'submit button', role: 'button', center: [840, 310], confidence: 0.71 }],
        })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'claude-sonnet', provider: 'anthropic', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted' } as any),
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
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('point: [840, 310]');
      expect(text).toContain('grounding: prompted');
    });

    it('keeps unavailable primitive block when no coordinates returned', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({ image_overview: 'A document.', visual_primitives: [] })),
      };
      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({ boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted' } as any),
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
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISUAL_PRIMITIVES_START);
      expect(text).toContain('grounding="unavailable"');
    });

    it('uses note-only routing for models without grounding capability', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => 'image_overview: basic note analysis'),
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
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('image_overview: basic note analysis');
      expect(text).not.toContain(VISUAL_PRIMITIVES_START);
    });
  });
});
