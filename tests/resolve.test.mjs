import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSessionImages,
  findImage,
  formatCandidates,
  normalizeRef,
  placeholderPrefixes,
  stripPlaceholders,
  walkImageBlocks,
} from '../lib/resolve.js';

/** Two real placeholder forms (dsh-llm content.js:47-79). */
function textOnlyPlaceholder(id) {
  return '[image omitted because this model accepts text only; attachment sha256:' + String(id).slice(7, 15) + ']';
}
function offloadedPlaceholder(id) {
  return '[image omitted to fit request image limits; ' + id + '. No local normalized image path is available; ask the user to attach it again if needed.]';
}

const ID_A = 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const ID_B = 'sha256:12345678abcdef1234567890abcdef1234567890abcdef1234567890abcdef0a';
const ID_C = 'sha256:ffffffffffffffff1234567890abcdef1234567890abcdef1234567890abcdef';

function ref(id, extra = {}) {
  return { attachmentId: id, mediaType: 'image/png', bytes: 1234, width: 640, height: 480, ...extra };
}

/** Fake session event shapes (subset of dsh-session SessionEvent). */
function userMessageEvent(seq, content) {
  return { type: 'user/message', seq, time: seq * 10, data: { role: 'user', id: 'm' + seq, content, source: { kind: 'user' } } };
}
function toolResultEvent(seq, blocks) {
  return {
    type: 'tool/result', seq, time: seq * 10,
    data: { turn: 1, step: 1, message: { role: 'user', id: 't' + seq, content: blocks, source: { kind: 'tool', tool: { callId: 'c' + seq, name: 'x' } } } },
  };
}

describe('normalizeRef', () => {
  it('treats empty and latest as latest', () => {
    assert.equal(normalizeRef(undefined).kind, 'latest');
    assert.equal(normalizeRef('').kind, 'latest');
    assert.equal(normalizeRef('Latest').kind, 'latest');
  });
  it('normalizes case and tolerates the sha256: prefix', () => {
    assert.deepEqual(normalizeRef('ABCDEF01'), { kind: 'prefix', hex: 'abcdef01' });
    assert.deepEqual(normalizeRef('sha256:ABCDEF01'), { kind: 'prefix', hex: 'abcdef01' });
    assert.deepEqual(normalizeRef(' SHA256:' + ID_A.slice(7)), { kind: 'prefix', hex: ID_A.slice(7) });
  });
  it('rejects non-hex input with an actionable message', () => {
    assert.throws(() => normalizeRef('hello world'), /attachment id/);
    assert.throws(() => normalizeRef('../etc/passwd'), /attachment id/);
  });

  it('rejects an empty prefix after the sha256: keyword', () => {
    assert.throws(() => normalizeRef('sha256:'), /empty after the sha256: prefix/);
    assert.throws(() => normalizeRef('sha256:   '), /empty after the sha256: prefix/);
  });

  it('rejects more than 64 hex chars with a precise message', () => {
    assert.throws(() => normalizeRef('a'.repeat(65)), /65 hex chars.*at most 64/s);
    assert.throws(() => normalizeRef('sha256:' + 'b'.repeat(80)), /80 hex chars/);
    // exactly 64 is fine
    assert.equal(normalizeRef('c'.repeat(64)).hex, 'c'.repeat(64));
  });
});

describe('collectSessionImages (snapshotEvents full scan)', () => {
  it('finds images in user/message events', () => {
    const events = [userMessageEvent(1, [{ type: 'text', text: '看这张图 ' + textOnlyPlaceholder(ID_A) }, { type: 'image', attachment: ref(ID_A) }])];
    const index = collectSessionImages(events);
    assert.equal(index.size, 1);
    assert.ok(index.has(ID_A));
    assert.equal(index.get(ID_A).hex, ID_A.slice(7));
  });

  it('finds images nested in tool/result content (contentHasImage parity)', () => {
    const events = [toolResultEvent(2, [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: ref(ID_B) }] }])];
    const index = collectSessionImages(events);
    assert.equal(index.size, 1);
    assert.ok(index.has(ID_B));
  });

  it('scans the WHOLE log: fork-inherited prefix and compaction-shadowed nodes stay resolvable', () => {
    // A fork child replays the parent's events as a seed; snapshotEvents()
    // returns the full log regardless of firstLiveSeq / shadow surfaces.
    const events = [
      userMessageEvent(1, [{ type: 'image', attachment: ref(ID_A) }]),          // inherited prefix
      { type: 'compaction/replace', seq: 2, time: 20, data: {} },              // shadow protocol node
      userMessageEvent(3, [{ type: 'image', attachment: ref(ID_C) }]),
    ];
    const index = collectSessionImages(events);
    assert.equal(index.size, 2);
    assert.ok(index.has(ID_A), 'fork-prefix image must remain resolvable');
    assert.ok(index.has(ID_C));
  });

  it('deduplicates repeated occurrences of one attachment id', () => {
    const events = [
      userMessageEvent(1, [{ type: 'image', attachment: ref(ID_A) }]),
      userMessageEvent(5, [{ type: 'image', attachment: ref(ID_A) }]),
    ];
    const index = collectSessionImages(events);
    const entry = index.get(ID_A);
    assert.equal(entry.occurrences, 2);
    assert.equal(entry.firstSeq, 1);
    assert.equal(entry.lastSeq, 5);
  });
});

