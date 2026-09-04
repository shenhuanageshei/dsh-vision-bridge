import type { VisionCapabilities } from './types.js';
export declare function primitiveBoxOrderLabel(visionCapabilities?: VisionCapabilities): string;
export declare function primitivePromptShape(visionCapabilities?: VisionCapabilities): string[];
export declare function buildBasicPrompt(userRequest: string): {
    system: string;
    user: string;
};
export declare function buildStructuredPrompt(userRequest: string, visionCapabilities: VisionCapabilities): {
    system: string;
    user: string;
};
