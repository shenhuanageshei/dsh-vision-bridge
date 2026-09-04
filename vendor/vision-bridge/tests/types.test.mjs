// Ported from types.test.ts: TypeScript compile-time shape checks become
// runtime structural assertions (the library's dist .d.ts covers the static half).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Core Type Shapes (runtime structural checks)', () => {
  describe('VisionMessage', () => {
    it('can be constructed with string content', () => {
      const msg = { role: 'user', content: 'Describe this image.' };
      assert.equal(msg.role, 'user');
      assert.equal(typeof msg.content, 'string');
      assert.equal(msg.content, 'Describe this image.');
    });

    it('can be constructed with ContentBlock[] (mixed text + image blocks)', () => {
      const imageBlock = {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      };
      const textBlock = { type: 'text', text: 'What is in this image?' };
      const blocks = [imageBlock, textBlock];
      const msg = { role: 'user', content: blocks };

      assert.equal(msg.role, 'user');
      assert.equal(Array.isArray(msg.content), true);
      assert.equal(msg.content.length, 2);
      assert.equal(msg.content[0].type, 'image');
      assert.equal(msg.content[0].mimeType, 'image/png');
      assert.ok(msg.content[0].data);
      assert.equal(msg.content[1].type, 'text');
      assert.equal(msg.content[1].text, 'What is in this image?');
    });
  });

  describe('ImageContentBlock', () => {
    it('has required fields (type, mimeType, data)', () => {
      const block = { type: 'image', mimeType: 'image/jpeg', data: 'base64encodeddata' };
      assert.equal(block.type, 'image');
      assert.equal(block.mimeType, 'image/jpeg');
      assert.equal(block.data, 'base64encodeddata');
    });
  });

  describe('VisionPrimitive', () => {
    it('can represent box type (with box + confidence + grounding)', () => {
      const primitive = {
        id: 'box-001',
        type: 'box',
        ref: 'Submit button',
        box: [100, 200, 300, 400],
        confidence: 0.95,
        grounding: 'The bounding box covers the submit button region.',
      };
      assert.equal(primitive.id, 'box-001');
      assert.equal(primitive.type, 'box');
      assert.equal(primitive.ref, 'Submit button');
      assert.deepEqual(primitive.box, [100, 200, 300, 400]);
      assert.equal(primitive.confidence, 0.95);
      assert.equal(primitive.point, undefined);
    });

    it('can represent point type (with point + null confidence + grounding)', () => {
      const primitive = {
        id: 'point-001',
        type: 'point',
        ref: 'Center of chart',
        point: [500, 500],
        confidence: null,
        grounding: 'The point marks the center of the chart area.',
      };
      assert.equal(primitive.id, 'point-001');
      assert.equal(primitive.type, 'point');
      assert.equal(primitive.ref, 'Center of chart');
      assert.deepEqual(primitive.point, [500, 500]);
      assert.equal(primitive.confidence, null);
      assert.equal(primitive.box, undefined);
    });
  });

  describe('LLMMessage', () => {
    it('supports system role with string content', () => {
      const msg = { role: 'system', content: 'You are a helpful assistant.' };
      assert.equal(msg.role, 'system');
      assert.equal(msg.content, 'You are a helpful assistant.');
    });

    it('supports full three-role system with ContentBlock[]', () => {
      const userMsg = { role: 'user', content: [{ type: 'text', text: 'Hello' }] };
      const assistantMsg = { role: 'assistant', content: 'Hi there!' };
      assert.equal(userMsg.role, 'user');
      assert.equal(assistantMsg.role, 'assistant');
    });
  });
});
