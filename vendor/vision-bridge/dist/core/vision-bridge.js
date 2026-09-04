import { FileCacheBackend, LRUCache } from './cache.js';
import { formatInvalidStructuredNote, formatStructuredVisionNote } from './formatters.js';
import { buildBasicPrompt, buildStructuredPrompt } from './prompts.js';
import { contentText, defaultMarkerParser, extractJsonObject, imagePromptCacheKey, normalizeUserRequest, truncateFormatter, } from './utils.js';
// --- constants ---
export const VISION_CONTEXT_START = '<vision-context>';
export const VISION_CONTEXT_END = '</vision-context>';
export const VISUAL_PRIMITIVES_START = '<visual-primitives';
export const VISUAL_PRIMITIVES_END = '</visual-primitives>';
// --- VisionBridge class ---
export class VisionBridge {
    _adapter;
    _config;
    _persistBackend;
    _now;
    _markerParser;
    _visionCapabilitiesResolver;
    _analysisByPrompt;
    _noteByPath;
    _maxNoteCacheEntries;
    constructor(options) {
        this._adapter = options.adapter;
        this._config = options.config;
        this._now = options.now ?? (() => Date.now());
        this._markerParser = options.config.markerParser ?? defaultMarkerParser;
        this._visionCapabilitiesResolver =
            options.config.visionCapabilitiesResolver ?? (() => null);
        // Persist backend: explicit or from config.persistDir
        if (options.persistBackend) {
            this._persistBackend = options.persistBackend;
        }
        else if (options.config.persistDir) {
            this._persistBackend = new FileCacheBackend(options.config.persistDir);
        }
        // Cache capacity
        const maxCacheEntries = options.maxCacheEntries ?? options.config.maxCacheEntries ?? 256;
        this._maxNoteCacheEntries = maxCacheEntries;
        this._analysisByPrompt = new LRUCache(maxCacheEntries);
        this._noteByPath = new Map();
    }
    // --- public API ---
    needsBridge(model) {
        if (!model?.input || !Array.isArray(model.input))
            return false;
        return !model.input.includes('image');
    }
    async analyze(params) {
        const { images, userRequest, targetModel, sessionId, imagePaths } = params;
        // No images — nothing to do
        if (!images || images.length === 0) {
            return { text: userRequest, images: undefined, visionNotes: [] };
        }
        // Target model supports images natively — pass through
        if (targetModel && !this.needsBridge(targetModel)) {
            return { text: userRequest, images: images, visionNotes: [] };
        }
        // Validate vision model
        const visionModel = this._config.visionModel;
        if (!visionModel) {
            throw new Error('No vision model configured');
        }
        if (!this._adapter.supportsImages(visionModel)) {
            throw new Error('Vision model must support image input');
        }
        const visionNotes = [];
        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const note = await this._analyzeImage(img, i, userRequest, targetModel, sessionId, imagePaths?.[i]);
            visionNotes.push(note);
        }
        return { text: userRequest, images: undefined, visionNotes };
    }
    injectIntoMessages(messages, sessionId) {
        let injected = 0;
        const resultMessages = messages.map((msg) => {
            // Only inject into user messages
            if (msg.role !== 'user')
                return msg;
            const text = contentText(msg.content);
            if (!text)
                return msg;
            // Skip if already has vision context
            if (text.includes(VISION_CONTEXT_START))
                return msg;
            // Find image paths
            const paths = this._markerParser(text);
            if (paths.length === 0)
                return msg;
            // Look up notes for each path
            const notes = [];
            for (const imagePath of paths) {
                const entry = this._lookupNote(sessionId, imagePath);
                if (entry) {
                    notes.push(entry.note);
                }
            }
            if (notes.length === 0)
                return msg;
            // Build vision context block
            const contextParts = notes.map((note, idx) => `image_${idx + 1}: ${note}`);
            const visionContext = `${VISION_CONTEXT_START}\n${contextParts.join('\n')}\n${VISION_CONTEXT_END}\n\n`;
            injected += notes.length;
            // Prepend vision context to the first text block
            return {
                ...msg,
                content: this._prependText(msg.content, visionContext),
            };
        });
        return { messages: resultMessages, injected };
    }
    // --- private analysis ---
    async _analyzeImage(img, index, userRequest, targetModel, sessionId, imagePath) {
        const visionModel = this._config.visionModel;
        const normalizedRequest = normalizeUserRequest(userRequest);
        const modelSignature = `${visionModel.provider ?? ''}:${visionModel.id ?? ''}`;
        // Check analysis cache by prompt hash
        const cacheKey = imagePromptCacheKey(img, normalizedRequest, modelSignature);
        const cached = this._analysisByPrompt.get(cacheKey);
        if (cached) {
            // Still store by path for injection lookups
            if (imagePath) {
                this._storeNoteByPath(cached, imagePath, sessionId, normalizedRequest, targetModel);
            }
            return cached;
        }
        // Resolve capabilities
        const capabilities = this._visionCapabilitiesResolver(visionModel);
        let note;
        if (capabilities) {
            note = await this._analyzeImageWithPrimitives(img, userRequest, capabilities);
        }
        else {
            note = await this._analyzeImageAsNote(img, userRequest);
        }
        // Cache in memory
        this._analysisByPrompt.set(cacheKey, note);
        // Cache by path
        if (imagePath) {
            this._storeNoteByPath(note, imagePath, sessionId, normalizedRequest, targetModel);
        }
        return note;
    }
    async _analyzeImageAsNote(img, userRequest) {
        const prompts = buildBasicPrompt(userRequest);
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: `${prompts.system}\n\n${prompts.user}` },
                    img,
                ],
            },
        ];
        const callOptions = {
            model: this._config.visionModel.id ?? 'default',
            apiKey: this._config.visionModel.apiKey,
            baseURL: this._config.visionModel.baseURL,
            timeoutMs: this._config.timeoutMs,
        };
        const response = await this._adapter.call(messages, callOptions);
        return truncateFormatter(response, this._config.maxNoteChars ?? 3200);
    }
    async _analyzeImageWithPrimitives(img, userRequest, capabilities) {
        const prompts = buildStructuredPrompt(userRequest, capabilities);
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: `${prompts.system}\n\n${prompts.user}` },
                    img,
                ],
            },
        ];
        const callOptions = {
            model: this._config.visionModel.id ?? 'default',
            apiKey: this._config.visionModel.apiKey,
            baseURL: this._config.visionModel.baseURL,
            timeoutMs: this._config.timeoutMs,
        };
        const response = await this._adapter.call(messages, callOptions);
        const parsed = extractJsonObject(response);
        if (parsed) {
            return formatStructuredVisionNote(parsed, capabilities);
        }
        return formatInvalidStructuredNote(response);
    }
    // --- note storage ---
    _storeNoteByPath(note, imagePath, sessionId, normalizedRequest, targetModel) {
        const entry = {
            note,
            imagePath,
            sessionPath: sessionId ?? null,
            userRequest: normalizedRequest,
            visionModel: this._config.visionModel ?? null,
            targetModel: targetModel ?? null,
            updatedAt: this._now(),
        };
        this._noteByPath.set(imagePath, entry);
        this._trimNoteCache();
        if (sessionId && this._persistBackend) {
            this._persistNote(sessionId, imagePath, entry);
        }
    }
    _persistNote(sessionId, imagePath, entry) {
        if (!this._persistBackend)
            return;
        const key = `${sessionId}::${imagePath}`;
        this._persistBackend.set(key, JSON.stringify(entry));
    }
    _lookupNote(sessionId, imagePath) {
        // Check memory first
        const entry = this._noteByPath.get(imagePath);
        if (entry)
            return entry;
        // Try disk
        if (sessionId && this._persistBackend) {
            const key = `${sessionId}::${imagePath}`;
            const raw = this._persistBackend.get(key);
            if (raw) {
                try {
                    const restored = JSON.parse(raw);
                    this._noteByPath.set(imagePath, restored);
                    return restored;
                }
                catch {
                    // Corrupted data — skip
                }
            }
        }
        return undefined;
    }
    // --- cache trimming ---
    _trimNoteCache() {
        if (this._noteByPath.size <= this._maxNoteCacheEntries)
            return;
        const entries = Array.from(this._noteByPath.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        const toRemove = entries.slice(0, entries.length - this._maxNoteCacheEntries);
        for (const [key] of toRemove) {
            this._noteByPath.delete(key);
        }
    }
    // --- content helpers ---
    _prependText(content, prefix) {
        if (typeof content === 'string') {
            return prefix + content;
        }
        if (!Array.isArray(content))
            return content ?? '';
        // Prepend only to the first text block
        const textIdx = content.findIndex((b) => b.type === 'text');
        if (textIdx < 0) {
            // No text block — add one at the start with just the prefix
            return [{ type: 'text', text: prefix }, ...content];
        }
        const result = [...content];
        const textBlock = result[textIdx];
        result[textIdx] = { type: 'text', text: prefix + (textBlock.text || '') };
        return result;
    }
}
//# sourceMappingURL=vision-bridge.js.map