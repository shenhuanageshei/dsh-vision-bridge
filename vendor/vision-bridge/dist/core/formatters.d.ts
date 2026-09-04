import type { VisionCapabilities, VisionPrimitive, StructuredAnalysis } from './types.js';
/**
 * Format a section value for inclusion in a structured vision note.
 * - Returns the fallback string when the value is missing or empty.
 * - Joins array entries with "; ".
 */
export declare function safeSection(value: string | string[] | undefined, fallback?: string): string;
/**
 * Truncate text to a maximum length, appending a "[truncated]" marker.
 */
export declare function truncate(text: string, max?: number): string;
/**
 * Normalize a box / bounding-box to canonical xyxy form clamped to 0-1000.
 *
 * - Accepts xyxy [x1, y1, x2, y2] or yxyx [y1, x1, y2, x2] (when
 *   capabilities.boxOrder === 'yxyx').
 * - Swaps coordinates so left < right and top < bottom.
 * - Rejects zero-area boxes (left == right or top == bottom).
 * - Returns null for any invalid input.
 */
export declare function normalizeBox(rawBox: unknown, capabilities?: VisionCapabilities): number[] | null;
/**
 * Normalize a 2D point to [x, y] clamped to 0-1000.
 */
export declare function normalizePoint(rawPoint: unknown): [number, number] | null;
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
export declare function normalizePrimitive(raw: Record<string, unknown>, index: number, capabilities?: VisionCapabilities): VisionPrimitive | null;
/**
 * Format a list of normalized primitives into the `<visual-primitives>` XML
 * text block consumed by LLMs.
 */
export declare function formatVisualPrimitives(primitives: VisionPrimitive[], groundingMode: string): string;
/**
 * Render a complete structured vision analysis into a single note string
 * suitable for injection into text-only LLM messages.
 */
export declare function formatStructuredVisionNote(analysis: StructuredAnalysis, capabilities?: VisionCapabilities): string;
/**
 * Produce a fallback note when JSON parsing of the vision model's response
 * fails. Includes the raw text so the caller can still extract information.
 */
export declare function formatInvalidStructuredNote(rawResponse: string): string;
