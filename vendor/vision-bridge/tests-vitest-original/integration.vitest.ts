import { describe, it, expect, vi } from 'vitest';
import { VisionBridge } from '../src/index.js';
import type { LLMAdapter } from '../src/index.js';

const pathA = '/tmp/upload-a.png';

describe('VisionBridge integration', () => {
  it('full analyze -> inject round-trip with default marker parser', async () => {
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => [
        'image_overview: Terminal screenshot showing npm install errors.',
        'visible_text: ERR! code ENOENT',
        'user_request_answer: The package.json file is missing.',
        'evidence: Error text clearly visible.',
      ].join('\n')),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    // Phase 1: analyze
    const result = await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: `[attached_image: ${pathA}]\nanalyze this error`,
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
      imagePaths: [pathA],
    });

    expect(result.images).toBeUndefined();
    expect(result.visionNotes).toHaveLength(1);
    expect(result.visionNotes[0]).toContain('image_overview');

    // Phase 2: inject
    const injected = bridge.injectIntoMessages([
      { role: 'user', content: `[attached_image: ${pathA}]\nanalyze this error` },
    ]);

    expect(injected.injected).toBe(1);
    const content = injected.messages[0].content;
    expect(typeof content === 'string' ? content : '').toContain('image_overview: Terminal screenshot');
  });

  it('gracefully handles empty user request', async () => {
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => 'image_overview: A blank screen.\nuser_request_answer: nothing actionable.'),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: '',
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
    });

    expect(adapter.call).toHaveBeenCalledTimes(1);
  });

  it('multiple images produce multiple notes', async () => {
    let callCount = 0;
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => {
        callCount++;
        return `image_overview: Image ${callCount} description.`;
      }),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    const result = await bridge.analyze({
      images: [
        { type: 'image', mimeType: 'image/png', data: 'IMG1' },
        { type: 'image', mimeType: 'image/png', data: 'IMG2' },
      ],
      userRequest: 'compare these',
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
    });

    expect(result.visionNotes).toHaveLength(2);
    expect(adapter.call).toHaveBeenCalledTimes(2);
  });

  it('passes through images for vision-capable target models', async () => {
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    const img = { type: 'image' as const, mimeType: 'image/png', data: 'AAAA' };
    const result = await bridge.analyze({
      images: [img],
      userRequest: 'what is this?',
      targetModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
    });

    expect(adapter.call).not.toHaveBeenCalled();
    expect(result.images).toBeDefined(); // image passed through
  });
});
