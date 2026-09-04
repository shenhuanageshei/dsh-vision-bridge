# Vision Bridge 独立插件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 openhanako vision-bridge 剥离为独立 TypeScript npm 包 `@ti-agent/vision-bridge`

**Architecture:** VisionBridge 核心类（零外部运行时依赖）通过 LLMAdapter 接口调用视觉模型，通过 CacheBackend 接口持久化。TDD 全流程：先写测试 → 验证失败 → 实现 → 验证通过 → 提交。

**Tech Stack:** TypeScript, Vitest, Node.js 24 (global fetch), 零运行时依赖

---

### Task 1: 项目初始化

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

**Goal:** 初始化 TypeScript 项目 + Vitest 测试框架 + Git 仓库

- [ ] **Step 1: git init**

```bash
cd /g/Code/vision-bridge && git init
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "@ti-agent/vision-bridge",
  "version": "0.1.0",
  "description": "Vision bridge plugin for text-only AI agents — converts images to text descriptions",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "src", "README.md"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "prepack": "npm run build"
  },
  "keywords": ["vision", "ai-agent", "text-only-model", "image-description"],
  "license": "MIT"
}
```

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: 创建 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 5: 创建 .gitignore**

```
node_modules/
dist/
*.tmp-*
```

- [ ] **Step 6: 安装依赖**

```bash
cd /g/Code/vision-bridge && npm install --save-dev typescript vitest @types/node
```

- [ ] **Step 7: 验证空项目**

```bash
npx vitest run
```
预计: No test files found, exiting with code 0

- [ ] **Step 8: 初始提交**

```bash
git add -A
git commit -m "chore: init project with TypeScript + Vitest"
```

---

### Task 2: 核心类型定义

**Files:**
- Create: `src/core/types.ts`
- Test: `tests/types.test.ts` (compile-time verification)

**Goal:** 定义所有公共类型，与 openhanako 实现对齐但去除内部耦合

- [ ] **Step 1: 创建类型文件**

`src/core/types.ts`:

```ts
// === 图片内容块 ===
export interface ImageContentBlock {
  type: 'image';
  mimeType: string;        // 'image/png' | 'image/jpeg' | 'image/webp'
  data: string;            // base64
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

// === 消息 ===
export interface VisionMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

// === 视觉模型引用 ===
export interface VisionModelRef {
  provider?: string;
  id?: string;
  input?: string[];       // 模型支持列表 ['text'] | ['text', 'image']
}

// === Grounding 能力 ===
export interface VisionCapabilities {
  boxes?: boolean;
  points?: boolean;
  coordinateSpace?: string;
  boxOrder?: 'xyxy' | 'yxyx';
  outputFormat?: 'hanako' | 'gemini' | 'qwen' | 'anchor';
  groundingMode?: string;
}

// === 视觉分析结果 ===
export interface VisionPrimitive {
  id: string;
  type: 'box' | 'point';
  ref: string;
  box?: number[];          // [x1, y1, x2, y2] normalized to 0-1000
  point?: number[];        // [x, y] normalized to 0-1000
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

// === 分析/注入结果 ===
export interface AnalyzeParams {
  images: ImageContentBlock[];
  userRequest: string;
  sessionId?: string;
  imagePaths?: string[];    // 可选：图片文件路径，用于标记匹配
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

// === 缓存条目 ===
export interface CacheEntry {
  note: string;
  imagePath: string;
  sessionPath: string | null;
  userRequest: string;
  visionModel: VisionModelRef | null;
  targetModel: VisionModelRef | null;
  updatedAt: number;
}

// === 配置 ===
export interface VisionBridgeConfig {
  visionModel: VisionModelRef & {
    apiKey?: string;
    baseURL?: string;
    api?: string;           // 'openai-completions' | 'anthropic-messages'
  };
  markerParser?: MarkerParser;
  visionCapabilitiesResolver?: VisionCapabilitiesResolver;
  maxNoteChars?: number;
  maxCacheEntries?: number;
  timeoutMs?: number;
  maxPrimitives?: number;
  maxPrimitiveRefChars?: number;
  persistDir?: string;
}
```

- [ ] **Step 2: 创建 types.test.ts 做编译验证**

`tests/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { VisionMessage, ContentBlock, ImageContentBlock, VisionPrimitive } from '../src/core/types.js';

describe('types (compile-time)', () => {
  it('can construct a VisionMessage with string content', () => {
    const msg: VisionMessage = { role: 'user', content: 'hello' };
    expect(msg.role).toBe('user');
  });

  it('can construct a VisionMessage with ContentBlock[]', () => {
    const msg: VisionMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: 'BASE64_DATA' },
      ],
    };
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it('ImageContentBlock has required fields', () => {
    const img: ImageContentBlock = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    expect(img.type).toBe('image');
    expect(img.mimeType).toBe('image/png');
    expect(img.data).toBe('AAAA');
  });

  it('VisionPrimitive can represent box and point types', () => {
    const box: VisionPrimitive = { id: 'v1', type: 'box', ref: 'button', box: [100, 200, 300, 400], confidence: 0.9, grounding: 'native' };
    const point: VisionPrimitive = { id: 'v2', type: 'point', ref: 'cursor', point: [500, 600], confidence: null, grounding: 'prompted' };
    expect(box.type).toBe('box');
    expect(point.type).toBe('point');
  });
});
```

- [ ] **Step 3: 运行测试验证编译通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/types.test.ts
```
预计: 4 tests pass

- [ ] **Step 4: 提交**

```bash
git add src/core/types.ts tests/types.test.ts
git commit -m "feat: add core type definitions"
```

---

### Task 3: LLMAdapter 接口

**Files:**
- Create: `src/adapters/types.ts`

**Goal:** 定义 LLMAdapter 和 CacheBackend 接口

- [ ] **Step 1: 创建接口文件**

`src/adapters/types.ts`:

```ts
import type { VisionMessage, VisionModelRef } from '../core/types.js';

export interface CallOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMAdapter {
  call(messages: VisionMessage[], options: CallOptions): Promise<string>;
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

export type VisionCapabilitiesResolver = (model: VisionModelRef) => import('../core/types.js').VisionCapabilities | null;
```

- [ ] **Step 2: 提交** (接口是纯类型，无需测试文件)

```bash
git add src/adapters/types.ts
git commit -m "feat: add LLMAdapter and CacheBackend interfaces"
```

---

### Task 4: 图片标记工具 + 工具函数

**Files:**
- Create: `src/core/utils.ts`
- Test: `tests/utils.test.ts`

**Goal:** 从 openhanako 迁移工具函数：`normalizeUserRequest`, `imagePromptCacheKey`, `uniquePathsFromText`, `contentText`, `replaceTextContent`, `extractJsonObject` 等

- [ ] **Step 1: 写测试**

`tests/utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeUserRequest,
  imagePromptCacheKey,
  uniquePathsFromText,
  contentText,
  replaceTextContent,
  extractJsonObject,
  clampNorm,
  normalizeConfidence,
  defaultMarkerParser,
} from '../src/core/utils.js';

describe('normalizeUserRequest', () => {
  it('strips attached_image markers', () => {
    const result = normalizeUserRequest('[attached_image: /tmp/a.png]\nwhat is this?');
    expect(result).toBe('what is this?');
  });

  it('collapses whitespace', () => {
    expect(normalizeUserRequest('hello   world\n\n  foo')).toBe('hello world foo');
  });

  it('handles empty input', () => {
    expect(normalizeUserRequest('')).toBe('');
    expect(normalizeUserRequest(undefined as any)).toBe('');
  });
});

describe('imagePromptCacheKey', () => {
  it('produces deterministic SHA-256 hash', () => {
    const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' };
    const a = imagePromptCacheKey(img, 'what is this?', '');
    const b = imagePromptCacheKey(img, 'what is this?', '');
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // SHA-256 hex
  });

  it('differs by image data', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', '');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'B' }, 'req', '');
    expect(a).not.toBe(b);
  });

  it('differs by user request', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req1', '');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req2', '');
    expect(a).not.toBe(b);
  });

  it('differs by model signature', () => {
    const a = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', 'sig1');
    const b = imagePromptCacheKey({ type: 'image', mimeType: 'image/png', data: 'A' }, 'req', 'sig2');
    expect(a).not.toBe(b);
  });
});

describe('uniquePathsFromText', () => {
  it('extracts paths from attached_image markers using default parser', () => {
    const text = '[attached_image: /tmp/a.png] hello [attached_image: /tmp/b.png] world';
    const result = uniquePathsFromText(text, defaultMarkerParser);
    expect(result).toEqual(['/tmp/a.png', '/tmp/b.png']);
  });

  it('returns empty array when no markers', () => {
    expect(uniquePathsFromText('hello world', defaultMarkerParser)).toEqual([]);
  });

  it('handles empty text', () => {
    expect(uniquePathsFromText('', defaultMarkerParser)).toEqual([]);
  });
});

