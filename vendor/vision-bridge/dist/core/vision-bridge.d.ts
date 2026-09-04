import type { AnalyzeParams, AnalyzeResult, InjectResult, LLMMessage, VisionBridgeConfig, VisionModelRef } from './types.js';
import type { CacheBackend, LLMAdapter } from '../adapters/types.js';
export type { VisionCapabilitiesResolver } from '../adapters/types.js';
export declare const VISION_CONTEXT_START = "<vision-context>";
export declare const VISION_CONTEXT_END = "</vision-context>";
export declare const VISUAL_PRIMITIVES_START = "<visual-primitives";
export declare const VISUAL_PRIMITIVES_END = "</visual-primitives>";
export declare class VisionBridge {
    private _adapter;
    private _config;
    private _persistBackend;
    private _now;
    private _markerParser;
    private _visionCapabilitiesResolver;
    private _analysisByPrompt;
    private _noteByPath;
    private _maxNoteCacheEntries;
    constructor(options: {
        adapter: LLMAdapter;
        config: VisionBridgeConfig;
        persistBackend?: CacheBackend;
        now?: () => number;
        maxCacheEntries?: number;
    });
    needsBridge(model?: VisionModelRef): boolean;
    analyze(params: AnalyzeParams & {
        targetModel?: VisionModelRef;
    }): Promise<AnalyzeResult>;
    injectIntoMessages(messages: LLMMessage[], sessionId?: string): InjectResult;
    private _analyzeImage;
    private _analyzeImageAsNote;
    private _analyzeImageWithPrimitives;
    private _storeNoteByPath;
    private _persistNote;
    private _lookupNote;
    private _trimNoteCache;
    private _prependText;
}
