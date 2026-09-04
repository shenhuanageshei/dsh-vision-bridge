import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';

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

    it('returns true for models without input array (best-effort)', () => {
      const adapter = new OpenAICompatibleAdapter();
      expect(adapter.supportsImages({ id: 'unknown', provider: 'unknown' })).toBe(true);
    });
  });

  describe('call', () => {
    it('constructs correct request body with text and image blocks', async () => {
      const fetchMock = createFetchMock({
        choices: [{ message: { content: 'analysis result' } }],
      });

      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock, baseURL: 'https://test.api/v1' });

      const result = await adapter.call(
        [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this' },
            { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
          ],
        }],
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
        adapter.call([{ role: 'user', content: 'test' }], { model: 'gpt-4o', apiKey: 'bad-key' }),
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

    it('handles empty choices gracefully', async () => {
      const fetchMock = createFetchMock({ choices: [] });
      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });

      const result = await adapter.call(
        [{ role: 'user', content: 'test' }],
        { model: 'gpt-4o' },
      );

      expect(result).toBe('');
    });
  });
});

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
        [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this' },
            { type: 'image', mimeType: 'image/png', data: 'BASE64DATA' },
          ],
        }],
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

    it('extracts text from content array response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          content: [
            { type: 'text', text: 'first part ' },
            { type: 'text', text: 'second part' },
          ],
        }),
      }));

      const adapter = new AnthropicAdapter({ fetch: fetchMock });
      const result = await adapter.call(
        [{ role: 'user', content: 'test' }],
        { model: 'claude-sonnet-4-6' },
      );

      expect(result).toBe('first part second part');
    });
  });
});
