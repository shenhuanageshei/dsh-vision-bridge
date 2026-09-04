import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VisionBridge } from '../dist/index.js';
import { mockFn } from './_mock.mjs';

const pathA = '/tmp/upload-a.png';

describe('VisionBridge integration', () => {
  it('full analyze -> inject round-trip with default marker parser', async () => {
    const adapter = {
      supportsImages: () => true,
      call: mockFn(async () => [
        'image_overview: Terminal screenshot showing npm install errors.',
        'visible_text: ERR! code ENOENT',
        'user_request_answer: The package.json file is missing.',
        'evidence: Error text clearly visible.',
      ].join('\n')),
    };

    const bridge = new VisionBridge({
      adapter,
      config: { visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] } },
    });

    // Phase 1: analyze
    const result = await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: `[attached_image: ${pathA}]\nanalyze this error`,
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
      imagePaths: [pathA],
    });

    assert.equal(result.images, undefined);
    assert.equal(result.visionNotes.length, 1);
    assert.match(result.visionNotes[0], /image_overview/);

    // Phase 2: inject
    const injected = bridge.injectIntoMessages([
      { role: 'user', content: `[attached_image: ${pathA}]\nanalyze this error` },
    ]);

    assert.equal(injected.injected, 1);
    const content = injected.messages[0].content;
    assert.match(typeof content === 'string' ? content : '', /image_overview: Terminal screenshot/);
  });

  it('gracefully handles empty user request', async () => {
    const adapter = {
      supportsImages: () => true,
      call: mockFn(async () => 'image_overview: A blank screen.\nuser_request_answer: nothing actionable.'),
    };

    const bridge = new VisionBridge({
      adapter,
      config: { visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] } },
    });

    await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: '',
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
    });

    assert.equal(adapter.call.mock.calls.length, 1);
  });

  it('multiple images produce multiple notes', async () => {
    let callCount = 0;
    const adapter = {
      supportsImages: () => true,
      call: mockFn(async () => {
        callCount++;
        return `image_overview: Image ${callCount} description.`;
      }),
    };

    const bridge = new VisionBridge({
      adapter,
      config: { visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] } },
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

    assert.equal(result.visionNotes.length, 2);
    assert.equal(adapter.call.mock.calls.length, 2);
  });

  it('passes through images for vision-capable target models', async () => {
    const adapter = { supportsImages: () => true, call: mockFn() };

    const bridge = new VisionBridge({
      adapter,
      config: { visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] } },
    });

    const img = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    const result = await bridge.analyze({
      images: [img],
      userRequest: 'what is this?',
      targetModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
    });

    assert.equal(adapter.call.mock.calls.length, 0);
    assert.ok(result.images); // image passed through
  });
});
