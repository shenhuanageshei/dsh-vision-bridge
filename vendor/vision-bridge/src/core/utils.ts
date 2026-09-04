import crypto from 'crypto';

// Default marker parser — matches openhanako's [attached_image: /path] format
const ATTACHED_IMAGE_RE = /\[attached_image:\s*([^\]]+)\]/g;

export function defaultMarkerParser(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = ATTACHED_IMAGE_RE.exec(text || '')) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}

export type MarkerParser = (text: string) => string[];

export function normalizeUserRequest(text: string): string {
  return String(text || '')
    .replace(/\[attached_image:\s*[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function uniquePathsFromText(text: string, parser: MarkerParser): string[] {
  return parser(text || '');
}

export function imagePromptCacheKey(
  img: { mimeType?: string; data?: string },
  userRequest: string,
  modelSignature: string = '',
): string {
  const h = crypto.createHash('sha256');
  h.update(img?.mimeType || 'image/png');
  h.update('\0');
  h.update(img?.data || '');
  h.update('\0');
  h.update(userRequest || '');
  h.update('\0');
  h.update(modelSignature || '');
  return h.digest('hex');
}

export function contentText(content: string | { type: string; text?: string }[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

export function replaceTextContent(
  content: string | { type: string; text?: string }[] | undefined,
  replacer: (text: string) => string,
): string | { type: string; text?: string }[] {
  if (typeof content === 'string') return replacer(content);
  if (!Array.isArray(content)) return content ?? '';
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== 'text') return block;
    const text = block.text || '';
    const replaced = replacer(text);
    if (replaced !== text) changed = true;
    return replaced !== text ? { ...block, text: replaced } : block;
  });
  return changed ? next : content;
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const primary = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(primary) as Record<string, unknown>;
  } catch {
    const start = primary.indexOf('{');
    const end = primary.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(primary.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export function clampNorm(value: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

export function normalizeConfidence(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function truncateFormatter(text: string, max = 3200): string {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 20)}\n[truncated]` : s;
}
