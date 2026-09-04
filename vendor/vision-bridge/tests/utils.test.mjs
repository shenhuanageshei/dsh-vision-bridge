import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../dist/core/utils.js';

describe('normalizeUserRequest', () => {
  it('strips attached_image markers', () => {
    const result = normalizeUserRequest('[attached_image: /tmp/a.png]\nwhat is this?');
    assert.equal(result, 'what is this?');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeUserRequest('hello   world\n\n  foo'), 'hello world foo');
  });

  it('handles empty input', () => {
    assert.equal(normalizeUserRequest(''), '');
  });
});

describe('imagePromptCacheKey', () => {
  it('produces deterministic SHA-256 hash', () => {
    const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' };
    const a = imagePromptCacheKey(img, 'what is this?', '');
    const b = imagePromptCacheKey(img, 'what is this?', '');
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it('differs by image data', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', '');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'B' }, 'req', '');
    assert.notEqual(a, b);
  });

  it('differs by user request', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req1', '');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req2', '');
    assert.notEqual(a, b);
  });

  it('differs by model signature', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', 'sig1');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', 'sig2');
    assert.notEqual(a, b);
  });
});

describe('uniquePathsFromText', () => {
  it('extracts paths from attached_image markers', () => {
    const text = '[attached_image: /tmp/a.png] hello [attached_image: /tmp/b.png] world';
    assert.deepEqual(uniquePathsFromText(text, defaultMarkerParser), ['/tmp/a.png', '/tmp/b.png']);
  });

  it('returns empty array when no markers', () => {
    assert.deepEqual(uniquePathsFromText('hello world', defaultMarkerParser), []);
  });
});

describe('contentText', () => {
  it('returns string content as-is', () => {
    assert.equal(contentText('hello'), 'hello');
  });

  it('extracts text from ContentBlock[]', () => {
    assert.equal(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]), 'hello world');
  });

  it('skips non-text blocks', () => {
    assert.equal(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
      { type: 'text', text: 'world' },
    ]), 'hello world');
  });

  it('returns empty string for non-array non-string', () => {
    assert.equal(contentText(null), '');
  });
});

describe('replaceTextContent', () => {
  it('replaces string content', () => {
    assert.equal(replaceTextContent('hello', (s) => s.toUpperCase()), 'HELLO');
  });

  it('replaces text blocks in array content', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
    ];
    const result = replaceTextContent(content, (s) => s.toUpperCase());
    assert.equal(result[0].text, 'HELLO');
    assert.deepEqual(result[1], content[1]);
  });

  it('returns unchanged array when no text changes', () => {
    const content = [{ type: 'text', text: 'hello' }];
    const result = replaceTextContent(content, (s) => s);
    assert.equal(result, content);
  });
});

describe('extractJsonObject', () => {
  it('parses raw JSON', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  it('parses fenced JSON', () => {
    assert.deepEqual(extractJsonObject('\u0060\u0060\u0060json\n{"a":1}\n\u0060\u0060\u0060'), { a: 1 });
  });

  it('parses JSON embedded in text', () => {
    assert.deepEqual(extractJsonObject('result: {"a":1} done'), { a: 1 });
  });

  it('returns null for invalid JSON', () => {
    assert.equal(extractJsonObject('not json'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(extractJsonObject(''), null);
  });
});

describe('clampNorm', () => {
  it('clamps to [0, 1000]', () => {
    assert.equal(clampNorm(-5), 0);
    assert.equal(clampNorm(500), 500);
    assert.equal(clampNorm(1500), 1000);
  });

  it('returns null for NaN/Infinity', () => {
    assert.equal(clampNorm(NaN), null);
    assert.equal(clampNorm(Infinity), null);
  });
});

describe('normalizeConfidence', () => {
  it('clamps to [0, 1]', () => {
    assert.equal(normalizeConfidence(-0.5), 0);
    assert.equal(normalizeConfidence(0.73), 0.73);
    assert.equal(normalizeConfidence(1.5), 1);
  });

  it('returns null for undefined/null/NaN', () => {
    assert.equal(normalizeConfidence(undefined), null);
    assert.equal(normalizeConfidence(null), null);
    assert.equal(normalizeConfidence(NaN), null);
  });
});
