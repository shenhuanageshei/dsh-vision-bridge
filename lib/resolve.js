/**
 * Placeholder-form parsing and session-event image scanning (design §5.3).
 *
 * DSH projects durable images into two transient placeholder shapes for
 * text-only models (dsh-llm content.js:47-79):
 *   1. text-only:  `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`
 *      — 8 hex = attachmentId chars 8..16 (the id itself is `sha256:<64hex>`).
 *   2. offloaded:  `[image omitted to fit request image limits; <identity>. …]`
 *      — carries the full attachment id (and an optional read-only path).
 * Durable session events keep the full ImageBlock.attachment ref either way, so
 * the model's 8-hex citation resolves by scanning the session log with
 * `session.snapshotEvents()` — NEVER `session.events` (removed in
 * dsh-session 0.1.2-rc.1; vision-toolkit exposure.js:42 is the dead-path proof).
 *
 * @module @dsh-external/dsh-vision-bridge/resolve
 */

/** Matches both DSH placeholder forms. */
const PLACEHOLDER_RE = /\[image omitted[^\]]*\]/g;
/** The 8-hex citation inside a text-only placeholder. */
const PLACEHOLDER_HEX_RE = /sha256:([0-9a-fA-F]{8})/;
/** Residue after a truncated placeholder match: an offloaded form whose
 * display name / read-only path contains `]` closes the block match early,
 * leaving a bare `attachment sha256:xxxxxxxx]` tail behind. */
const PLACEHOLDER_RESIDUE_RE = /attachment sha256:[0-9a-fA-F]{8}\]?/g;

/**
 * Strip DSH image placeholders from user message text so the question fed to
 * the VLM (and thus the cache key) is not polluted (appendix B①). A second
 * pass removes the truncated-placeholder residue described above.
 */
export function stripPlaceholders(text) {
  return String(text ?? '')
    .replace(PLACEHOLDER_RE, '')
    .replace(PLACEHOLDER_RESIDUE_RE, '');
}

/** Extract the 8-hex prefixes cited by any placeholders present in the text. */
export function placeholderPrefixes(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(PLACEHOLDER_RE)) {
    const hex = PLACEHOLDER_HEX_RE.exec(m[0]);
    if (hex) out.push(hex[1].toLowerCase());
  }
  return out;
}

/**
 * Normalize a tool-supplied ref: trim, drop an optional case-insensitive
 * `sha256:` prefix, lowercase hex. Returns `{ kind: 'latest' }` for the
 * 'latest' keyword, else `{ kind: 'prefix', hex }`. A sha256 digest is 64 hex
 * chars — longer input is a precise error, and an empty prefix is one too.
 */
export function normalizeRef(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.toLowerCase() === 'latest') return { kind: 'latest' };
  const hex = s.replace(/^sha256:/i, '').toLowerCase();
  if (hex.length === 0) {
    throw new Error('vision_bridge_read: ref is empty after the sha256: prefix — pass the 8-hex id from the "[image omitted …]" placeholder, or "latest"');
  }
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`vision_bridge_read: ref "${s}" is not an attachment id — pass the 8-hex id shown in the "[image omitted … attachment sha256:xxxxxxxx]" placeholder, the full sha256:<64hex> id, or "latest"`);
  }
  if (hex.length > 64) {
    throw new Error(`vision_bridge_read: ref "${s.slice(0, 24)}…" is ${hex.length} hex chars — a sha256 attachment id is at most 64; pass the 8-hex placeholder id or the full 64-hex id`);
  }
  return { kind: 'prefix', hex };
}

/** Recursively collect image blocks from typed model content (parity with
 * dsh-llm contentHasImage: tool-result content nests further blocks). */
export function walkImageBlocks(content, visit) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'image' && block.attachment) visit(block.attachment);
    else if (block.type === 'tool-result') walkImageBlocks(block.content, visit);
  }
}

/**
 * Build a deduplicated image index over a full session event snapshot.
 *
 * Scans BOTH `user/message` and `tool/result` events (screenshots returned by
 * tools also produce placeholders), over the WHOLE log — fork-inherited prefix
 * and compaction-shadowed nodes included (appendix A②: snapshotEvents is
 * append-only and complete; ownEvents() would drop the fork prefix).
 *
 * @param events - `session.snapshotEvents()` output.
 * @returns Map<fullAttachmentId(lowercased hex incl. 'sha256:' prefix), entry>
 *   where entry = { attachmentId, hex, mediaType, width, height, bytes, name?,
 *   firstSeq, lastSeq, occurrences }.
 */
export function collectSessionImages(events) {
  const byId = new Map();
  for (const event of events ?? []) {
    if (event?.type === 'user/message') {
      walkImageBlocks(event.data?.content, (ref) => record(byId, ref, event.seq));
    } else if (event?.type === 'tool/result') {
      walkImageBlocks(event.data?.message?.content, (ref) => record(byId, ref, event.seq));
    }
  }
  return byId;
}

function record(byId, ref, seq) {
  const attachmentId = String(ref.attachmentId ?? '');
  if (!attachmentId) return;
  const key = attachmentId.toLowerCase();
  const existing = byId.get(key);
  if (existing) {
    existing.lastSeq = Math.max(existing.lastSeq, seq ?? 0);
    existing.occurrences += 1;
    return;
  }
  byId.set(key, {
    attachmentId,
    hex: attachmentId.replace(/^sha256:/i, '').toLowerCase(),
    mediaType: ref.mediaType,
    width: ref.width,
    height: ref.height,
    bytes: ref.bytes,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    firstSeq: seq ?? 0,
    lastSeq: seq ?? 0,
    occurrences: 1,
  });
}

/** Cap on candidate list size in ambiguous results (8-hex birthday space is
 * 32 bits; a longer user-supplied prefix may legitimately match many images). */
const MAX_CANDIDATES = 8;

/**
 * Resolve a normalized ref against an index (design §5.3: prefix match, never
 * guess on ambiguity). An exact full-id match outranks a prefix fan-out.
 *
 * @returns `{ status: 'ok', entry }` | `{ status: 'latest', entry }` |
 *   `{ status: 'ambiguous', candidates, truncated }` |
 *   `{ status: 'not-found', hex }`.
 */
export function findImage(index, normalizedRef) {
  if (normalizedRef.kind === 'latest') {
    let latest = null;
    for (const entry of index.values()) {
      if (!latest || entry.firstSeq > latest.firstSeq) latest = entry;
    }
    if (!latest) {
      return { status: 'not-found', hex: 'latest' };
    }
    return { status: 'latest', entry: latest };
  }
  const hex = normalizedRef.hex;
  const candidates = [];
  let exact = null;
  for (const entry of index.values()) {
    if (entry.hex === hex) { exact = entry; break; }
    if (entry.hex.startsWith(hex)) candidates.push(entry);
  }
  if (exact) return { status: 'ok', entry: exact };
  if (candidates.length === 1) return { status: 'ok', entry: candidates[0] };
  if (candidates.length > 1) {
    return { status: 'ambiguous', candidates: candidates.slice(0, MAX_CANDIDATES), truncated: candidates.length > MAX_CANDIDATES };
  }
  return { status: 'not-found', hex };
}

/** Human-readable candidate list for the ambiguity error message. */
export function formatCandidates(candidates, truncated = false) {
  return candidates
    .map((c) => `sha256:${c.hex.slice(0, 8)}… (seq ${c.firstSeq}${c.width ? `, ${c.width}x${c.height} ${c.mediaType ?? ''}` : ''})`)
    .join('; ') + (truncated ? '; …(list truncated)' : '');
}
