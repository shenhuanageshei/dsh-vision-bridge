export interface ImageContentBlock {
    type: 'image';
    mimeType: string;
    data: string;
}
export interface TextContentBlock {
    type: 'text';
    text: string;
}
export type ContentBlock = TextContentBlock | ImageContentBlock;
export interface VisionMessage {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
}
export interface LLMMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | ContentBlock[];
}
export interface VisionModelRef {
    provider?: string;
    id?: string;
    input?: string[];
}
export interface VisionCapabilities {
    boxes?: boolean;
    points?: boolean;
    coordinateSpace?: string;
    boxOrder?: 'xyxy' | 'yxyx';
    outputFormat?: 'hanako' | 'gemini' | 'qwen' | 'anchor';
    groundingMode?: string;
}
export interface VisionPrimitive {
    id: string;
    type: 'box' | 'point';
    ref: string;
    box?: number[];
    point?: number[];
    confidence: number | null;
    grounding: string;
}
export interface StructuredAnalysis {
    image_overview?: string;
    visible_text?: string | string[];
    objects_and_layout?: string;
    charts_or_data?: string;
    user_request?: string;
    user_request_answer?: string;
    evidence?: string;
    uncertainty?: string;
    visual_primitives?: Record<string, unknown>[];
    visual_anchors?: Record<string, unknown>[];
    anchors?: Record<string, unknown>[];
}
export interface AnalyzeParams {
    images: ImageContentBlock[];
    userRequest: string;
    sessionId?: string;
    imagePaths?: string[];
    targetModel?: VisionModelRef;
}
export interface AnalyzeResult {
    text: string;
    images: undefined;
    visionNotes: string[];
}
export interface InjectResult {
    messages: LLMMessage[];
    injected: number;
}
export interface CacheEntry {
    note: string;
    imagePath: string;
    sessionPath: string | null;
    userRequest: string;
    visionModel: VisionModelRef | null;
    targetModel: VisionModelRef | null;
    updatedAt: number;
}
export interface VisionBridgeConfig {
    visionModel: VisionModelRef & {
        apiKey?: string;
        baseURL?: string;
        api?: string;
    };
    markerParser?: (text: string) => string[];
    visionCapabilitiesResolver?: (model: VisionModelRef) => VisionCapabilities | null;
    maxNoteChars?: number;
    maxCacheEntries?: number;
    timeoutMs?: number;
    maxPrimitives?: number;
    maxPrimitiveRefChars?: number;
    persistDir?: string;
}
