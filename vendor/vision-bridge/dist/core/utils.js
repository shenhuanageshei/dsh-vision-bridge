import crypto from 'crypto';
// Default marker parser — matches openhanako's [attached_image: /path] format
const ATTACHED_IMAGE_RE = /\[attached_image:\s*([^\]]+)\]/g;
export function defaultMarkerParser(text) {
    const paths = [];
    let m;
    while ((m = ATTACHED_IMAGE_RE.exec(text || '')) !== null) {
        paths.push(m[1].trim());
    }
    return paths;
}
export function normalizeUserRequest(text) {
    return String(text || '')
        .replace(/\[attached_image:\s*[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
export function uniquePathsFromText(text, parser) {
    return parser(text || '');
}
export function imagePromptCacheKey(img, userRequest, modelSignature = '') {
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
export function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('');
}
export function replaceTextContent(content, replacer) {
    if (typeof content === 'string')
        return replacer(content);
    if (!Array.isArray(content))
        return content ?? '';
    let changed = false;
    const next = content.map((block) => {
        if (block?.type !== 'text')
            return block;
        const text = block.text || '';
        const replaced = replacer(text);
        if (replaced !== text)
            changed = true;
        return replaced !== text ? { ...block, text: replaced } : block;
    });
    return changed ? next : content;
}
export function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw)
        return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const primary = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(primary);
    }
    catch {
        const start = primary.indexOf('{');
        const end = primary.lastIndexOf('}');
        if (start === -1 || end <= start)
            return null;
        try {
            return JSON.parse(primary.slice(start, end + 1));
        }
        catch {
            return null;
        }
    }
}
export function clampNorm(value) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return null;
    return Math.max(0, Math.min(1000, Math.round(n)));
}
export function normalizeConfidence(value) {
    if (value === undefined || value === null || value === '')
        return null;
    const n = Number(value);
    if (!Number.isFinite(n))
        return null;
    return Math.max(0, Math.min(1, n));
}
export function truncateFormatter(text, max = 3200) {
    const s = String(text || '').trim();
    return s.length > max ? `${s.slice(0, max - 20)}\n[truncated]` : s;
}
//# sourceMappingURL=utils.js.map