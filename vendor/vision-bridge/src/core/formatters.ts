import { clampNorm, normalizeConfidence } from './utils.js';
import type { VisionCapabilities, VisionPrimitive, StructuredAnalysis } from './types.js';

// --- constants ---

const MAX_NOTE_CHARS = 3200;
const MAX_PRIMITIVE_REF_CHARS = 96;
const MAX_VISUAL_PRIMITIVES = 16;

// --- section helpers ---

/**
 * Format a section value for inclusion in a structured vision note.
 * - Returns the fallback string when the value is missing or empty.
 * - Joins array entries with "; ".
 */
export function safeSection(
  value: string | string[] | undefined,
  fallback = 'none',
): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.join('; ');
  return String(value);
}

/**
 * Truncate text to a maximum length, appending a "[truncated]" marker.
 */
export function truncate(text: string, max = MAX_NOTE_CHARS): string {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}\n[truncated]`;
}

// --- coordinate normalization ---

/**
 * Normalize a box / bounding-box to canonical xyxy form clamped to 0-1000.
 *
 * - Accepts xyxy [x1, y1, x2, y2] or yxyx [y1, x1, y2, x2] (when
 *   capabilities.boxOrder === 'yxyx').
 * - Swaps coordinates so left < right and top < bottom.
 * - Rejects zero-area boxes (left == right or top == bottom).
 * - Returns null for any invalid input.
 */
export function normalizeBox(
  rawBox: unknown,
  capabilities?: VisionCapabilities,
): number[] | null {
  if (!Array.isArray(rawBox) || rawBox.length !== 4) return null;

  let a = Number(rawBox[0]);
  let b = Number(rawBox[1]);
  let c = Number(rawBox[2]);
  let d = Number(rawBox[3]);

  if ([a, b, c, d].some((n) => !Number.isFinite(n))) return null;

  // yxyx → xyxy
  if (capabilities?.boxOrder === 'yxyx') {
    [a, b, c, d] = [b, a, d, c];
  }

  // a,b,c,d are now x1,y1,x2,y2
  let x1 = a,
    y1 = b,
    x2 = c,
    y2 = d;

  // ensure left < right, top < bottom
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];

  // clamp
  const cx1 = clampNorm(x1);
  const cy1 = clampNorm(y1);
  const cx2 = clampNorm(x2);
  const cy2 = clampNorm(y2);

  if (cx1 === null || cy1 === null || cx2 === null || cy2 === null) return null;

  // reject zero-area
  if (cx1 === cx2 || cy1 === cy2) return null;

  return [cx1, cy1, cx2, cy2];
}

/**
 * Normalize a 2D point to [x, y] clamped to 0-1000.
 */
export function normalizePoint(rawPoint: unknown): [number, number] | null {
  if (!Array.isArray(rawPoint) || rawPoint.length !== 2) return null;

  const x = clampNorm(Number(rawPoint[0]));
  const y = clampNorm(Number(rawPoint[1]));

  if (x === null || y === null) return null;
  return [x, y];
}

// --- primitive normalization ---

/**
 * Convert a raw primitive record into a normalized VisionPrimitive.
 *
 * Field-name aliases tried:
 *   box  ← raw.box, raw.bbox, raw.bbox_2d, raw.box_2d
 *   point ← raw.point, raw.point_2d, raw.center
 *   ref  ← raw.ref, raw.label, raw.text, raw.name
 *
 * Boxes are preferred over points when both are available.
 */
export function normalizePrimitive(
  raw: Record<string, unknown>,
  index: number,
  capabilities?: VisionCapabilities,
): VisionPrimitive | null {
  const boxesEnabled = capabilities?.boxes !== false;
  const pointsEnabled = capabilities?.points !== false;

  const ref = String(
    raw.ref ?? raw.label ?? raw.text ?? raw.name ?? `element-${index}`,
  );
  const id = String(raw.id ?? `v${index + 1}`);
  const grounding =
    (raw.grounding as string) ?? capabilities?.groundingMode ?? 'native';
  const confidence = normalizeConfidence(raw.confidence);

  // prefer box over point
  if (boxesEnabled) {
    const boxRaw =
      raw.box ?? raw.bbox ?? raw.bbox_2d ?? raw.box_2d;
    const box = normalizeBox(boxRaw, capabilities);
    if (box) {
      return { id, type: 'box', ref, box, confidence, grounding };
    }
  }

  if (pointsEnabled) {
    const pointRaw = raw.point ?? raw.point_2d ?? raw.center;
    const point = normalizePoint(pointRaw);
    if (point) {
      return { id, type: 'point', ref, point, confidence, grounding };
    }
  }

  return null;
}

// --- visual-primitives XML block ---

/**
 * Format a list of normalized primitives into the `<visual-primitives>` XML
 * text block consumed by LLMs.
 */
export function formatVisualPrimitives(
  primitives: VisionPrimitive[],
  groundingMode: string,
): string {
  const lines: string[] = [
    `<visual-primitives coord="norm-1000" box_order="xyxy" grounding="${groundingMode}">`,
  ];

  if (!primitives.length) {
    lines.push('- unavailable | reason: no valid coordinates');
  } else {
    const limited = primitives.slice(0, MAX_VISUAL_PRIMITIVES);
    for (const p of limited) {
      const parts: string[] = [`- ${p.id}`];
      parts.push(`type: ${p.type}`);

      if (p.box) parts.push(`box: [${p.box.join(', ')}]`);
      if (p.point) parts.push(`point: [${p.point.join(', ')}]`);

      const refText =
        p.ref.length > MAX_PRIMITIVE_REF_CHARS
          ? p.ref.slice(0, MAX_PRIMITIVE_REF_CHARS - 3) + '...'
          : p.ref;
      parts.push(`ref: ${refText}`);

      if (p.confidence !== null && p.confidence !== undefined) {
        parts.push(`confidence: ${p.confidence}`);
      }

      parts.push(`grounding: ${p.grounding}`);
      lines.push(parts.join(' | '));
    }
  }

  lines.push('</visual-primitives>');
  return lines.join('\n');
}

// --- full-note formatters ---

/**
 * Render a complete structured vision analysis into a single note string
 * suitable for injection into text-only LLM messages.
 */
export function formatStructuredVisionNote(
  analysis: StructuredAnalysis,
  capabilities?: VisionCapabilities,
): string {
  const sections: string[] = [
    `image_overview: ${safeSection(analysis.image_overview)}`,
    `visible_text: ${safeSection(analysis.visible_text)}`,
    `objects_and_layout: ${safeSection(analysis.objects_and_layout)}`,
    `charts_or_data: ${safeSection(analysis.charts_or_data)}`,
    `user_request: ${safeSection(analysis.user_request)}`,
    `user_request_answer: ${safeSection(analysis.user_request_answer)}`,
    `evidence: ${safeSection(analysis.evidence)}`,
    `uncertainty: ${safeSection(analysis.uncertainty)}`,
  ];

  const groundingMode = capabilities?.groundingMode ?? 'native';

  // Collect and normalize any raw primitives from the analysis payload.
  const rawPrimitives =
    analysis.visual_primitives ??
    analysis.visual_anchors ??
    analysis.anchors ??
    [];

  const normalized: VisionPrimitive[] = [];
  for (let i = 0; i < rawPrimitives.length; i++) {
    const p = normalizePrimitive(rawPrimitives[i], i, capabilities);
    if (p) normalized.push(p);
  }

  // Use 'unavailable' grounding when no valid primitives were found
  const effectiveGrounding = normalized.length > 0 ? groundingMode : 'unavailable';
  sections.push(formatVisualPrimitives(normalized, effectiveGrounding));

  return truncate(sections.join('\n'));
}

/**
 * Produce a fallback note when JSON parsing of the vision model's response
 * fails. Includes the raw text so the caller can still extract information.
 */
export function formatInvalidStructuredNote(rawResponse: string): string {
  const lines: string[] = [
    'structured vision analysis unavailable',
    rawResponse,
    formatVisualPrimitives([], 'unavailable'),
  ];
  return lines.join('\n');
}
