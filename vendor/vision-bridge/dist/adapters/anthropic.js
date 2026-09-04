export class AnthropicAdapter {
    _fetch;
    _defaultApiKey;
    _defaultBaseURL;
    _anthropicVersion;
    constructor(opts) {
        this._fetch = opts?.fetch || globalThis.fetch.bind(globalThis);
        this._defaultApiKey = opts?.apiKey;
        this._defaultBaseURL = opts?.baseURL;
        this._anthropicVersion = opts?.anthropicVersion || '2023-06-01';
    }
    supportsImages(model) {
        if (Array.isArray(model?.input)) {
            return model.input.includes('image');
        }
        return false;
    }
    async call(messages, options) {
        const apiKey = options.apiKey || this._defaultApiKey;
        const baseURL = options.baseURL || this._defaultBaseURL || 'https://api.anthropic.com';
        const body = {
            model: options.model,
            max_tokens: options.maxTokens || 1024,
            messages: messages.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string'
                    ? m.content
                    : m.content.map((block) => {
                        if (block.type === 'text')
                            return { type: 'text', text: block.text };
                        if (block.type === 'image') {
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: block.mimeType,
                                    data: block.data,
                                },
                            };
                        }
                        return block;
                    }),
            })),
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120_000);
        try {
            const response = await this._fetch(`${baseURL}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'anthropic-version': this._anthropicVersion,
                    ...(apiKey ? { 'x-api-key': apiKey } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
            }
            const data = await response.json();
            const contentBlocks = data?.content || [];
            return contentBlocks
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join('');
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
//# sourceMappingURL=anthropic.js.map