describe('findImage (prefix resolution + candidate disambiguation)', () => {
  function indexWith(...ids) {
    return collectSessionImages(ids.map((id, i) => userMessageEvent(i + 1, [{ type: 'image', attachment: ref(id) }])));
  }

  it('resolves the 8-hex placeholder prefix', () => {
    const found = findImage(indexWith(ID_A, ID_C), normalizeRef(ID_A.slice(7, 15)));
    assert.equal(found.status, 'ok');
    assert.equal(found.entry.attachmentId, ID_A);
  });

  it('resolves case-insensitively and with sha256: prefix tolerated', () => {
    const index = indexWith(ID_A);
    assert.equal(findImage(index, normalizeRef('SHA256:' + ID_A.slice(7, 15).toUpperCase())).status, 'ok');
    assert.equal(findImage(index, normalizeRef(ID_A)).status, 'ok'); // full id exact
  });

  it('returns a candidate list on multi-hit instead of guessing', () => {
    // ID_A and ID_B share the 8-hex prefix '12345678'
    const index = indexWith(ID_A, ID_B);
    const found = findImage(index, normalizeRef('12345678'));
    assert.equal(found.status, 'ambiguous');
    assert.equal(found.candidates.length, 2);
    assert.match(formatCandidates(found.candidates), /12345678/);
  });

  it('exact full id outranks a prefix fan-out', () => {
    const index = indexWith(ID_A, ID_B);
    const found = findImage(index, normalizeRef(ID_A));
    assert.equal(found.status, 'ok');
    assert.equal(found.entry.attachmentId, ID_A);
  });

  it('latest picks the highest-seq image', () => {
    const index = indexWith(ID_C, ID_A);
    const found = findImage(index, normalizeRef('latest'));
    assert.equal(found.status, 'latest');
    assert.equal(found.entry.attachmentId, ID_A); // seq 2 in indexWith
  });

  it('not-found is actionable, not an error', () => {
    const found = findImage(indexWith(ID_A), normalizeRef('00000000'));
    assert.equal(found.status, 'not-found');
  });
});

describe('placeholder text handling', () => {
  it('strips both placeholder forms from user text', () => {
    const text = '看这张图 ' + textOnlyPlaceholder(ID_A) + ' 以及 ' + offloadedPlaceholder(ID_B) + ' 谢谢';
    const cleaned = stripPlaceholders(text);
    assert.equal(cleaned.includes('image omitted'), false);
    assert.match(cleaned, /看这张图/);
    assert.match(cleaned, /谢谢/);
  });

  it('cleans truncated-placeholder residue when a name/path closes the bracket early', () => {
    // An offloaded form whose read-only path ends early (name contains a
    // closing bracket) leaves a bare 'attachment sha256:xxxxxxxx]' tail.
    const text = 'look at [image omitted to fit request image limits; screenshot].png; attachment sha256:12345678] please';
    const cleaned = stripPlaceholders(text);
    assert.equal(cleaned.includes('image omitted'), false);
    assert.equal(cleaned.includes('attachment sha256:'), false, 'residue tail must be removed');
    assert.match(cleaned, /look at/);
    assert.match(cleaned, /please/);
  });

  it('extracts 8-hex prefixes from placeholder text', () => {
    const prefixes = placeholderPrefixes('x ' + textOnlyPlaceholder(ID_A) + ' y ' + textOnlyPlaceholder(ID_C));
    assert.deepEqual(prefixes, [ID_A.slice(7, 15), ID_C.slice(7, 15)]);
  });
});

describe('walkImageBlocks', () => {
  it('does not recurse into image blocks or choke on junk', () => {
    const seen = [];
    walkImageBlocks(undefined, (r) => seen.push(r));
    walkImageBlocks([null, 3, { type: 'text' }], (r) => seen.push(r));
    assert.equal(seen.length, 0);
  });
});
