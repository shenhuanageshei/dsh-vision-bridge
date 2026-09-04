import { describe, it, expect } from 'vitest';
import {
  normalizeUserRequest,
  imagePromptCacheKey,
  uniquePathsFromText,
  contentText,
  replaceTextContent,
  extractJsonObject,
  clampNorm,
  normalizeConfidence,
  defaultMarkerParser,
} from '../src/core/utils.js';

describe('normalizeUserRequest', () => {
  it('strips attached_image markers', () => {
    const result = normalizeUserRequest('[attached_image: /tmp/a.png]\nwhat is this?');
    expect(result).toBe('what is this?');
  });

  it('collapses whitespace', () => {
    expect(normalizeUserRequest('hello   world\n\n  foo')).toBe('hello world foo');
  });

  it('handles empty input', () => {
    expect(normalizeUserRequest('')).toBe('');
  });
});

describe('imagePromptCacheKey', () => {
  it('produces deterministic SHA-256 hash', () => {
    const img = { type: 'image' as const, mimeType: 'image/png', data: 'BASE64' };
    const a = imagePromptCacheKey(img, 'what is this?', '');
    const b = imagePromptCacheKey(img, 'what is this?', '');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('differs by image data', () => {
    const a = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'A' }, 'req', '');
    const b = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'B' }, 'req', '');
    expect(a).not.toBe(b);
  });

  it('differs by user request', () => {
    const a = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'A' }, 'req1', '');
    const b = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'A' }, 'req2', '');
    expect(a).not.toBe(b);
  });

  it('differs by model signature', () => {
    const a = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'A' }, 'req', 'sig1');
    const b = imagePromptCacheKey({ type: 'image' as const, mimeType: 'image/png', data: 'A' }, 'req', 'sig2');
    expect(a).not.toBe(b);
  });
});

describe('uniquePathsFromText', () => {
  it('extracts paths from attached_image markers', () => {
    const text = '[attached_image: /tmp/a.png] hello [attached_image: /tmp/b.png] world';
    const result = uniquePathsFromText(text, defaultMarkerParser);
    expect(result).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });

  it('returns empty array when no markers', () => {
    expect(uniquePathsFromText('hello world', defaultMarkerParser)).toEqual([]);
  });
});

describe('contentText', () => {
  it('returns string content as-is', () => {
    expect(contentText('hello')).toBe('hello');
  });

  it('extracts text from ContentBlock[]', () => {
    expect(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('skips non-text blocks', () => {
    expect(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('returns empty string for non-array non-string', () => {
    expect(contentText(null as any)).toBe('');
  });
});

describe('replaceTextContent', () => {
  it('replaces string content', () => {
    expect(replaceTextContent('hello', (s) => s.toUpperCase())).toBe('HELLO');
  });

  it('replaces text blocks in array content', () => {
    const content = [
      { type: 'text' as const, text: 'hello' },
      { type: 'image' as const, mimeType: 'image/png', data: 'AAA' },
    ];
    const result = replaceTextContent(content, (s) => s.toUpperCase());
    expect((result as any)[0].text).toBe('HELLO');
    expect((result as any)[1]).toEqual(content[1]);
  });

  it('returns unchanged array when no text changes', () => {
    const content = [{ type: 'text' as const, text: 'hello' }];
    const result = replaceTextContent(content, (s) => s);
    expect(result).toBe(content);
  });
});

describe('extractJsonObject', () => {
  it('parses raw JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON embedded in text', () => {
    expect(extractJsonObject('result: {"a":1} done')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(extractJsonObject('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('clampNorm', () => {
  it('clamps to [0, 1000]', () => {
    expect(clampNorm(-5)).toBe(0);
    expect(clampNorm(500)).toBe(500);
    expect(clampNorm(1500)).toBe(1000);
  });

  it('returns null for NaN/Infinity', () => {
    expect(clampNorm(NaN)).toBeNull();
    expect(clampNorm(Infinity)).toBeNull();
  });
});

describe('normalizeConfidence', () => {
  it('clamps to [0, 1]', () => {
    expect(normalizeConfidence(-0.5)).toBe(0);
    expect(normalizeConfidence(0.73)).toBe(0.73);
    expect(normalizeConfidence(1.5)).toBe(1);
  });

  it('returns null for undefined/null/NaN', () => {
    expect(normalizeConfidence(undefined)).toBeNull();
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence(NaN)).toBeNull();
  });
});
