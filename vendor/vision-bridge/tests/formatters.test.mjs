import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStructuredVisionNote,
  formatVisualPrimitives,
  formatInvalidStructuredNote,
  normalizePrimitive,
  normalizeBox,
  normalizePoint,
  safeSection,
} from '../dist/core/formatters.js';

describe('safeSection', () => {
  it('returns string value as-is', () => {
    assert.equal(safeSection('hello'), 'hello');
  });

  it('returns fallback for empty', () => {
    assert.equal(safeSection(''), 'none');
    assert.equal(safeSection(undefined), 'none');
  });

  it('joins array values with semicolons', () => {
    assert.equal(safeSection(['a', 'b', 'c']), 'a; b; c');
  });
});

describe('normalizeBox', () => {
  it('normalizes xyxy ordered box', () => {
    assert.deepEqual(normalizeBox([100, 200, 300, 400]), [100, 200, 300, 400]);
  });

  it('normalizes yxyx ordered box to xyxy', () => {
    assert.deepEqual(normalizeBox([200, 100, 400, 300], { boxOrder: 'yxyx' }), [100, 200, 300, 400]);
  });

  it('swaps coordinates when left > right', () => {
    assert.deepEqual(normalizeBox([300, 200, 100, 400]), [100, 200, 300, 400]);
  });

  it('returns null for zero-area box', () => {
    assert.equal(normalizeBox([100, 200, 100, 400]), null);
  });

  it('returns null for invalid input', () => {
    assert.equal(normalizeBox([100]), null);
    assert.equal(normalizeBox(undefined), null);
  });
});

describe('normalizePoint', () => {
  it('normalizes a point', () => {
    assert.deepEqual(normalizePoint([500, 600]), [500, 600]);
  });

  it('returns null for invalid input', () => {
    assert.equal(normalizePoint([100]), null);
    assert.equal(normalizePoint(undefined), null);
  });

  it('clamps to 0-1000', () => {
    assert.deepEqual(normalizePoint([-10, 1500]), [0, 1000]);
  });
});

describe('normalizePrimitive', () => {
  const caps = { boxes: true, points: true, boxOrder: 'xyxy' };

  it('normalizes box primitive', () => {
    const raw = { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.9 };
    const result = normalizePrimitive(raw, 0, caps);
    assert.deepEqual(
      { id: result.id, type: result.type, ref: result.ref, box: result.box },
      { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400] },
    );
    assert.equal(result.confidence, 0.9);
  });

  it('normalizes point primitive', () => {
    const raw = { id: 'p1', label: 'cursor', point: [500, 600] };
    const result = normalizePrimitive(raw, 0, { ...caps, boxes: false });
    assert.deepEqual(
      { id: result.id, type: result.type, ref: result.ref, point: result.point },
      { id: 'p1', type: 'point', ref: 'cursor', point: [500, 600] },
    );
  });

  it('returns null when no box or point', () => {
    const raw = { id: 'v1', label: 'nothing' };
    assert.equal(normalizePrimitive(raw, 0, { boxes: false, points: false }), null);
  });

  it('uses fallback id from index', () => {
    const raw = { ref: 'thing', box: [10, 20, 30, 40] };
    const result = normalizePrimitive(raw, 2, caps);
    assert.equal(result.id, 'v3');
  });
});

describe('formatVisualPrimitives', () => {
  it('formats primitives with coord info', () => {
    const primitives = [
      { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.95, grounding: 'native' },
      { id: 'v2', type: 'point', ref: 'cursor', point: [500, 600], confidence: null, grounding: 'prompted' },
    ];
    const result = formatVisualPrimitives(primitives, 'native');
    assert.match(result, /<visual-primitives coord="norm-1000" box_order="xyxy" grounding="native">/);
    assert.match(result, /v1 \| type: box \| box: \[100, 200, 300, 400\]/);
    assert.match(result, /v2 \| type: point \| point: \[500, 600\]/);
    assert.match(result, /<\/visual-primitives>/);
  });

  it('formats empty primitives with unavailable grounding', () => {
    const result = formatVisualPrimitives([], 'unavailable');
    assert.match(result, /reason: no valid coordinates/);
  });
});

describe('formatStructuredVisionNote', () => {
  it('formats a complete analysis into a note string', () => {
    const analysis = {
      image_overview: 'A settings dialog',
      visible_text: ['Save', 'Cancel'],
      objects_and_layout: 'Two buttons at bottom',
      charts_or_data: 'none',
      user_request: 'where is Save?',
      user_request_answer: 'Bottom right corner',
      evidence: 'Button labeled "Save" visible',
      uncertainty: 'Dialog may be modal',
      visual_primitives: [
        { id: 'v1', type: 'box', ref: 'Save button', box: [700, 800, 900, 850], confidence: 0.88 },
      ],
    };
    const result = formatStructuredVisionNote(analysis, { boxes: true, boxOrder: 'xyxy' });
    assert.match(result, /image_overview: A settings dialog/);
    assert.match(result, /visible_text: Save; Cancel/);
    assert.match(result, /user_request_answer: Bottom right corner/);
    assert.match(result, /<visual-primitives/);
    assert.match(result, /v1 \| type: box \| box: \[700, 800, 900, 850\]/);
  });
});

describe('formatInvalidStructuredNote', () => {
  it('returns fallback note with unavailable primitives', () => {
    const result = formatInvalidStructuredNote('garbled response {');
    assert.match(result, /structured vision analysis unavailable/);
    assert.match(result, /garbled response \{/);
    assert.match(result, /grounding="unavailable"/);
  });
});
