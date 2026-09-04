import { describe, it, expect } from 'vitest';
import { buildBasicPrompt, buildStructuredPrompt, primitivePromptShape } from '../src/core/prompts.js';
import type { VisionCapabilities } from '../src/core/types.js';

describe('buildBasicPrompt', () => {
  it('includes user request in the prompt', () => {
    const { system, user } = buildBasicPrompt('analyze this error');
    expect(system).toContain('Analyze this image');
    expect(system).toContain('image_overview');
    expect(system).toContain('visible_text');
    expect(system).toContain('user_request_answer');
    expect(user).toContain('analyze this error');
  });

  it('handles empty user request', () => {
    const { user } = buildBasicPrompt('');
    expect(user).toContain('(no explicit text request)');
  });
});

describe('primitivePromptShape', () => {
  it('returns hanako format by default', () => {
    const shape = primitivePromptShape();
    expect(shape[0]).toContain('visual_primitives');
    expect(shape[2]).toContain('box');
  });

  it('returns gemini format with box_2d and yxyx order', () => {
    const shape = primitivePromptShape({ boxOrder: 'yxyx', outputFormat: 'gemini' } as VisionCapabilities);
    expect(shape[0]).toContain('box_2d');
    expect(shape[2]).toContain('[ymin, xmin, ymax, xmax]');
  });

  it('returns qwen format with bbox_2d and point_2d', () => {
    const shape = primitivePromptShape({ outputFormat: 'qwen' } as VisionCapabilities);
    expect(shape[0]).toContain('bbox_2d');
    expect(shape[0]).toContain('point_2d');
  });

  it('returns anchor format with visual_anchors', () => {
    const shape = primitivePromptShape({ outputFormat: 'anchor' } as VisionCapabilities);
    expect(shape[0]).toContain('visual_anchors');
    expect(shape[0]).toContain('center');
  });
});

describe('buildStructuredPrompt', () => {
  it('includes all required JSON fields', () => {
    const { system } = buildStructuredPrompt('find the error', { boxes: true } as VisionCapabilities);
    expect(system).toContain('image_overview');
    expect(system).toContain('visible_text');
    expect(system).toContain('objects_and_layout');
    expect(system).toContain('user_request_answer');
    expect(system).toContain('evidence');
    expect(system).toContain('uncertainty');
    expect(system).toContain('Return only one valid JSON object');
  });

  it('includes point instruction when visionCapabilities has points', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: true } as VisionCapabilities);
    expect(system).toContain('include point or center coordinates');
  });

  it('excludes point instruction when no points support', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: false } as VisionCapabilities);
    expect(system).toContain('Do not output point primitives');
  });
});
