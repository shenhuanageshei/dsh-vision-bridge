import { describe, it, expect } from 'vitest';
import type {
  VisionMessage,
  ContentBlock,
  ImageContentBlock,
  TextContentBlock,
  VisionPrimitive,
  LLMMessage,
  VisionModelRef,
  VisionCapabilities,
  StructuredAnalysis,
  AnalyzeParams,
  AnalyzeResult,
  InjectResult,
  CacheEntry,
  VisionBridgeConfig,
} from '../src/core/types.js';

describe('Core Type Definitions', () => {
  describe('VisionMessage', () => {
    it('can be constructed with string content', () => {
      const msg: VisionMessage = {
        role: 'user',
        content: 'Describe this image.',
      };

      expect(msg.role).toBe('user');
      expect(typeof msg.content).toBe('string');
      expect(msg.content).toBe('Describe this image.');
    });

    it('can be constructed with ContentBlock[] (mixed text + image blocks)', () => {
      const imageBlock: ImageContentBlock = {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      };

      const textBlock: TextContentBlock = {
        type: 'text',
        text: 'What is in this image?',
      };

      const blocks: ContentBlock[] = [imageBlock, textBlock];

      const msg: VisionMessage = {
        role: 'user',
        content: blocks,
      };

      expect(msg.role).toBe('user');
      expect(Array.isArray(msg.content)).toBe(true);

      const contentBlocks = msg.content as ContentBlock[];
      expect(contentBlocks).toHaveLength(2);

      const firstBlock = contentBlocks[0] as ImageContentBlock;
      expect(firstBlock.type).toBe('image');
      expect(firstBlock.mimeType).toBe('image/png');
      expect(firstBlock.data).toBeTruthy();

      const secondBlock = contentBlocks[1] as TextContentBlock;
      expect(secondBlock.type).toBe('text');
      expect(secondBlock.text).toBe('What is in this image?');
    });
  });

  describe('ImageContentBlock', () => {
    it('has required fields (type, mimeType, data)', () => {
      const block: ImageContentBlock = {
        type: 'image',
        mimeType: 'image/jpeg',
        data: 'base64encodeddata',
      };

      expect(block.type).toBe('image');
      expect(block.mimeType).toBe('image/jpeg');
      expect(block.data).toBe('base64encodeddata');
    });
  });

  describe('VisionPrimitive', () => {
    it('can represent box type (with box + confidence + grounding)', () => {
      const primitive: VisionPrimitive = {
        id: 'box-001',
        type: 'box',
        ref: 'Submit button',
        box: [100, 200, 300, 400],
        confidence: 0.95,
        grounding: 'The bounding box covers the submit button region.',
      };

      expect(primitive.id).toBe('box-001');
      expect(primitive.type).toBe('box');
      expect(primitive.ref).toBe('Submit button');
      expect(primitive.box).toEqual([100, 200, 300, 400]);
      expect(primitive.confidence).toBe(0.95);
      expect(primitive.grounding).toBe('The bounding box covers the submit button region.');
      // Box primitives should not have a point
      expect(primitive.point).toBeUndefined();
    });

    it('can represent point type (with point + null confidence + grounding)', () => {
      const primitive: VisionPrimitive = {
        id: 'point-001',
        type: 'point',
        ref: 'Center of chart',
        point: [500, 500],
        confidence: null,
        grounding: 'The point marks the center of the chart area.',
      };

      expect(primitive.id).toBe('point-001');
      expect(primitive.type).toBe('point');
      expect(primitive.ref).toBe('Center of chart');
      expect(primitive.point).toEqual([500, 500]);
      expect(primitive.confidence).toBeNull();
      expect(primitive.grounding).toBe('The point marks the center of the chart area.');
      // Point primitives should not have a box
      expect(primitive.box).toBeUndefined();
    });
  });

  describe('LLMMessage', () => {
    it('supports system role with string content', () => {
      const msg: LLMMessage = {
        role: 'system',
        content: 'You are a helpful assistant.',
      };

      expect(msg.role).toBe('system');
      expect(msg.content).toBe('You are a helpful assistant.');
    });

    it('supports full three-role system with ContentBlock[]', () => {
      const userMsg: LLMMessage = {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      };

      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: 'Hi there!',
      };

      expect(userMsg.role).toBe('user');
      expect(assistantMsg.role).toBe('assistant');
    });
  });
});