describe('contentText', () => {
  it('returns string content as-is', () => {
    expect(contentText('hello')).toBe('hello');
  });

  it('extracts text from ContentBlock[]', () => {
    expect(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('skips non-text blocks', () => {
    expect(contentText([
      { type: 'text', text: 'hello ' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('returns empty string for non-array non-string', () => {
    expect(contentText(null as any)).toBe('');
  });
});

describe('replaceTextContent', () => {
  it('replaces string content', () => {
    expect(replaceTextContent('hello', (s) => s.toUpperCase())).toBe('HELLO');
  });

  it('replaces text blocks in array content', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
    ];
    const result = replaceTextContent(content, (s) => s.toUpperCase());
    expect((result as any)[0].text).toBe('HELLO');
    expect((result as any)[1]).toEqual(content[1]); // image unchanged
  });

  it('returns unchanged array when no text changes', () => {
    const content = [{ type: 'text', text: 'hello' }];
    const result = replaceTextContent(content, (s) => s);
    expect(result).toBe(content); // same reference
  });

  it('returns non-array content as-is', () => {
    expect(replaceTextContent(42 as any, (s) => s)).toBe(42);
  });
});

describe('extractJsonObject', () => {
  it('parses raw JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON embedded in text', () => {
    expect(extractJsonObject('Here is the result: {"a":1} done')).toEqual({ a: 1 });
  });

  it('returns null for invalid JSON', () => {
    expect(extractJsonObject('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('clampNorm', () => {
  it('clamps to [0, 1000]', () => {
    expect(clampNorm(-5)).toBe(0);
    expect(clampNorm(500)).toBe(500);
    expect(clampNorm(1500)).toBe(1000);
  });

  it('returns null for NaN/Infinity', () => {
    expect(clampNorm(NaN)).toBeNull();
    expect(clampNorm(Infinity)).toBeNull();
  });
});

describe('normalizeConfidence', () => {
  it('clamps to [0, 1]', () => {
    expect(normalizeConfidence(-0.5)).toBe(0);
    expect(normalizeConfidence(0.73)).toBe(0.73);
    expect(normalizeConfidence(1.5)).toBe(1);
  });

  it('returns null for undefined/null/NaN', () => {
    expect(normalizeConfidence(undefined)).toBeNull();
    expect(normalizeConfidence(null)).toBeNull();
    expect(normalizeConfidence(NaN)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证全部失败**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/utils.test.ts
```
预计: 全部 FAIL — 模块不存在

- [ ] **Step 3: 实现 src/core/utils.ts**

```ts
import crypto from 'crypto';

// === 默认标记解析器 ===
// 保持对 openhanako 格式的兼容，但 agent 可注入自定义解析器
const ATTACHED_IMAGE_RE = /\[attached_image:\s*([^\]]+)\]/g;

export function defaultMarkerParser(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = ATTACHED_IMAGE_RE.exec(text || '')) !== null) {
    paths.push(m[1].trim());
  }
  return paths;
}

export type MarkerParser = (text: string) => string[];

// === 文本处理 ===
export function normalizeUserRequest(text: string): string {
  return String(text || '')
    .replace(/\[attached_image:\s*[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function uniquePathsFromText(text: string, parser: MarkerParser): string[] {
  return parser(text || '');
}

// === 缓存键 ===
export function imagePromptCacheKey(
  img: { mimeType?: string; data?: string },
  userRequest: string,
  modelSignature: string = '',
): string {
  const h = crypto.createHash('sha256');
  h.update(img?.mimeType || 'image/png');
  h.update('\0');
  h.update(img?.data || '');
  h.update('\0');
  h.update(userRequest || '');
  h.update('\0');
  h.update(modelSignature || '');
  return h.digest('hex');
}

// === 内容提取 ===
export function contentText(content: string | { type: string; text?: string }[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

export function replaceTextContent(
  content: string | { type: string; text?: string }[] | undefined,
  replacer: (text: string) => string,
): string | { type: string; text?: string }[] {
  if (typeof content === 'string') return replacer(content);
  if (!Array.isArray(content)) return content ?? '';
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== 'text') return block;
    const text = block.text || '';
    const replaced = replacer(text);
    if (replaced !== text) changed = true;
    return replaced !== text ? { ...block, text: replaced } : block;
  });
  return changed ? next : content;
}

// === JSON 提取 ===
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 优先匹配 fenced code block
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const primary = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(primary) as Record<string, unknown>;
  } catch {
    const start = primary.indexOf('{');
    const end = primary.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(primary.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

// === 数值归一化 ===
export function clampNorm(value: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

export function normalizeConfidence(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}
```

- [ ] **Step 4: 运行测试验证全部通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/utils.test.ts
```
预计: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/utils.ts tests/utils.test.ts
git commit -m "feat: add utility functions — text processing, cache keys, JSON extraction"
```

---

### Task 5: 提示词模板

**Files:**
- Create: `src/core/prompts.ts`
- Test: `tests/prompts.test.ts`

**Goal:** 迁移 openhanako 的提示词生成逻辑 — 基础模式 (8 段式) 和结构化模式 (JSON + primitives)，适配 Gemini/Qwen/Anchor 三种输出格式

- [ ] **Step 1: 写测试**

`tests/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildBasicPrompt, buildStructuredPrompt, primitivePromptShape } from '../src/core/prompts.js';
import type { VisionCapabilities } from '../src/core/types.js';

describe('buildBasicPrompt', () => {
  it('includes user request in the prompt', () => {
    const { system, user } = buildBasicPrompt('analyze this error');
    expect(system).toContain('Analyze this image');
    expect(system).toContain('image_overview');
    expect(system).toContain('visible_text');
    expect(system).toContain('user_request_answer');
    expect(user).toContain('analyze this error');
  });

  it('handles empty user request', () => {
    const { user } = buildBasicPrompt('');
    expect(user).toContain('(no explicit text request)');
  });
});

describe('primitivePromptShape', () => {
  it('returns hanako format by default', () => {
    const shape = primitivePromptShape();
    expect(shape[0]).toContain('visual_primitives');
    expect(shape[2]).toContain('box');
  });

  it('returns gemini format with box_2d and yxyx order', () => {
    const shape = primitivePromptShape({ boxOrder: 'yxyx', outputFormat: 'gemini' } as VisionCapabilities);
    expect(shape[0]).toContain('box_2d');
    expect(shape[2]).toContain('[ymin, xmin, ymax, xmax]');
  });

  it('returns qwen format with bbox_2d and point_2d', () => {
    const shape = primitivePromptShape({ outputFormat: 'qwen' } as VisionCapabilities);
    expect(shape[0]).toContain('bbox_2d');
    expect(shape[0]).toContain('point_2d');
  });

  it('returns anchor format with visual_anchors', () => {
    const shape = primitivePromptShape({ outputFormat: 'anchor' } as VisionCapabilities);
    expect(shape[0]).toContain('visual_anchors');
    expect(shape[0]).toContain('center');
  });
});

describe('buildStructuredPrompt', () => {
  it('includes all required JSON fields in prompt', () => {
    const { system } = buildStructuredPrompt('find the error', { boxes: true } as VisionCapabilities);
    expect(system).toContain('image_overview');
    expect(system).toContain('visible_text');
    expect(system).toContain('objects_and_layout');
    expect(system).toContain('user_request_answer');
    expect(system).toContain('evidence');
    expect(system).toContain('uncertainty');
    expect(system).toContain('Return only one valid JSON object');
  });

  it('includes point instruction when visionCapabilities has points', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: true } as VisionCapabilities);
    expect(system).toContain('include point or center coordinates');
  });

  it('excludes point instruction when no points support', () => {
    const { system } = buildStructuredPrompt('test', { boxes: false, points: false } as VisionCapabilities);
    expect(system).toContain('Do not output point primitives');
  });
});
```

- [ ] **Step 2: 运行测试验证全部失败**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/prompts.test.ts
```
预计: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/core/prompts.ts**

```ts
import type { VisionCapabilities } from './types.js';

const MAX_PRIMITIVE_REF_CHARS = 96;

export function primitiveBoxOrderLabel(visionCapabilities?: VisionCapabilities): string {
  return visionCapabilities?.boxOrder === 'yxyx'
    ? '[ymin, xmin, ymax, xmax]'
    : '[x1, y1, x2, y2]';
}

export function primitivePromptShape(visionCapabilities?: VisionCapabilities): string[] {
  const format = visionCapabilities?.outputFormat || 'hanako';
  if (format === 'gemini') {
    return [
      '  "visual_primitives": [',
      '    {"id":"v1","type":"box","label":"short label","box_2d":[0,0,0,0],"confidence":0.0}',
      '  ]',
      'For Gemini-family models, use box_2d with the native [ymin, xmin, ymax, xmax] order normalized to 0-1000.',
    ];
  }
  if (format === 'qwen') {
    return [
      '  "visual_primitives": [',
      '    {"id":"v1","label":"short label","bbox_2d":[0,0,0,0],"point_2d":[0,0],"confidence":0.0}',
      '  ]',
      'For Qwen-family models, use bbox_2d as [x1, y1, x2, y2] and point_2d as [x, y], normalized to 0-1000.',
    ];
  }
  if (format === 'anchor') {
    return [
      '  "visual_anchors": [',
      '    {"id":"v1","label":"short label","role":"button|text|object|region","center":[0,0],"box":[0,0,0,0],"confidence":0.0}',
      '  ]',
      'For computer-use style models, prefer visual_anchors with center [x, y] for clickable or salient targets, plus box [x1, y1, x2, y2] when visible.',
    ];
  }
  return [
    '  "visual_primitives": [',
    '    {"id":"v1","type":"box","ref":"short label","box":[0,0,0,0],"confidence":0.0}',
    '  ]',
    `For boxes, output the box array as ${primitiveBoxOrderLabel(visionCapabilities)} normalized to 0-1000.`,
  ];
}

export function buildBasicPrompt(userRequest: string): { system: string; user: string } {
  const system = [
    'Analyze this image for another text-only model.',
    'Return a concise paper note with these exact sections:',
    'image_overview: fixed basic description of what the image is.',
    'visible_text: important OCR or readable text.',
    'objects_and_layout: important objects, positions, counts, and relationships.',
    'charts_or_data: chart/table/data details if present; otherwise say none.',
    'user_request: restate the user\'s request in one short sentence.',
    'user_request_answer: answer the user\'s request using the image when possible.',
    'evidence: the visual evidence supporting that answer.',
    'uncertainty: anything unclear, hidden, or guessed.',
    'Do not mention that you are a tool or a separate model.',
  ].join('\n');

  const user = `User request:\n${userRequest || '(no explicit text request)'}`;

  return { system, user };
}

export function buildStructuredPrompt(
  userRequest: string,
  visionCapabilities: VisionCapabilities,
): { system: string; user: string } {
  const shape = primitivePromptShape(visionCapabilities);
  const system = [
    'Analyze this image for another text-only model.',
    'Return only one valid JSON object. Do not wrap it in Markdown.',
    'Use this exact shape:',
    '{',
    '  "image_overview": "fixed basic description of what the image is",',
    '  "visible_text": ["important OCR or readable text"],',
    '  "objects_and_layout": "important objects, positions, counts, and relationships",',
    '  "charts_or_data": "chart/table/data details if present; otherwise none",',
    '  "user_request": "restate the user request in one short sentence",',
    '  "user_request_answer": "answer the user request using the image when possible",',
    '  "evidence": "visual evidence supporting that answer",',
    '  "uncertainty": "anything unclear, hidden, or guessed",',
    ...shape.slice(0, 3),
    '}',
    shape[3],
    visionCapabilities.points
      ? 'You may include point or center coordinates as [x, y] normalized to 0-1000.'
      : 'Do not output point primitives.',
    'Include only coordinates that matter for the user request or key spatial evidence.',
    'Do not mention that you are a tool or a separate model.',
  ].join('\n');

  const user = `User request:\n${userRequest || '(no explicit text request)'}`;

  return { system, user };
}
```

- [ ] **Step 4: 运行测试验证全部通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/prompts.test.ts
```
预计: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/prompts.ts tests/prompts.test.ts
git commit -m "feat: add vision model prompt templates (basic + structured)"
```

---

### Task 6: Formatters — 分析结果格式化为文本块

**Files:**
- Create: `src/core/formatters.ts`
- Test: `tests/formatters.test.ts`

**Goal:** 迁移 `formatStructuredVisionNote`, `formatVisualPrimitives`, `normalizePrimitive`, `normalizeBox`, `normalizePoint` 等函数

- [ ] **Step 1: 写测试**

`tests/formatters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  formatStructuredVisionNote,
  formatVisualPrimitives,
  formatInvalidStructuredNote,
  normalizePrimitive,
  normalizeBox,
  normalizePoint,
  safeSection,
} from '../src/core/formatters.js';
import type { VisionCapabilities, VisionPrimitive, StructuredAnalysis } from '../src/core/types.js';

describe('safeSection', () => {
  it('returns string value as-is', () => {
    expect(safeSection('hello')).toBe('hello');
  });

  it('returns fallback for empty string', () => {
    expect(safeSection('')).toBe('none');
    expect(safeSection(undefined)).toBe('none');
  });

  it('joins array values with semicolons', () => {
    expect(safeSection(['a', 'b', 'c'])).toBe('a; b; c');
  });
});

describe('normalizeBox', () => {
  it('normalizes xyxy ordered box', () => {
    const result = normalizeBox([100, 200, 300, 400]);
    expect(result).toEqual([100, 200, 300, 400]);
  });

  it('normalizes yxyx ordered box to xyxy', () => {
    const result = normalizeBox([200, 100, 400, 300], { boxOrder: 'yxyx' } as VisionCapabilities);
    expect(result).toEqual([100, 200, 300, 400]);
  });

  it('swaps coordinates when left > right', () => {
    const result = normalizeBox([300, 200, 100, 400]);
    expect(result).toEqual([100, 200, 300, 400]);
  });

  it('returns null for zero-area box', () => {
    expect(normalizeBox([100, 200, 100, 400])).toBeNull();
    expect(normalizeBox([100, 200, 300, 200])).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(normalizeBox([100])).toBeNull();
    expect(normalizeBox([100, 200, 300, NaN])).toBeNull();
    expect(normalizeBox(undefined as any)).toBeNull();
  });

  it('clamps to 0-1000', () => {
    const result = normalizeBox([-50, 200, 1200, 400]);
    expect(result).toEqual([0, 200, 1000, 400]);
  });
});

describe('normalizePoint', () => {
  it('normalizes a point', () => {
    expect(normalizePoint([500, 600])).toEqual([500, 600]);
  });

  it('returns null for invalid input', () => {
    expect(normalizePoint([100])).toBeNull();
    expect(normalizePoint(undefined as any)).toBeNull();
  });

  it('clamps to 0-1000', () => {
    expect(normalizePoint([-10, 1500])).toEqual([0, 1000]);
  });
});

describe('normalizePrimitive', () => {
  const caps: VisionCapabilities = { boxes: true, points: true, boxOrder: 'xyxy' };

  it('normalizes box primitive', () => {
    const raw = { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.9 };
    const result = normalizePrimitive(raw, 0, caps);
    expect(result).toMatchObject({ id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400] });
    expect(result?.confidence).toBe(0.9);
  });

  it('normalizes point primitive', () => {
    const raw = { id: 'p1', label: 'cursor', point: [500, 600] };
    const result = normalizePrimitive(raw, 0, { ...caps, boxes: false });
    expect(result).toMatchObject({ id: 'p1', type: 'point', ref: 'cursor', point: [500, 600] });
  });

  it('returns null when no box or point', () => {
    const raw = { id: 'v1', label: 'nothing' };
    expect(normalizePrimitive(raw, 0, { boxes: false, points: false } as VisionCapabilities)).toBeNull();
  });

  it('uses fallback id from index', () => {
    const raw = { ref: 'thing', box: [10, 20, 30, 40] };
    const result = normalizePrimitive(raw, 2, caps);
    expect(result?.id).toBe('v3');
  });
});

describe('formatVisualPrimitives', () => {
  const primitives: VisionPrimitive[] = [
    { id: 'v1', type: 'box', ref: 'save button', box: [100, 200, 300, 400], confidence: 0.95, grounding: 'native' },
    { id: 'v2', type: 'point', ref: 'cursor', point: [500, 600], confidence: null, grounding: 'prompted' },
  ];

  it('formats primitives with coord info', () => {
    const result = formatVisualPrimitives(primitives, 'native');
    expect(result).toContain('<visual-primitives coord="norm-1000" box_order="xyxy" grounding="native">');
    expect(result).toContain('v1 | type: box | box: [100, 200, 300, 400]');
    expect(result).toContain('v2 | type: point | point: [500, 600]');
    expect(result).toContain('</visual-primitives>');
  });

  it('formats empty primitives with unavailable grounding', () => {
    const result = formatVisualPrimitives([], 'unavailable');
    expect(result).toContain('reason: no valid coordinates');
  });
});

describe('formatStructuredVisionNote', () => {
  it('formats a complete analysis into a note string', () => {
    const analysis: StructuredAnalysis = {
      image_overview: 'A settings dialog',
      visible_text: ['Save', 'Cancel'],
      objects_and_layout: 'Two buttons at bottom',
      charts_or_data: 'none',
      user_request: 'where is Save?',
      user_request_answer: 'Bottom right corner',
      evidence: 'Button labeled "Save" visible',
      uncertainty: 'Dialog may be modal',
      visual_primitives: [
        { id: 'v1', type: 'box', ref: 'Save button', box: [700, 800, 900, 850], confidence: 0.88 },
      ],
    };
    const result = formatStructuredVisionNote(analysis, { boxes: true, boxOrder: 'xyxy' } as VisionCapabilities);
    expect(result).toContain('image_overview: A settings dialog');
    expect(result).toContain('visible_text: Save; Cancel');
    expect(result).toContain('user_request_answer: Bottom right corner');
    expect(result).toContain('<visual-primitives');
    expect(result).toContain('v1 | type: box | box: [700, 800, 900, 850]');
  });
});

describe('formatInvalidStructuredNote', () => {
  it('returns fallback note with unavailable primitives', () => {
    const result = formatInvalidStructuredNote('garbled response {');
    expect(result).toContain('structured vision analysis unavailable');
    expect(result).toContain('garbled response {');
    expect(result).toContain('grounding="unavailable"');
  });
});
```

- [ ] **Step 2: 运行测试验证全部失败**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/formatters.test.ts
```
预计: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/core/formatters.ts**

```ts
import type { VisionCapabilities, VisionPrimitive, StructuredAnalysis } from './types.js';
import { clampNorm, normalizeConfidence } from './utils.js';

const MAX_NOTE_CHARS = 3200;
const MAX_PRIMITIVE_REF_CHARS = 96;
const MAX_VISUAL_PRIMITIVES = 16;
const VISUAL_PRIMITIVES_START = '<visual-primitives';
const VISUAL_PRIMITIVES_END = '</visual-primitives>';

export function safeSection(value: unknown, fallback = 'none'): string {
  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item || '').trim()).filter(Boolean).join('; ');
    return joined || fallback;
  }
  const s = String(value || '').trim();
  return s || fallback;
}

export function truncate(text: string, max = MAX_NOTE_CHARS): string {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 20)}\n[truncated]` : s;
}

export function normalizeBox(
  rawBox: unknown,
  visionCapabilities?: VisionCapabilities,
): [number, number, number, number] | null {
  if (!Array.isArray(rawBox) || rawBox.length !== 4) return null;
  const coords = rawBox.map(clampNorm);
  if (coords.some((n) => n === null)) return null;

  let x1: number, y1: number, x2: number, y2: number;
  if (visionCapabilities?.boxOrder === 'yxyx') {
    [y1, x1, y2, x2] = coords as number[];
  } else {
    [x1, y1, x2, y2] = coords as number[];
  }

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  if (left === right || top === bottom) return null;
  return [left, top, right, bottom];
}

export function normalizePoint(rawPoint: unknown): [number, number] | null {
  if (!Array.isArray(rawPoint) || rawPoint.length !== 2) return null;
  const point = rawPoint.map(clampNorm);
  if (point.some((n) => n === null)) return null;
  return point as [number, number];
}

function primitiveLabel(raw: Record<string, unknown>, fallbackId: string): string {
  const source = raw?.ref ?? raw?.label ?? raw?.text ?? raw?.name ?? raw?.id ?? fallbackId;
  const s = String(source || fallbackId).replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_PRIMITIVE_REF_CHARS) || fallbackId;
}

function primitiveId(raw: Record<string, unknown>, index: number): string {
  const candidate = String(raw?.id || `v${index + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return candidate || `v${index + 1}`;
}

export function normalizePrimitive(
  raw: Record<string, unknown>,
  index: number,
  visionCapabilities?: VisionCapabilities,
): VisionPrimitive | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawBox = (raw as any).box ?? (raw as any).bbox ?? (raw as any).bbox_2d ?? (raw as any).box_2d;
  const rawPoint = (raw as any).point ?? (raw as any).point_2d ?? (raw as any).center;

  const box = visionCapabilities?.boxes ? normalizeBox(rawBox, visionCapabilities) : null;
  if (box) {
    return {
      id: primitiveId(raw as Record<string, unknown>, index),
      type: 'box',
      ref: primitiveLabel(raw as Record<string, unknown>, `v${index + 1}`),
      box,
      confidence: normalizeConfidence((raw as any).confidence),
      grounding: visionCapabilities?.groundingMode || 'native',
    };
  }

  const point = visionCapabilities?.points ? normalizePoint(rawPoint) : null;
  if (point) {
    return {
      id: primitiveId(raw as Record<string, unknown>, index),
      type: 'point',
      ref: primitiveLabel(raw as Record<string, unknown>, `v${index + 1}`),
      point,
      confidence: normalizeConfidence((raw as any).confidence),
      grounding: visionCapabilities?.groundingMode || 'native',
    };
  }

  return null;
}

function rawVisualPrimitiveItems(analysis: Record<string, unknown>): unknown[] {
  if (Array.isArray((analysis as any)?.visual_primitives)) return (analysis as any).visual_primitives;
  if (Array.isArray((analysis as any)?.visual_anchors)) return (analysis as any).visual_anchors;
  if (Array.isArray((analysis as any)?.anchors)) return (analysis as any).anchors;
  return [];
}

function normalizeVisualPrimitives(items: unknown[], visionCapabilities?: VisionCapabilities): VisionPrimitive[] {
  if (!Array.isArray(items)) return [];
  const normalized: VisionPrimitive[] = [];
  for (let i = 0; i < items.length && normalized.length < MAX_VISUAL_PRIMITIVES; i++) {
    const primitive = normalizePrimitive(items[i] as Record<string, unknown>, i, visionCapabilities);
    if (primitive) normalized.push(primitive);
  }
  return normalized;
}

export function formatVisualPrimitives(primitives: VisionPrimitive[], groundingMode = 'unavailable'): string {
  if (!primitives.length) {
    return [
      `${VISUAL_PRIMITIVES_START} coord="norm-1000" box_order="xyxy" grounding="unavailable">`,
      '- unavailable | reason: no valid coordinates',
      VISUAL_PRIMITIVES_END,
    ].join('\n');
  }
  const lines = primitives.map((p) => {
    const coord = p.type === 'box'
      ? `box: [${p.box!.join(', ')}]`
      : `point: [${p.point!.join(', ')}]`;
    const confidence = p.confidence === null ? '' : ` | confidence: ${p.confidence.toFixed(2)}`;
    return `- ${p.id} | type: ${p.type} | ${coord} | ref: ${p.ref}${confidence} | grounding: ${p.grounding}`;
  });
  return [
    `${VISUAL_PRIMITIVES_START} coord="norm-1000" box_order="xyxy" grounding="${groundingMode}">`,
    ...lines,
    VISUAL_PRIMITIVES_END,
  ].join('\n');
}

export function formatStructuredVisionNote(
  analysis: StructuredAnalysis,
  visionCapabilities?: VisionCapabilities,
): string {
  const primitives = normalizeVisualPrimitives(rawVisualPrimitiveItems(analysis as Record<string, unknown>), visionCapabilities);
  const sections = [
    `image_overview: ${safeSection(analysis?.image_overview)}`,
    `visible_text: ${safeSection(analysis?.visible_text)}`,
    `objects_and_layout: ${safeSection(analysis?.objects_and_layout)}`,
    `charts_or_data: ${safeSection(analysis?.charts_or_data)}`,
    `user_request: ${safeSection(analysis?.user_request)}`,
    `user_request_answer: ${safeSection(analysis?.user_request_answer)}`,
    `evidence: ${safeSection(analysis?.evidence)}`,
    `uncertainty: ${safeSection(analysis?.uncertainty)}`,
  ];
  const primitiveBlock = formatVisualPrimitives(primitives, visionCapabilities?.groundingMode);
  return truncate(`${sections.join('\n')}\n\n${primitiveBlock}`);
}

export function formatInvalidStructuredNote(rawResponse: string): string {
  const primitiveBlock = formatVisualPrimitives([]);
  return truncate([
    'image_overview: structured vision analysis unavailable.',
    'visible_text: none.',
    'objects_and_layout: none.',
    'charts_or_data: none.',
    'user_request: see original message.',
    'user_request_answer: The auxiliary vision model returned invalid structured JSON, so coordinate evidence was not used.',
    `evidence: raw response excerpt: ${truncate(rawResponse, 700)}`,
    'uncertainty: visual primitives unavailable because the response could not be parsed.',
    '',
    primitiveBlock,
  ].join('\n'));
}
```

- [ ] **Step 4: 运行测试验证全部通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/formatters.test.ts
```
预计: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/formatters.ts tests/formatters.test.ts
git commit -m "feat: add formatters — coordinate normalization, vision note rendering"
```

---

### Task 7: 缓存系统

**Files:**
- Create: `src/core/cache.ts`
- Test: `tests/cache.test.ts`

**Goal:** 实现 LRU 内存缓存 + 文件系统持久化后端 (CacheBackend 接口)

- [ ] **Step 1: 写测试**

`tests/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LRUCache, FileCacheBackend, MemoryCacheBackend } from '../src/core/cache.js';

describe('LRUCache', () => {
  let cache: LRUCache<{ value: string }>;

  beforeEach(() => {
    cache = new LRUCache<{ value: string }>(3);
  });

  it('stores and retrieves values', () => {
    cache.set('a', { value: 'alpha' });
    expect(cache.get('a')).toEqual({ value: 'alpha' });
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('checks existence with has()', () => {
    cache.set('a', { value: 'x' });
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('deletes entries', () => {
    cache.set('a', { value: 'x' });
    cache.delete('a');
    expect(cache.has('a')).toBe(false);
  });

  it('clears all entries', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('evicts oldest entries when exceeding capacity', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.set('d', { value: 'fourth' });
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('LRU: accessing an entry moves it to the end', () => {
    cache.set('a', { value: 'first' });
    cache.set('b', { value: 'second' });
    cache.set('c', { value: 'third' });
    cache.get('a'); // access 'a' to make it recently used
    cache.set('d', { value: 'fourth' });
    // 'b' should be evicted, not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('exposes keys and size', () => {
    cache.set('a', { value: 'x' });
    cache.set('b', { value: 'y' });
    expect(cache.size).toBe(2);
    expect(cache.keys()).toEqual(['a', 'b']);
  });
});

describe('MemoryCacheBackend', () => {
  it('implements CacheBackend interface', () => {
    const backend = new MemoryCacheBackend();
    expect(backend.has('a')).toBe(false);
    backend.set('a', 'value');
    expect(backend.has('a')).toBe(true);
    expect(backend.get('a')).toBe('value');
    backend.delete('a');
    expect(backend.has('a')).toBe(false);

    backend.set('a', 'a');
    backend.set('b', 'b');
    backend.clear();
    expect(backend.has('a')).toBe(false);
    expect(backend.has('b')).toBe(false);
  });
});

describe('FileCacheBackend', () => {
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-cache-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('persists values to disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    expect(backend.has('key1')).toBe(true);
    expect(backend.get('key1')).toBe('value1');
  });

  it('survives backend re-creation (disk persistence)', () => {
    const dir = makeDir();
    const b1 = new FileCacheBackend(dir);
    b1.set('key1', 'value1');

    const b2 = new FileCacheBackend(dir);
    expect(b2.has('key1')).toBe(true);
    expect(b2.get('key1')).toBe('value1');
  });

  it('delete removes from disk', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('key1', 'value1');
    backend.delete('key1');
    expect(backend.has('key1')).toBe(false);

    const b2 = new FileCacheBackend(dir);
    expect(b2.has('key1')).toBe(false);
  });

  it('clear removes all entries', () => {
    const dir = makeDir();
    const backend = new FileCacheBackend(dir);
    backend.set('a', '1');
    backend.set('b', '2');
    backend.clear();
    expect(backend.has('a')).toBe(false);
    expect(backend.has('b')).toBe(false);
  });

  it('creates directory if not exists', () => {
    const dir = path.join(makeDir(), 'nonexistent', 'subdir');
    const backend = new FileCacheBackend(dir);
    backend.set('key', 'val');
    expect(backend.get('key')).toBe('val');
  });
});
```

- [ ] **Step 2: 运行测试验证全部失败**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/cache.test.ts
```
预计: FAIL

- [ ] **Step 3: 实现 src/core/cache.ts**

```ts
import fs from 'fs';
import path from 'path';
import type { CacheBackend } from '../adapters/types.js';

export class LRUCache<T> {
  private _map = new Map<string, T>();
  private _max: number;

  constructor(maxEntries: number) {
    this._max = maxEntries;
  }

  get(key: string): T | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    // move to end (most recent)
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    this._map.set(key, value);
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      if (oldest) this._map.delete(oldest);
    }
  }

  has(key: string): boolean {
    return this._map.has(key);
  }

  delete(key: string): void {
    this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  keys(): string[] {
    return [...this._map.keys()];
  }
}

export class MemoryCacheBackend implements CacheBackend {
  private _store = new Map<string, string>();

  get(key: string): string | null {
    return this._store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this._store.set(key, value);
  }

  has(key: string): boolean {
    return this._store.has(key);
  }

  delete(key: string): void {
    this._store.delete(key);
  }

  clear(): void {
    this._store.clear();
  }
}

export class FileCacheBackend implements CacheBackend {
  private _dir: string;
  private _filePath: string;

  constructor(dir: string, filename = 'vision-bridge-cache.json') {
    this._dir = dir;
    this._filePath = path.join(dir, filename);
    this._ensureDir();
  }

  private _ensureDir(): void {
    fs.mkdirSync(this._dir, { recursive: true });
  }

  private _read(): Record<string, string> {
    try {
      const raw = fs.readFileSync(this._filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return {};
    } catch (err: any) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  private _write(data: Record<string, string>): void {
    const tmp = `${this._filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, this._filePath);
  }

  get(key: string): string | null {
    return this._read()[key] ?? null;
  }

  set(key: string, value: string): void {
    const data = this._read();
    data[key] = value;
    this._write(data);
  }

  has(key: string): boolean {
    return key in this._read();
  }

  delete(key: string): void {
    const data = this._read();
    delete data[key];
    this._write(data);
  }

  clear(): void {
    this._write({});
  }
}
```

- [ ] **Step 4: 运行测试验证全部通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/cache.test.ts
```
预计: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/cache.ts tests/cache.test.ts
git commit -m "feat: add LRU cache + File/Memory CacheBackend implementations"
```

---

### Task 8: VisionBridge 核心类

**Files:**
- Create: `src/core/vision-bridge.ts`
- Test: `tests/vision-bridge.test.ts`

**Goal:** VisionBridge 核心类 — `analyze()` + `injectIntoMessages()` + `needsBridge()`。此任务最大，包含完整的集成测试（参考 openhanako 测试套件）

- [ ] **Step 1: 写测试**

`tests/vision-bridge.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VisionBridge } from '../src/core/vision-bridge.js';
import { VISION_CONTEXT_START, VISION_CONTEXT_END, VISUAL_PRIMITIVES_START, VISUAL_PRIMITIVES_END } from '../src/core/vision-bridge.js';
import type { LLMAdapter, CallOptions } from '../src/adapters/types.js';
import type { VisionCapabilitiesResolver } from '../src/core/vision-bridge.js';

const BASIC_NOTE = [
  'image_overview: A desk screenshot with a red error banner.',
  'user_request_answer: The screenshot shows an error state relevant to the question.',
  'evidence: red banner and visible editor layout.',
  'uncertainty: exact line number is unclear.',
].join('\n');

const pathA = '/tmp/upload-a.png';

function makeAdapter(responseText = BASIC_NOTE): LLMAdapter {
  return {
    supportsImages: vi.fn(() => true),
    call: vi.fn(async () => responseText),
  };
}

function makeBridge(
  adapter: LLMAdapter = makeAdapter(),
  capsResolver?: VisionCapabilitiesResolver,
  maxCacheEntries = 256,
) {
  return new VisionBridge({
    adapter,
    config: {
      visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
      visionCapabilitiesResolver: capsResolver ?? (() => null),
    },
    maxCacheEntries,
  });
}

describe('VisionBridge', () => {
  describe('needsBridge', () => {
    it('returns true for text-only model', () => {
      const bridge = makeBridge();
      expect(bridge.needsBridge({ id: 'deepseek-chat', provider: 'deepseek', input: ['text'] })).toBe(true);
    });

    it('returns false for vision-capable model', () => {
      const bridge = makeBridge();
      expect(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] })).toBe(false);
    });

    it('returns false for model without input array', () => {
      const bridge = makeBridge();
      expect(bridge.needsBridge({ id: 'gpt-4o', provider: 'openai' })).toBe(false);
    });
  });

  describe('analyze', () => {
    it('does nothing for image-capable target models', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const result = await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: 'what is this?',
        targetModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      });

      expect(adapter.call).not.toHaveBeenCalled();
      expect(result.images).toBeDefined();
    });

    it('analyzes text-only model images and returns vision notes', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);

      const result = await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      expect(adapter.call).toHaveBeenCalledTimes(1);
      expect(result.images).toBeUndefined();
      expect(result.visionNotes).toHaveLength(1);
      expect(result.visionNotes[0]).toContain('image_overview');
    });

    it('throws when text-only target has images but no vision model', async () => {
      const adapter = makeAdapter();
      const bridge = new VisionBridge({
        adapter,
        // visionModel without input array → can't be validated as image-capable
        config: {
          visionModel: { id: 'broken', provider: 'test' },
        },
      });

      // The adapter says this vision model doesn't support images
      adapter.supportsImages = vi.fn(() => false);

      await expect(bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: 'what?',
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
      })).rejects.toThrow(/vision auxiliary model must support image input/i);
    });

    it('reuses cached analysis for same image + same request', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);

      const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' } as const;

      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: /tmp/other.png]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: ['/tmp/other.png'],
      });

      expect(adapter.call).toHaveBeenCalledTimes(1);
    });

    it('does not reuse cached analysis for different user request on same image', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);
      const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' } as const;

      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: ${pathA}]\nhow many kittens?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });
      await bridge.analyze({
        images: [img],
        userRequest: `[attached_image: /tmp/other.png]\nwhat color?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: ['/tmp/other.png'],
      });

      expect(adapter.call).toHaveBeenCalledTimes(2);
    });

    it('does not reuse across different auxiliary vision models', async () => {
      let model: any = { id: 'kimi-k2.6', provider: 'kimi', input: ['text', 'image'] };
      const adapter: LLMAdapter = {
        supportsImages: vi.fn(() => true),
        call: vi.fn()
          .mockResolvedValueOnce('image_overview: note-only analysis'),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: model,
          visionCapabilitiesResolver: () => null,
        },
      });

      const img = { type: 'image', mimeType: 'image/png', data: 'BASE64' } as const;
      const params = {
        images: [img],
        userRequest: `[attached_image: ${pathA}]\nwhat?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] } as const,
        imagePaths: [pathA],
      };

      await bridge.analyze(params);

      model = { id: 'qwen-vl-plus', provider: 'dashscope', input: ['text', 'image'] };
      const bridge2 = new VisionBridge({
        adapter: {
          supportsImages: vi.fn(() => true),
          call: vi.fn(async () => JSON.stringify({
            image_overview: 'Grounded analysis',
            visual_primitives: [{ id: 'v1', type: 'box', ref: 'banner', box: [20, 30, 120, 220] }],
          })),
        },
        config: {
          visionModel: model,
          visionCapabilitiesResolver: () => ({ boxes: true, boxOrder: 'xyxy' } as any),
        },
      });

      await bridge2.analyze(params);

      // Different bridge instances → different vision models → no cache sharing
      expect(adapter.call).toHaveBeenCalledTimes(1);
    });
  });

  describe('injectIntoMessages', () => {
    it('injects vision context into user messages with attached image markers', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is this?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat is this?` }] },
      ]);

      expect(result.injected).toBe(1);
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISION_CONTEXT_START);
      expect(text).toContain('image_overview');
      expect(text).toContain(VISION_CONTEXT_END);
    });

    it('injects only into the user message that has an image marker', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nfirst question`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nfirst question` }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
      ]);

      expect(result.injected).toBe(1);
      const text0 = (result.messages[0].content as any)[0].text;
      expect(text0).toContain(VISION_CONTEXT_START);
      const text2 = (result.messages[2].content as any)[0].text;
      expect(text2).toBe('follow-up');
    });

    it('does not double-inject when VISION_CONTEXT_START already present', async () => {
      const adapter = makeAdapter();
      const bridge = makeBridge(adapter);

      const result = bridge.injectIntoMessages([
        { role: 'user', content: `${VISION_CONTEXT_START}\nold note\n${VISION_CONTEXT_END}\n\ntext` },
      ]);

      expect(result.injected).toBe(0);
    });
  });

  describe('disk persistence', () => {
    const tmpDirs: string[] = [];

    function makeDir(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-test-'));
      tmpDirs.push(dir);
      return dir;
    }

    afterEach(() => {
      for (const d of tmpDirs) {
        fs.rmSync(d, { recursive: true, force: true });
      }
      tmpDirs.length = 0;
    });

    it('restores vision notes from disk after bridge is gone', async () => {
      const dir = makeDir();
      const sessionId = path.join(dir, 'session');
      const imagePath = path.join(dir, 'upload.png');
      const adapter = makeAdapter();

      const b1 = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          persistDir: dir,
        },
      });

      await b1.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${imagePath}]\nwhat?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [imagePath],
        sessionId,
      });

      // New bridge, no analyze call
      const b2 = new VisionBridge({
        adapter: { supportsImages: () => true, call: vi.fn() },
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          persistDir: dir,
        },
      });

      const result = b2.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${imagePath}]\nwhat?` }] },
      ], sessionId);

      expect(result.injected).toBe(1);
      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISION_CONTEXT_START);
    });
  });

  describe('grounding: structured mode', () => {
    it('routes Gemini models through box_2d format', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A UI screenshot with a red error banner.',
          visual_primitives: [
            { id: 'banner', type: 'box', label: 'red error banner', box_2d: [100, 200, 180, 760], confidence: 0.92 },
          ],
        })),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gemini-3-flash', provider: 'gemini', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({
            boxes: true, points: false, coordinateSpace: 'norm-1000',
            boxOrder: 'yxyx', outputFormat: 'gemini', groundingMode: 'native',
          }),
        },
      });

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhere is the error?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhere is the error?` }] },
      ]);

      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISUAL_PRIMITIVES_START);
      expect(text).toContain('coord="norm-1000"');
      // yxyx [100, 200, 180, 760] → xyxy [200, 100, 760, 180]
      expect(text).toMatch(/box:\s*\[200,\s*100,\s*760,\s*180\]/);
      expect(text).toContain('red error banner');
      expect(text).toContain(VISUAL_PRIMITIVES_END);
    });

    it('routes Qwen models through bbox_2d + point_2d format', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A settings screen.',
          visual_primitives: [
            { id: 'save', label: 'save button', bbox_2d: [710, 820, 930, 890], confidence: 0.84 },
            { id: 'toggle', label: 'theme toggle', point_2d: [320, 240], confidence: 0.77 },
          ],
        })),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'qwen-vl', provider: 'dashscope', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({
            boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'qwen', groundingMode: 'native',
          }),
        },
      });

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhere to save?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhere to save?` }] },
      ]);

      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('box: [710, 820, 930, 890]');
      expect(text).toContain('point: [320, 240]');
    });

    it('routes anchor format for computer-use models', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A browser page.',
          visual_anchors: [
            { id: 'submit', label: 'submit button', role: 'button', center: [840, 310], confidence: 0.71 },
          ],
        })),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'claude-sonnet', provider: 'anthropic', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({
            boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted',
          }),
        },
      });

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat to click?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat to click?` }] },
      ]);

      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('point: [840, 310]');
      expect(text).toContain('grounding: prompted');
    });

    it('keeps stable unavailable primitive block when no coordinates returned', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => JSON.stringify({
          image_overview: 'A document.',
          visual_primitives: [],
        })),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => ({
            boxes: true, points: true, boxOrder: 'xyxy', outputFormat: 'anchor', groundingMode: 'prompted',
          }),
        },
      });

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat is on screen?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat is on screen?` }] },
      ]);

      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain(VISUAL_PRIMITIVES_START);
      expect(text).toContain('grounding="unavailable"');
    });

    it('uses note-only routing for models without grounding capability', async () => {
      const adapter: LLMAdapter = {
        supportsImages: () => true,
        call: vi.fn(async () => 'image_overview: basic note analysis'),
      };

      const bridge = new VisionBridge({
        adapter,
        config: {
          visionModel: { id: 'kimi-k2', provider: 'kimi', input: ['text', 'image'] },
          visionCapabilitiesResolver: () => null, // no grounding
        },
      });

      await bridge.analyze({
        images: [{ type: 'image', mimeType: 'image/png', data: 'BASE64' }],
        userRequest: `[attached_image: ${pathA}]\nwhat?`,
        targetModel: { id: 'deepseek-chat', provider: 'deepseek', input: ['text'] },
        imagePaths: [pathA],
      });

      const result = bridge.injectIntoMessages([
        { role: 'user', content: [{ type: 'text', text: `[attached_image: ${pathA}]\nwhat?` }] },
      ]);

      const text = (result.messages[0].content as any)[0].text;
      expect(text).toContain('image_overview: basic note analysis');
      expect(text).not.toContain(VISUAL_PRIMITIVES_START);
    });
  });
});
```

- [ ] **Step 2: 运行测试验证全部失败**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/vision-bridge.test.ts
```
预计: FAIL — VisionBridge 类不存在

