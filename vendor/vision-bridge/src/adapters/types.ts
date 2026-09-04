import type { VisionMessage, VisionModelRef, VisionCapabilities } from '../core/types.js';

export interface CallOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMAdapter {
  /** Non-streaming single call, returns text */
  call(messages: VisionMessage[], options: CallOptions): Promise<string>;
  /** Check if given model supports image input */
  supportsImages(model: VisionModelRef): boolean;
}

export interface CacheBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
}

export type MarkerParser = (text: string) => string[];
export type VisionCapabilitiesResolver = (model: VisionModelRef) => VisionCapabilities | null;
