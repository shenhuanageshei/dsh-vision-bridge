import { FileCacheBackend, LRUCache } from './cache.js';
import { formatInvalidStructuredNote, formatStructuredVisionNote } from './formatters.js';
import { buildBasicPrompt, buildStructuredPrompt } from './prompts.js';
import type {
  AnalyzeParams,
  AnalyzeResult,
  CacheEntry,
  ContentBlock,
  ImageContentBlock,
  InjectResult,
  LLMMessage,
  StructuredAnalysis,
  VisionBridgeConfig,
  VisionCapabilities,
  VisionMessage,
  VisionModelRef,
} from './types.js';
import {
  contentText,
  defaultMarkerParser,
  extractJsonObject,
  imagePromptCacheKey,
  normalizeUserRequest,
  replaceTextContent,
  truncateFormatter,
} from './utils.js';
import type { CacheBackend, CallOptions, LLMAdapter, MarkerParser, VisionCapabilitiesResolver } from '../adapters/types.js';

// Re-export for consumers
export type { VisionCapabilitiesResolver } from '../adapters/types.js';

// --- constants ---

export const VISION_CONTEXT_START = '<vision-context>';
export const VISION_CONTEXT_END = '</vision-context>';
export const VISUAL_PRIMITIVES_START = '<visual-primitives';
export const VISUAL_PRIMITIVES_END = '</visual-primitives>';

// --- VisionBridge class ---

export class VisionBridge {
  private _adapter: LLMAdapter;
  private _config: VisionBridgeConfig;
  private _persistBackend: CacheBackend | undefined;
  private _now: () => number;
  private _markerParser: MarkerParser;
  private _visionCapabilitiesResolver: VisionCapabilitiesResolver;
  private _analysisByPrompt: LRUCache<string>;
  private _noteByPath: Map<string, CacheEntry>;
  private _maxNoteCacheEntries: number;

  constructor(options: {
    adapter: LLMAdapter;
    config: VisionBridgeConfig;
    persistBackend?: CacheBackend;
    now?: () => number;
    maxCacheEntries?: number;
  }) {
    this._adapter = options.adapter;
    this._config = options.config;
    this._now = options.now ?? (() => Date.now());
    this._markerParser = options.config.markerParser ?? defaultMarkerParser;
    this._visionCapabilitiesResolver =
      options.config.visionCapabilitiesResolver ?? (() => null);

    // Persist backend: explicit or from config.persistDir
    if (options.persistBackend) {
      this._persistBackend = options.persistBackend;
    } else if (options.config.persistDir) {
      this._persistBackend = new FileCacheBackend(options.config.persistDir);
    }

    // Cache capacity
    const maxCacheEntries =
      options.maxCacheEntries ?? options.config.maxCacheEntries ?? 256;
    this._maxNoteCacheEntries = maxCacheEntries;
    this._analysisByPrompt = new LRUCache<string>(maxCacheEntries);
    this._noteByPath = new Map();
  }

  // --- public API ---

  needsBridge(model?: VisionModelRef): boolean {
    if (!model?.input || !Array.isArray(model.input)) return false;
    return !model.input.includes('image');
  }

  async analyze(
    params: AnalyzeParams & { targetModel?: VisionModelRef },
  ): Promise<AnalyzeResult> {
    const { images, userRequest, targetModel, sessionId, imagePaths } = params;

    // No images — nothing to do
    if (!images || images.length === 0) {
      return { text: userRequest, images: undefined, visionNotes: [] };
    }

    // Target model supports images natively — pass through
    if (targetModel && !this.needsBridge(targetModel)) {
      return { text: userRequest, images: images as unknown as undefined, visionNotes: [] };
    }

    // Validate vision model
    const visionModel = this._config.visionModel;
    if (!visionModel) {
      throw new Error('No vision model configured');
    }
    if (!this._adapter.supportsImages(visionModel)) {
      throw new Error('Vision model must support image input');
    }

    const visionNotes: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const note = await this._analyzeImage(
        img,
        i,
        userRequest,
        targetModel,
        sessionId,
        imagePaths?.[i],
      );
      visionNotes.push(note);
    }