- [ ] **Step 3: 实现 src/core/vision-bridge.ts**

```ts
import type { LLMAdapter, MarkerParser, VisionCapabilitiesResolver } from '../adapters/types.js';
import { FileCacheBackend } from './cache.js';
import { formatInvalidStructuredNote, formatStructuredVisionNote } from './formatters.js';
import {
  buildBasicPrompt,
  buildStructuredPrompt,
  primitivePromptShape,
} from './prompts.js';
import type {
  ImageContentBlock,
  LLMMessage,
  VisionBridgeConfig,
  VisionCapabilities,
  VisionModelRef,
  AnalyzeParams,
  AnalyzeResult,
  InjectResult,
  CacheEntry,
} from './types.js';
import {
  contentText,
  defaultMarkerParser,
  imagePromptCacheKey,
  normalizeUserRequest,
  replaceTextContent,
  uniquePathsFromText,
  extractJsonObject,
  truncateFormatter,
} from './utils.js';

export type { VisionCapabilitiesResolver } from '../adapters/types.js';

function compactModelRef(model: VisionModelRef | undefined): VisionModelRef | null {
  return model?.id && model?.provider ? { id: model.id, provider: model.provider } : null;
}

function visionModelCacheSignature(
  model: VisionModelRef | undefined,
  visionCapabilities: VisionCapabilities | null,
): string {
  return JSON.stringify({
    provider: model?.provider || '',
    id: model?.id || '',
    visionCapabilities: visionCapabilities || null,
  });
}

const DEFAULT_MAX_NOTE_CHARS = 3200;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VISUAL_PRIMITIVES = 16;

export const VISION_CONTEXT_START = '<vision-context>';
export const VISION_CONTEXT_END = '</vision-context>';

function hasExplicitTextOnlyInput(model?: VisionModelRef): boolean {
  return Array.isArray(model?.input) && !model.input.includes('image');
}

export class VisionBridge {
  private _adapter: LLMAdapter;
  private _config: VisionBridgeConfig;
  private _markerParser: MarkerParser;
  private _capsResolver: VisionCapabilitiesResolver;
  private _analysisByPrompt: Map<string, { note: string; createdAt: number; lastUsedAt: number }>;
  private _noteByPath: Map<string, CacheEntry>;
  private _persistBackend: FileCacheBackend | null;
  private _maxCacheEntries: number;
  private _maxNoteChars: number;
  private _timeoutMs: number;
  private _now: () => number;

  constructor({
    adapter,
    config,
    persistBackend,
    now,
  }: {
    adapter: LLMAdapter;
    config: VisionBridgeConfig;
    persistBackend?: FileCacheBackend;
    now?: () => number;
  }) {
    this._adapter = adapter;
    this._config = config;
    this._markerParser = config.markerParser || defaultMarkerParser;
    this._capsResolver = config.visionCapabilitiesResolver || (() => null);
    this._persistBackend = persistBackend || (config.persistDir ? new FileCacheBackend(config.persistDir) : null);
    this._maxCacheEntries = config.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES;
    this._maxNoteChars = config.maxNoteChars || DEFAULT_MAX_NOTE_CHARS;
    this._timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this._now = now || (() => Date.now());
    this._analysisByPrompt = new Map();
    this._noteByPath = new Map();
  }

  needsBridge(model?: VisionModelRef): boolean {
    return hasExplicitTextOnlyInput(model);
  }

  async analyze(params: AnalyzeParams & { targetModel?: VisionModelRef }): Promise<AnalyzeResult> {
    const { images, userRequest, sessionId, imagePaths, targetModel } = params;

    if (!images?.length) {
      return { text: userRequest, images: undefined as any, visionNotes: [] };
    }

    if (!hasExplicitTextOnlyInput(targetModel)) {
      return { text: userRequest, images: images as any, visionNotes: [] };
    }

    const visionModel = this._config.visionModel;
    if (!visionModel?.id) {
      throw new Error('vision auxiliary model is required for image input with the current text-only model');
    }
    if (!this._adapter.supportsImages(visionModel)) {
      throw new Error('vision auxiliary model must support image input');
    }

    const paths = imagePaths?.length ? imagePaths : this._markerParser(userRequest);
    const cleanedRequest = normalizeUserRequest(userRequest);
    const notes: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const note = await this._analyzeImage(img, i, cleanedRequest);
      const imagePath = paths[i];
      if (imagePath) {
        const entry: CacheEntry = {
          note,
          sessionPath: sessionId || null,
          imagePath,
          userRequest: cleanedRequest,
          visionModel: compactModelRef(visionModel),
          targetModel: compactModelRef(targetModel),
          updatedAt: this._now(),
        };
        this._noteByPath.set(imagePath, entry);
        this._trimNoteCache();
        if (sessionId && this._persistBackend) {
          this._persistNote(sessionId, imagePath, entry);
        }
      }
      notes.push(note);
    }

    return { text: userRequest, images: undefined as any, visionNotes: notes };
  }

  injectIntoMessages(messages: LLMMessage[], sessionId?: string): InjectResult {
    if (!Array.isArray(messages)) return { messages, injected: 0 };
    let injected = 0;

    const next = messages.map((msg) => {
      if (!msg || typeof msg !== 'object') return msg;
      if (msg.role !== 'user') return msg;
      const text = contentText(msg.content);
      if (!text || text.includes(VISION_CONTEXT_START)) return msg;

      const entries = uniquePathsFromText(text, this._markerParser)
        .map((imagePath) => [imagePath, this._lookupNote(sessionId, imagePath)] as const)
        .filter(([, entry]) => !!entry);

      if (!entries.length) return msg;

      const noteText = entries.map(([, entry], idx) => {
        return `image_${idx + 1}: ${entry!.note}`;
      }).join('\n\n');
      const block = `${VISION_CONTEXT_START}\n${noteText}\n${VISION_CONTEXT_END}\n\n`;

      const replacedContent = replaceTextContent(msg.content, (oldText) => {
        const localPaths = uniquePathsFromText(oldText, this._markerParser);
        const localHits = entries.filter(([imagePath]) => localPaths.includes(imagePath));
        if (!localHits.length) return oldText;
        injected += localHits.length;
        return `${block}${oldText}`;
      });
      return replacedContent === msg.content ? msg : { ...msg, content: replacedContent };
    });

    return { messages: injected ? next : messages, injected };
  }

  async _analyzeImage(img: ImageContentBlock, index: number, userRequest: string): Promise<string> {
    const visionModel = this._config.visionModel;
    const visionCapabilities = this._capsResolver(visionModel);
    const key = imagePromptCacheKey(
      img,
      userRequest,
      visionModelCacheSignature(visionModel, visionCapabilities),
    );

    const cached = this._analysisByPrompt.get(key);
    if (cached) {
      cached.lastUsedAt = this._now();
      return cached.note;
    }

    const note = visionCapabilities
      ? await this._analyzeImageWithPrimitives(img, userRequest, visionCapabilities)
      : await this._analyzeImageAsNote(img, userRequest);

    this._analysisByPrompt.set(key, {
      note,
      createdAt: this._now(),
      lastUsedAt: this._now(),
    });
    this._trimCache();
    return note;
  }

  async _analyzeImageAsNote(img: ImageContentBlock, userRequest: string): Promise<string> {
    const prompts = buildBasicPrompt(userRequest);
    const response = await this._adapter.call(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompts.system },
            { type: 'text', text: prompts.user },
            img,
          ],
        },
      ],
      {
        model: this._config.visionModel.id!,
        apiKey: this._config.visionModel.apiKey,
        baseURL: this._config.visionModel.baseURL,
        maxTokens: 900,
        timeoutMs: this._timeoutMs,
      },
    );
    return truncateFormatter(response, this._maxNoteChars);
  }

  async _analyzeImageWithPrimitives(
    img: ImageContentBlock,
    userRequest: string,
    visionCapabilities: VisionCapabilities,
  ): Promise<string> {
    const prompts = buildStructuredPrompt(userRequest, visionCapabilities);
    const response = await this._adapter.call(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompts.system },
            { type: 'text', text: prompts.user },
            img,
          ],
        },
      ],
      {
        model: this._config.visionModel.id!,
        apiKey: this._config.visionModel.apiKey,
        baseURL: this._config.visionModel.baseURL,
        maxTokens: 1100,
        timeoutMs: this._timeoutMs,
      },
    );

    const analysis = extractJsonObject(response);
    if (!analysis) return formatInvalidStructuredNote(response);
    return formatStructuredVisionNote(analysis, visionCapabilities);
  }

  _persistNote(sessionId: string, imagePath: string, entry: CacheEntry): void {
    if (!this._persistBackend) return;
    const key = `${sessionId}::${imagePath}`;
    this._persistBackend.set(key, JSON.stringify(entry));
  }

  _lookupNote(sessionId: string | undefined, imagePath: string): CacheEntry | null {
    // Check memory first
    const memoryEntry = this._noteByPath.get(imagePath);
    if (memoryEntry && (!sessionId || !memoryEntry.sessionPath || memoryEntry.sessionPath === sessionId)) {
      return memoryEntry;
    }

    // Check disk persistence
    if (!sessionId || !this._persistBackend) return null;
    const key = `${sessionId}::${imagePath}`;
    const raw = this._persistBackend.get(key);
    if (!raw) return null;

    try {
      const entry = JSON.parse(raw) as CacheEntry;
      if (!entry?.note) return null;
      const restored: CacheEntry = {
        ...entry,
        sessionPath: sessionId,
        imagePath,
        updatedAt: entry.updatedAt || this._now(),
      };
      this._noteByPath.set(imagePath, restored);
      this._trimNoteCache();
      return restored;
    } catch {
      return null;
    }
  }

  _trimCache(): void {
    if (this._analysisByPrompt.size <= this._maxCacheEntries) return;
    const entries = [...this._analysisByPrompt.entries()]
      .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
    for (const [key] of entries.slice(0, this._analysisByPrompt.size - this._maxCacheEntries)) {
      this._analysisByPrompt.delete(key);
    }
  }

  _trimNoteCache(): void {
    if (this._noteByPath.size <= this._maxCacheEntries) return;
    const entries = [...this._noteByPath.entries()]
      .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    for (const [key] of entries.slice(0, this._noteByPath.size - this._maxCacheEntries)) {
      this._noteByPath.delete(key);
    }
  }
}
```

