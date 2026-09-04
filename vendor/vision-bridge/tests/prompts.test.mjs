import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBasicPrompt, buildStructuredPrompt, primitivePromptShape } from '../dist/core/prompts.js';

describe('buildBasicPrompt', () => {
  it('includes user request in the prompt', () => {
    const { system, user } = buildBasicPrompt('analyze this error');
    assert.match(system, /Analyze this image/);
    assert.match(system, /image_overview/);
    assert.match(system, /visible_text/);
    assert.match(system, /user_request_answer/);
    assert.match(user, /analyze this error/);
  });

  it('handles empty user request', () => {
    const { user } = buildBasicPrompt('');
    assert.match(user, /\(no explicit text request\)/);
  });
});

describe('primitivePromptShape', () => {
  it('returns hanako format by default', () => {
    const shape = primitivePromptShape();
    assert.match(shape[0], /visual_primitives/);
    assert.match(shape[2], /box/);
  });

  it('returns gemini format with box_2d and yxyx order', () => {
    const shape = primitivePromptShape({ boxOrder: 'yxyx', outputFormat: 'gemini' });
    assert.match(shape[0], /box_2d/);
    assert.match(shape[2], /\[ymin, xmin, ymax, xmax\]/);
  });

  it('returns qwen format with bbox_2d and point_2d', () => {
    const shape = primitivePromptShape({ outputFormat: 'qwen' });
    assert.match(shape[0], /bbox_2d/);
    assert.match(shape[0], /point_2d/);
  });

  it('returns anchor format with visual_anchors', () => {
    const shape = primitivePromptShape({ outputFormat: 'anchor' });
    assert.match(shape[0], /visual_anchors/);
    assert.match(shape[0], /center/);
  });
});

describe('buildStructuredPrompt', () => {
  it('includes all required JSON fields', () => {
    const { system } = buildStructuredPrompt('find the error', { boxes: true });
    assert.match(system, /image_overview/);
    assert.match(system, /visible_text/);
    assert.match(system, /objects_and_layout/);
    assert.match(system, /user_request_answer/);
    assert.match(system, /evidence/);
    assert.match(system, /uncertainty/);
    assert.match(system, /Return only one valid JSON object/);
  });

  it('includes point instruction when visionCapabilities has points', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: true });
    assert.match(system, /include point or center coordinates/);
  });

  it('excludes point instruction when no points support', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: false });
    assert.match(system, /Do not output point primitives/);
  });
});
