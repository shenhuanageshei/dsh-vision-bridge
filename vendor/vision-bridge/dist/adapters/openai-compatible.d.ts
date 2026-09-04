import type { LLMAdapter, CallOptions } from './types.js';
import type { VisionMessage, VisionModelRef } from '../core/types.js';
export declare class OpenAICompatibleAdapter implements LLMAdapter {
    private _fetch;
    private _defaultApiKey?;
    private _defaultBaseURL?;
    constructor(opts?: {
        fetch?: typeof fetch;
        apiKey?: string;
        baseURL?: string;
    });
    supportsImages(model: VisionModelRef): boolean;
    call(messages: VisionMessage[], options: CallOptions): Promise<string>;
}