- [ ] **Step 4: 添加 truncateFormatter 到 utils.ts**

```ts
// 在 src/core/utils.ts 末尾添加
export function truncateFormatter(text: string, max = 3200): string {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 20)}\n[truncated]` : s;
}
```

- [ ] **Step 5: 运行测试验证通过**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/vision-bridge.test.ts
```
预计: 逐步让测试通过（可能需要微调导入路径等）

- [ ] **Step 6: 提交**

```bash
git add src/core/vision-bridge.ts src/core/utils.ts tests/vision-bridge.test.ts
git commit -m "feat: add VisionBridge core class — analyze, injectIntoMessages, needsBridge"
```

---

### Task 9: Main entry point + 集成测试

**Files:**
- Create: `src/index.ts`
- Test: `tests/integration.test.ts` (端到端集成测试)

- [ ] **Step 1: 创建主入口**

`src/index.ts`:

```ts
export { VisionBridge, VISION_CONTEXT_START, VISION_CONTEXT_END } from './core/vision-bridge.js';
export type { VisionCapabilitiesResolver } from './core/vision-bridge.js';
export { LRUCache, MemoryCacheBackend, FileCacheBackend } from './core/cache.js';
export * from './core/types.js';
export * from './adapters/types.js';
export { defaultMarkerParser } from './core/utils.js';
```

