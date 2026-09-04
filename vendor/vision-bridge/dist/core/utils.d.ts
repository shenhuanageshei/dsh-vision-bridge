export declare function defaultMarkerParser(text: string): string[];
export type MarkerParser = (text: string) => string[];
export declare function normalizeUserRequest(text: string): string;
export declare function uniquePathsFromText(text: string, parser: MarkerParser): string[];
export declare function imagePromptCacheKey(img: {
    mimeType?: string;
    data?: string;
}, userRequest: string, modelSignature?: string): string;
export declare function contentText(content: string | {
    type: string;
    text?: string;
}[] | undefined): string;
export declare function replaceTextContent(content: string | {
    type: string;
    text?: string;
}[] | undefined, replacer: (text: string) => string): string | {
    type: string;
    text?: string;
}[];
export declare function extractJsonObject(text: string): Record<string, unknown> | null;
export declare function clampNorm(value: number): number | null;
export declare function normalizeConfidence(value: unknown): number | null;
export declare function truncateFormatter(text: string, max?: number): string;
