// Image content block for vision model API calls
export interface ImageContentBlock {
  type: 'image';
  mimeType: string; // 'image/png' | 'image/jpeg' | 'image/webp'
  data: string; // base64
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

// Messages for LLM communication
export interface VisionMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

// Model reference (minimal info about an LLM)
export interface VisionModelRef {
  provider?: string;
  id?: string;
  input?: string[]; // supported modalities, e.g. ['text'] or ['text', 'image']
}

// Grounding/coordinate capabilities of a vision model
export interface VisionCapabilities {
  boxes?: boolean;
  points?: boolean;
  coordinateSpace?: string;
  boxOrder?: 'xyxy' | 'yxyx';
  outputFormat?: 'hanako' | 'gemini' | 'qwen' | 'anchor';
  groundingMode?: string;
}

// A normalized visual primitive (box or point with coordinates)
export interface VisionPrimitive {
  id: string;
  type: 'box' | 'point';
  ref: string;
  box?: number[]; // [x1, y1, x2, y2] normalized to 0-1000
  point?: number[]; // [x, y] normalized to 0-1000
  confidence: number | null;
  grounding: string;
}

// Raw analysis response from vision model
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

// Parameters for analyze()
export interface AnalyzeParams {
  images: ImageContentBlock[];
  userRequest: string;
  sessionId?: string;
  imagePaths?: string[];
  targetModel?: VisionModelRef;
}

// Result from analyze()
export interface AnalyzeResult {
  text: string;
  images: undefined;
  visionNotes: string[];
}

// Result from injectIntoMessages()
export interface InjectResult {
  messages: LLMMessage[];
  injected: number;
}

// Cache entry stored in memory/disk
export interface CacheEntry {
  note: string;
  imagePath: string;
  sessionPath: string | null;
  userRequest: string;
  visionModel: VisionModelRef | null;
  targetModel: VisionModelRef | null;
  updatedAt: number;
}

// Main config for VisionBridge
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