- [ ] **Step 2: 创建集成测试**

`tests/integration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { VisionBridge } from '../src/index.js';
import type { LLMAdapter } from '../src/index.js';

const pathA = '/tmp/upload-a.png';

describe('VisionBridge integration', () => {
  it('full analyze → inject round-trip with default marker parser', async () => {
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => [
        'image_overview: Terminal screenshot showing npm install errors.',
        'visible_text: ERR! code ENOENT',
        'user_request_answer: The package.json file is missing.',
        'evidence: Error text clearly visible.',
      ].join('\n')),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    // Phase 1
    const result = await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: `[attached_image: ${pathA}]\nanalyze this error`,
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
      imagePaths: [pathA],
    });

    expect(result.images).toBeUndefined();
    expect(result.visionNotes).toHaveLength(1);
    expect(result.visionNotes[0]).toContain('image_overview');

    // Phase 2
    const injected = bridge.injectIntoMessages([
      { role: 'user', content: `[attached_image: ${pathA}]\nanalyze this error` },
    ]);

    expect(injected.injected).toBe(1);
    const content = injected.messages[0].content;
    expect(typeof content === 'string' ? content : '').toContain('image_overview: Terminal screenshot');
  });

  it('gracefully handles missing user instructions', async () => {
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => 'image_overview: A blank screen.\nuser_request_answer: nothing actionable.'),
    };

    const bridge = new VisionBridge({
      adapter,
      config: {
        visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] },
      },
    });

    await bridge.analyze({
      images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      userRequest: '',
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
    });

    expect(adapter.call).toHaveBeenCalledTimes(1);
  });

  it('multiple images produce multiple notes', async () => {
    let callCount = 0;
    const adapter: LLMAdapter = {
      supportsImages: () => true,
      call: vi.fn(async () => {
        callCount++;
        return `image_overview: Image ${callCount} description.`;
      }),
    };

    const bridge = new VisionBridge({ adapter, config: { visionModel: { id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] } } });

    const result = await bridge.analyze({
      images: [
        { type: 'image', mimeType: 'image/png', data: 'IMG1' },
        { type: 'image', mimeType: 'image/png', data: 'IMG2' },
      ],
      userRequest: 'compare these',
      targetModel: { id: 'deepseek-v4', provider: 'deepseek', input: ['text'] },
      imagePaths: ['/tmp/a.png', '/tmp/b.png'],
    });

    expect(result.visionNotes).toHaveLength(2);
    expect(adapter.call).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: 运行所有测试**

```bash
cd /g/Code/vision-bridge && npx vitest run
```
预计: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/index.ts tests/integration.test.ts
git commit -m "feat: add main entry point + integration tests"
```

