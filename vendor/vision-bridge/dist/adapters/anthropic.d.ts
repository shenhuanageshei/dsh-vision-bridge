import type { LLMAdapter, CallOptions } from './types.js';
import type { VisionMessage, VisionModelRef } from '../core/types.js';
export declare class AnthropicAdapter implements LLMAdapter {
    private _fetch;
    private _defaultApiKey?;
    private _defaultBaseURL?;
    private _anthropicVersion;
    constructor(opts?: {
        fetch?: typeof fetch;
        apiKey?: string;
        baseURL?: string;
        anthropicVersion?: string;
    });
    supportsImages(model: VisionModelRef): boolean;
    call(messages: VisionMessage[], options: CallOptions): Promise<string>;
}