    return { text: userRequest, images: undefined, visionNotes };
  }

  injectIntoMessages(
    messages: LLMMessage[],
    sessionId?: string,
  ): InjectResult {
    let injected = 0;

    const resultMessages = messages.map((msg) => {
      // Only inject into user messages
      if (msg.role !== 'user') return msg;

      const text = contentText(msg.content);
      if (!text) return msg;

      // Skip if already has vision context
      if (text.includes(VISION_CONTEXT_START)) return msg;

      // Find image paths
      const paths = this._markerParser(text);
      if (paths.length === 0) return msg;

      // Look up notes for each path
      const notes: string[] = [];
      for (const imagePath of paths) {
        const entry = this._lookupNote(sessionId, imagePath);
        if (entry) {
          notes.push(entry.note);
        }
      }

      if (notes.length === 0) return msg;

      // Build vision context block
      const contextParts = notes.map(
        (note, idx) => `image_${idx + 1}: ${note}`,
      );
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

  private async _analyzeImage(
    img: ImageContentBlock,
    index: number,
    userRequest: string,
    targetModel: VisionModelRef | undefined,
    sessionId: string | undefined,
    imagePath: string | undefined,
  ): Promise<string> {
    const visionModel = this._config.visionModel;
    const normalizedRequest = normalizeUserRequest(userRequest);
    const modelSignature = `${visionModel.provider ?? ''}:${visionModel.id ?? ''}`;

    // Check analysis cache by prompt hash
    const cacheKey = imagePromptCacheKey(img, normalizedRequest, modelSignature);
    const cached = this._analysisByPrompt.get(cacheKey);
    if (cached) {
      // Still store by path for injection lookups
      if (imagePath) {
        this._storeNoteByPath(
          cached,
          imagePath,
          sessionId,
          normalizedRequest,
          targetModel,
        );
      }
      return cached;
    }

    // Resolve capabilities
    const capabilities = this._visionCapabilitiesResolver(visionModel);

    let note: string;
    if (capabilities) {
      note = await this._analyzeImageWithPrimitives(img, userRequest, capabilities);
    } else {
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

  private async _analyzeImageAsNote(
    img: ImageContentBlock,
    userRequest: string,
  ): Promise<string> {
    const prompts = buildBasicPrompt(userRequest);

    const messages: VisionMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${prompts.system}\n\n${prompts.user}` },
          img,
        ],
      },
    ];

    const callOptions: CallOptions = {
      model: this._config.visionModel.id ?? 'default',
      apiKey: this._config.visionModel.apiKey,
      baseURL: this._config.visionModel.baseURL,
      timeoutMs: this._config.timeoutMs,
    };

    const response = await this._adapter.call(messages, callOptions);
    return truncateFormatter(response, this._config.maxNoteChars ?? 3200);
  }

  private async _analyzeImageWithPrimitives(
    img: ImageContentBlock,
    userRequest: string,
    capabilities: VisionCapabilities,
  ): Promise<string> {
    const prompts = buildStructuredPrompt(userRequest, capabilities);

    const messages: VisionMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: `${prompts.system}\n\n${prompts.user}` },
          img,
        ],
      },
    ];

    const callOptions: CallOptions = {
      model: this._config.visionModel.id ?? 'default',
      apiKey: this._config.visionModel.apiKey,
      baseURL: this._config.visionModel.baseURL,
      timeoutMs: this._config.timeoutMs,
    };

    const response = await this._adapter.call(messages, callOptions);
    const parsed = extractJsonObject(response);

    if (parsed) {
      return formatStructuredVisionNote(
        parsed as StructuredAnalysis,
        capabilities,
      );
    }

    return formatInvalidStructuredNote(response);
  }

  // --- note storage ---

  private _storeNoteByPath(
    note: string,
    imagePath: string,
    sessionId: string | undefined,
    normalizedRequest: string,
    targetModel: VisionModelRef | undefined,
  ): void {
    const entry: CacheEntry = {
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

  private _persistNote(
    sessionId: string,
    imagePath: string,
    entry: CacheEntry,
  ): void {
    if (!this._persistBackend) return;
    const key = `${sessionId}::${imagePath}`;
    this._persistBackend.set(key, JSON.stringify(entry));
  }

  private _lookupNote(
    sessionId: string | undefined,
    imagePath: string,
  ): CacheEntry | undefined {
    // Check memory first
    const entry = this._noteByPath.get(imagePath);
    if (entry) return entry;

    // Try disk
    if (sessionId && this._persistBackend) {
      const key = `${sessionId}::${imagePath}`;
      const raw = this._persistBackend.get(key);
      if (raw) {
        try {
          const restored = JSON.parse(raw) as CacheEntry;
          this._noteByPath.set(imagePath, restored);
          return restored;
        } catch {
          // Corrupted data — skip
        }
      }
    }

    return undefined;
  }

  // --- cache trimming ---

  private _trimNoteCache(): void {
    if (this._noteByPath.size <= this._maxNoteCacheEntries) return;
    const entries = Array.from(this._noteByPath.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const toRemove = entries.slice(
      0,
      entries.length - this._maxNoteCacheEntries,
    );
    for (const [key] of toRemove) {
      this._noteByPath.delete(key);
    }
  }

  // --- content helpers ---

  private _prependText(
    content: string | ContentBlock[],
    prefix: string,
  ): string | ContentBlock[] {
    if (typeof content === 'string') {
      return prefix + content;
    }
    if (!Array.isArray(content)) return content ?? '';

    // Prepend only to the first text block
    const textIdx = content.findIndex((b) => b.type === 'text');
    if (textIdx < 0) {
      // No text block — add one at the start with just the prefix
      return [{ type: 'text', text: prefix }, ...content];
    }

    const result = [...content];
    const textBlock = result[textIdx];
    result[textIdx] = { type: 'text' as const, text: prefix + ((textBlock as { text?: string }).text || '') };
    return result;
  }
}