---

### Task 10: OpenAI 兼容适配器

**Files:**
- Create: `src/adapters/openai-compatible.ts`
- Test: `tests/adapters.test.ts`

- [ ] **Step 1: 创建适配器**

`src/adapters/openai-compatible.ts`:

```ts
import type { LLMAdapter, CallOptions } from './types.js';
import type { VisionMessage, VisionModelRef } from '../core/types.js';

export class OpenAICompatibleAdapter implements LLMAdapter {
  private _fetch: typeof fetch;
  private _defaultApiKey?: string;
  private _defaultBaseURL?: string;

  constructor(opts?: { fetch?: typeof fetch; apiKey?: string; baseURL?: string }) {
    this._fetch = opts?.fetch || globalThis.fetch.bind(globalThis);
    this._defaultApiKey = opts?.apiKey;
    this._defaultBaseURL = opts?.baseURL;
  }

  supportsImages(model: VisionModelRef): boolean {
    if (Array.isArray(model?.input)) {
      return model.input.includes('image');
    }
    // Best-effort: if no input array, assume it supports images
    return true;
  }

  async call(messages: VisionMessage[], options: CallOptions): Promise<string> {
    const apiKey = options.apiKey || this._defaultApiKey;
    const baseURL = options.baseURL || this._defaultBaseURL || 'https://api.openai.com/v1';

    const body = {
      model: options.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((block) => {
              if (block.type === 'text') return { type: 'text', text: block.text };
              if (block.type === 'image') {
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${block.mimeType};base64,${block.data}`,
                  },
                };
              }
              return block;
            }),
      })),
      max_tokens: options.maxTokens || 1024,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120_000);

    try {
      const response = await this._fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 500)}`);
      }

      const data = await response.json() as any;
      return data?.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [ ] **Step 2: 创建适配器测试**

`tests/adapters.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';

