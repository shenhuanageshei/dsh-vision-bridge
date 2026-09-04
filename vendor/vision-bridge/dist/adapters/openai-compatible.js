export class OpenAICompatibleAdapter {
    _fetch;
    _defaultApiKey;
    _defaultBaseURL;
    constructor(opts) {
        this._fetch = opts?.fetch || globalThis.fetch.bind(globalThis);
        this._defaultApiKey = opts?.apiKey;
        this._defaultBaseURL = opts?.baseURL;
    }
    supportsImages(model) {
        if (Array.isArray(model?.input)) {
            return model.input.includes('image');
        }
        return true;
    }
    async call(messages, options) {
        const apiKey = options.apiKey || this._defaultApiKey;
        const baseURL = options.baseURL || this._defaultBaseURL || 'https://api.openai.com/v1';
        const body = {
            model: options.model,
            messages: messages.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string'
                    ? m.content
                    : m.content.map((block) => {
                        if (block.type === 'text')
                            return { type: 'text', text: block.text };
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
            const data = await response.json();
            return data?.choices?.[0]?.message?.content || '';
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
//# sourceMappingURL=openai-compatible.js.map