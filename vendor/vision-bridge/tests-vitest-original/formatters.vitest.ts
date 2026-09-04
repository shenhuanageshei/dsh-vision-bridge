import { describe, it, expect } from 'vitest';
import {
  formatStructuredVisionNote,
  formatVisualPrimitives,
  formatInvalidStructuredNote,
  normalizePrimitive,
  normalizeBox,
  normalizePoint,
  safeSection,
} from '../src/core/formatters.js';
import type { VisionCapabilities, VisionPrimitive, StructuredAnalysis } from '../src/core/types.js';

describe('safeSection', () => {
  it('returns string value as-is', () => {
    expect(safeSection('hello')).toBe('hello');
  });

  it('returns fallback for empty', () => {
    expect(safeSection('')).toBe('none');
    expect(safeSection(undefined)).toBe('none');
  });

  it('joins array values with semicolons', () => {
    expect(safeSection(['a', 'b', 'c'])).toBe('a; b; c');
  });
});

describe('normalizeBox', () => {
  it('normalizes xyxy ordered box', () => {
    expect(normalizeBox([100, 200, 300, 400])).toEqual([100, 200, 300, 400]);
  });

  it('normalizes yxyx ordered box to xyxy', () => {
    expect(normalizeBox([200, 100, 400, 300], { boxOrder: 'yxyx' } as VisionCapabilities)).toEqual([100, 200, 300, 400]);
  });

  it('swaps coordinates when left > right', () => {
    expect(normalizeBox([300, 200, 100, 400])).toEqual([100, 200, 300, 400]);
  });

  it('returns null for zero-area box', () => {
    expect(normalizeBox([100, 200, 100, 400])).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(normalizeBox([100])).toBeNull();
    expect(normalizeBox(undefined as any)).toBeNull();
  });
});

describe('normalizePoint', () => {
  it('normalizes a point', () => {
    expect(normalizePoint([500, 600])).toEqual([500, 600]);
  });

  it('returns null for invalid input', () => {
    expect(normalizePoint([100])).toBeNull();
    expect(normalizePoint(undefined as any)).toBeNull();
  });

  it('clamps to 0-1000', () => {
    expect(normalizePoint([-10, 1500])).toEqual([0, 1000]);
  });
});

describe('normalizePrimitive', () => {
  const caps: VisionCapabilities = { boxes: true, points: true, boxOrder: 'xyxy' };

  it('normalizes box primitive', () => {
    const raw: Record<string, unknown> = { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.9 };
    const result = normalizePrimitive(raw, 0, caps);
    expect(result).toMatchObject({ id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400] });
    expect(result!.confidence).toBe(0.9);
  });

  it('normalizes point primitive', () => {
    const raw: Record<string, unknown> = { id: 'p1', label: 'cursor', point: [500, 600] };
    const result = normalizePrimitive(raw, 0, { ...caps, boxes: false });
    expect(result).toMatchObject({ id: 'p1', type: 'point', ref: 'cursor', point: [500, 600] });
  });

  it('returns null when no box or point', () => {
    const raw: Record<string, unknown> = { id: 'v1', label: 'nothing' };
    expect(normalizePrimitive(raw, 0, { boxes: false, points: false } as VisionCapabilities)).toBeNull();
  });

  it('uses fallback id from index', () => {
    const raw: Record<string, unknown> = { ref: 'thing', box: [10, 20, 30, 40] };
    const result = normalizePrimitive(raw, 2, caps);
    expect(result!.id).toBe('v3');
  });
});

describe('formatVisualPrimitives', () => {
  it('formats primitives with coord info', () => {
    const primitives: VisionPrimitive[] = [
      { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.95, grounding: 'native' },
      { id: 'v2', type: 'point', ref: 'cursor', point: [500, 600], confidence: null, grounding: 'prompted' },
    ];
    const result = formatVisualPrimitives(primitives, 'native');
    expect(result).toContain('<visual-primitives coord="norm-1000" box_order="xyxy" grounding="native">');
    expect(result).toContain('v1 | type: box | box: [100, 200, 300, 400]');
    expect(result).toContain('v2 | type: point | point: [500, 600]');
    expect(result).toContain('</visual-primitives>');
  });

  it('formats empty primitives with unavailable grounding', () => {
    const result = formatVisualPrimitives([], 'unavailable');
    expect(result).toContain('reason: no valid coordinates');
  });
});

describe('formatStructuredVisionNote', () => {
  it('formats a complete analysis into a note string', () => {
    const analysis: StructuredAnalysis = {
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
    const result = formatStructuredVisionNote(analysis, { boxes: true, boxOrder: 'xyxy' } as VisionCapabilities);
    expect(result).toContain('image_overview: A settings dialog');
    expect(result).toContain('visible_text: Save; Cancel');
    expect(result).toContain('user_request_answer: Bottom right corner');
    expect(result).toContain('<visual-primitives');
    expect(result).toContain('v1 | type: box | box: [700, 800, 900, 850]');
  });
});

describe('formatInvalidStructuredNote', () => {
  it('returns fallback note with unavailable primitives', () => {
    const result = formatInvalidStructuredNote('garbled response {');
    expect(result).toContain('structured vision analysis unavailable');
    expect(result).toContain('garbled response {');
    expect(result).toContain('grounding="unavailable"');
  });
});