function createFetchMock(responseBody: any, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  }));
}

describe('OpenAICompatibleAdapter', () => {
  describe('supportsImages', () => {
    it('returns true for models with image in input array', () => {
      const adapter = new OpenAICompatibleAdapter();
      expect(adapter.supportsImages({ id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] })).toBe(true);
    });

    it('returns false for text-only models', () => {
      const adapter = new OpenAICompatibleAdapter();
      expect(adapter.supportsImages({ id: 'deepseek', provider: 'deepseek', input: ['text'] })).toBe(false);
    });
  });

  describe('call', () => {
    it('constructs correct request body', async () => {
      const fetchMock = createFetchMock({
        choices: [{ message: { content: 'analysis result' } }],
      });

      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock, baseURL: 'https://test.api/v1' });

      const result = await adapter.call(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this' },
              { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
            ],
          },
        ],
        { model: 'gpt-4o', apiKey: 'sk-test' },
      );

      expect(result).toBe('analysis result');

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.model).toBe('gpt-4o');
      expect(callBody.messages[0].content[0].type).toBe('text');
      expect(callBody.messages[0].content[1].type).toBe('image_url');
      expect(callBody.messages[0].content[1].image_url.url).toContain('data:image/png;base64,BASE64DATA');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
    });

    it('throws on non-200 response', async () => {
      const fetchMock = createFetchMock({ error: 'Unauthorized' }, 401);

      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });

      await expect(
        adapter.call(
          [{ role: 'user', content: 'test' }],
          { model: 'gpt-4o', apiKey: 'bad-key' },
        ),
      ).rejects.toThrow(/OpenAI API error 401/);
    });

    it('handles string content messages', async () => {
      const fetchMock = createFetchMock({
        choices: [{ message: { content: 'result' } }],
      });

      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });
      const result = await adapter.call(
        [{ role: 'user', content: 'hello' }],
        { model: 'gpt-4o' },
      );

      expect(result).toBe('result');
      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.messages[0].content).toBe('hello');
    });

    it('uses default apiKey and baseURL from constructor', async () => {
      const fetchMock = createFetchMock({
        choices: [{ message: { content: 'result' } }],
      });

      const adapter = new OpenAICompatibleAdapter({
        fetch: fetchMock,
        apiKey: 'sk-default',
        baseURL: 'https://default.api/v1',
      });

      await adapter.call([{ role: 'user', content: 'test' }], { model: 'gpt-4o' });

      expect(fetchMock.mock.calls[0][0]).toBe('https://default.api/v1/chat/completions');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-default');
    });
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/adapters.test.ts
```
预计: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add src/adapters/openai-compatible.ts tests/adapters.test.ts
git commit -m "feat: add OpenAI-compatible adapter"
```

