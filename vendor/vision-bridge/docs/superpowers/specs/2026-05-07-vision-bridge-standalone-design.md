# Vision Bridge 独立插件设计

## 概述

将 openhanako 中的 vision-bridge 从 monorepo 剥离为独立 TypeScript npm 包 `@ti-agent/vision-bridge`，供任意 agent（Claude Code、ti-agent、OpenCode、Copilot 等）集成使用。

核心原理：文本专用模型无法处理图片输入时，自动调用视觉模型生成文本描述，缓存并注入到每次 LLM 调用中。

## 架构

```
src/
  core/
    vision-bridge.ts          # VisionBridge 类（核心，零外部运行时依赖）
    types.ts                  # 所有公共类型
    cache.ts                  # LRU 内存缓存 + 磁盘持久化后端
    prompts.ts                # 视觉模型提示词模板（基础模式 / 结构化模式）
    formatters.ts             # 分析结果 → 文本块格式化
  adapters/
    types.ts                  # LLMAdapter 接口定义
    openai-compatible.ts      # OpenAI 兼容协议适配器
    anthropic.ts              # Anthropic Messages API 适配器
  proxy/
    server.ts                 # 可选：本地 HTTP 代理服务器
    transformer.ts            # 请求改写：图片 → 文本描述
  index.ts                    # 主入口
tests/
  vision-bridge.test.ts
  adapters.test.ts
  cache.test.ts
  proxy.test.ts
package.json
tsconfig.json
```

## 数据流（两阶段）

```
Phase 1: analyze({images, userRequest, sessionId})
  → 检查 needsBridge(targetModel)
  → YES: 调用视觉模型 → 文本描述 → 写入缓存
  → NO: 透传原图片

Phase 2: injectIntoMessages(messages)
  → 扫描图片标记 → 查缓存 → 注入 <vision-context> 块
```

## 核心接口

```ts
interface VisionBridgeConfig {
  visionModel: {
    provider: 'openai-compatible' | 'anthropic'
    apiKey?: string
    baseURL?: string
    model: string
  }
  cache?: {
    maxEntries: number       // 默认 256
    persistDir?: string      // 磁盘持久化目录
  }
  markerParser?: (text: string) => string[]   // 图片路径提取函数
  visionCapabilitiesResolver?: (model: VisionModelRef) => VisionCapabilities | null
}

interface LLMAdapter {
  call(messages: VisionMessage[], options: CallOptions): Promise<string>
  supportsImages(model: VisionModelRef): boolean
}

interface CacheBackend {
  get(key: string): string | null
  set(key: string, value: string): void
  has(key: string): boolean
  delete(key: string): void
  clear(): void
}

class VisionBridge {
  constructor(opts: { adapter: LLMAdapter; config: VisionBridgeConfig; cache?: CacheBackend })
  async analyze(params: AnalyzeParams): Promise<AnalyzeResult>
  injectIntoMessages(messages: LLMMessage[], sessionId?: string): { messages: LLMMessage[]; injected: number }
  needsBridge(model: VisionModelRef): boolean
}
```

## 缓存策略

- Layer 1: 内存 LRU (maxEntries, 默认 256) — SHA-256(image + userRequest + model) key
- Layer 2: 磁盘 sidecar — `{persistDir}/vision-bridge-cache.json`，可插拔 CacheBackend
- 缓存 key 包含 model signature，不同视觉模型的分析结果隔离

## 两种分析模式

- 基础模式 (`_analyzeAsNote`): 无 grounding 能力的视觉模型，返回自由文本 8 段式描述
- 结构化模式 (`_analyzeWithPrimitives`): 有 grounding 能力的模型，返回 JSON + 可选的坐标 primitives

## 两种集成方式

### 库模式（推荐）

```ts
import { VisionBridge, OpenAIAdapter } from '@ti-agent/vision-bridge';

const bridge = new VisionBridge({
  adapter: new OpenAIAdapter(),
  config: {
    visionModel: { provider: 'openai-compatible', model: 'gpt-4o', apiKey: '...' },
    markerParser: (text) => {
      const matches = text.matchAll(/\[attached_image:\s*([^\]]+)\]/g);
      return [...matches].map(m => m[1]);
    }
  }
});

// Phase 1
const result = await bridge.analyze({ images, userRequest: '这个错误是什么？', sessionId: '/tmp/session-1' });
// Phase 2
const { messages } = bridge.injectIntoMessages(originalMessages, '/tmp/session-1');
```

### 代理模式

```bash
npx @ti-agent/vision-bridge proxy --port 9999 --vision-model gpt-4o
# 所有走 http://localhost:9999/v1 的请求自动拦截转换
```

## 集成示例

### Claude Code

```json
{ "hooks": { "pre-prompt": "claude-code-vision-bridge inject --session $SESSION_ID" } }
```

### ti-agent

管线预处理步骤，在 `QueryEngine.submit()` 的步骤 1.8→2 之间插入

### OpenCode

作为 plugin middleware 拦截消息流

### 任意 OpenAI SDK

设置 `baseURL` 指向本地代理即可

## 部署

- npm 安装: `npm install @ti-agent/vision-bridge`
- 需配置 `VISION_BRIDGE_API_KEY` 环境变量（或代码传入 apiKey）
- 磁盘缓存默认位置: `~/.vision-bridge/cache/`

## 非目标

- 不实现多视觉模型 fallback（超出 YAGNI）
- 不内置视频分析（当前只需静态图片）
- 不实现 client-side 加密（由 agent 自己处理）