---

### Task 11: Anthropic 适配器

**Files:**
- Create: `src/adapters/anthropic.ts`
- Modify: `tests/adapters.test.ts` (add Anthropic tests)

- [ ] **Step 1: 创建 Anthropic 适配器**

`src/adapters/anthropic.ts`:

```ts
import type { LLMAdapter, CallOptions } from './types.js';
import type { VisionMessage, VisionModelRef } from '../core/types.js';

export class AnthropicAdapter implements LLMAdapter {
  private _fetch: typeof fetch;
  private _defaultApiKey?: string;
  private _defaultBaseURL?: string;
  private _anthropicVersion: string;

  constructor(opts?: {
    fetch?: typeof fetch;
    apiKey?: string;
    baseURL?: string;
    anthropicVersion?: string;
  }) {
    this._fetch = opts?.fetch || globalThis.fetch.bind(globalThis);
    this._defaultApiKey = opts?.apiKey;
    this._defaultBaseURL = opts?.baseURL || 'https://api.anthropic.com';
    this._anthropicVersion = opts?.anthropicVersion || '2023-06-01';
  }

  supportsImages(model: VisionModelRef): boolean {
    if (Array.isArray(model?.input)) {
      return model.input.includes('image');
    }
    return true;
  }

  async call(messages: VisionMessage[], options: CallOptions): Promise<string> {
    const apiKey = options.apiKey || this._defaultApiKey;
    const baseURL = options.baseURL || this._defaultBaseURL;

    // Anthropic requires system prompt separated from messages
    let systemContent = '';
    const filtered = messages.filter((m) => {
      if (m.role === 'system') {
        systemContent += (typeof m.content === 'string' ? m.content : '');
        return false;
      }
      return true;
    });

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens || 1024,
      messages: filtered.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((block) => {
              if (block.type === 'text') return { type: 'text', text: block.text };
              if (block.type === 'image') {
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: block.mimeType || 'image/png',
                    data: block.data,
                  },
                };
              }
              return block;
            }),
      })),
    };

    if (systemContent) {
      body.system = systemContent;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120_000);

    try {
      const response = await this._fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey || '',
          'anthropic-version': this._anthropicVersion,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
      }

      const data = await response.json() as any;
      // Anthropic returns content array
      const content = data?.content;
      if (Array.isArray(content)) {
        return content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
      }
      return String(content || '');
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [ ] **Step 2: 在 tests/adapters.test.ts 中添加 Anthropic 测试用例**

在文件中追加：

```ts
import { AnthropicAdapter } from '../src/adapters/anthropic.js';

// ... 原有 OpenAI tests ...

describe('AnthropicAdapter', () => {
  describe('supportsImages', () => {
    it('returns true for Claude models with image input', () => {
      const adapter = new AnthropicAdapter();
      expect(adapter.supportsImages({ id: 'claude-sonnet-4-6', provider: 'anthropic', input: ['text', 'image'] })).toBe(true);
    });

    it('returns false for text-only models', () => {
      const adapter = new AnthropicAdapter();
      expect(adapter.supportsImages({ id: 'deepseek', provider: 'deepseek', input: ['text'] })).toBe(false);
    });
  });

  describe('call', () => {
    it('constructs correct Anthropic Messages API request', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ content: [{ type: 'text', text: 'analysis result' }] }),
      }));

      const adapter = new AnthropicAdapter({ fetch: fetchMock, baseURL: 'https://test.anthropic.com' });

      const result = await adapter.call(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this' },
              { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
            ],
          },
        ],
        { model: 'claude-sonnet-4-6', apiKey: 'sk-ant-test' },
      );

      expect(result).toBe('analysis result');

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.model).toBe('claude-sonnet-4-6');
      expect(callBody.messages[0].content[1].type).toBe('image');
      expect(callBody.messages[0].content[1].source.type).toBe('base64');
      expect(callBody.messages[0].content[1].source.media_type).toBe('image/png');
      expect(callBody.messages[0].content[1].source.data).toBe('BASE64DATA');
      expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-test');
      expect(fetchMock.mock.calls[0][1].headers['anthropic-version']).toBe('2023-06-01');
    });

    it('throws on non-200 response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => '{"error":{"message":"Forbidden"}}',
      }));

      const adapter = new AnthropicAdapter({ fetch: fetchMock });

      await expect(
        adapter.call(
          [{ role: 'user', content: 'test' }],
          { model: 'claude-sonnet-4-6', apiKey: 'bad-key' },
        ),
      ).rejects.toThrow(/Anthropic API error 403/);
    });
  });
});
```

需要同时在文件顶部添加 vi import：
```ts
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 3: 运行适配器测试**

```bash
cd /g/Code/vision-bridge && npx vitest run tests/adapters.test.ts
```
预计: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add src/adapters/anthropic.ts tests/adapters.test.ts
git commit -m "feat: add Anthropic Messages API adapter"
```

---

### Task 12: 最终验证 + npm 构建

- [ ] **Step 1: 运行全部测试**

```bash
cd /g/Code/vision-bridge && npx vitest run
```

- [ ] **Step 2: 构建 TypeScript**

```bash
cd /g/Code/vision-bridge && npx tsc --noEmit
```
预计: 无类型错误

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: finalize project structure, all tests passing"
```

---

## Plan Self-Review

**Spec coverage:** 所有 spec 要求已覆盖 — types, core bridge, cache, formatters, prompts, adapters, entry point

**Placeholder scan:** 无 TBD/TODO/占位符

**Type consistency:** 跨文件类型引用一致 (VisionMessage, LLMMessage, VisionModelRef, etc.)
