import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../dist/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../dist/adapters/anthropic.js';
import { mockFn } from './_mock.mjs';

function createFetchMock(responseBody, status = 200) {
  return mockFn(async () => ({
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
      assert.equal(adapter.supportsImages({ id: 'gpt-4o', provider: 'openai', input: ['text', 'image'] }), true);
    });

    it('returns false for text-only models', () => {
      const adapter = new OpenAICompatibleAdapter();
      assert.equal(adapter.supportsImages({ id: 'deepseek', provider: 'deepseek', input: ['text'] }), false);
    });

    it('returns true for models without input array (best-effort)', () => {
      const adapter = new OpenAICompatibleAdapter();
      assert.equal(adapter.supportsImages({ id: 'unknown', provider: 'unknown' }), true);
    });
  });

  describe('call', () => {
    it('constructs correct request body with text and image blocks', async () => {
      const fetchMock = createFetchMock({ choices: [{ message: { content: 'analysis result' } }] });
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

      assert.equal(result, 'analysis result');
      const [url, init] = fetchMock.mock.calls[0];
      const callBody = JSON.parse(init.body);
      assert.equal(callBody.model, 'gpt-4o');
      assert.equal(callBody.messages[0].content[0].type, 'text');
      assert.equal(callBody.messages[0].content[1].type, 'image_url');
      assert.match(callBody.messages[0].content[1].image_url.url, /data:image\/png;base64,BASE64DATA/);
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
    });

    it('throws on non-200 response', async () => {
      const fetchMock = createFetchMock({ error: 'Unauthorized' }, 401);
      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });

      await assert.rejects(
        adapter.call([{ role: 'user', content: 'test' }], { model: 'gpt-4o', apiKey: 'bad-key' }),
        /OpenAI API error 401/,
      );
    });

    it('handles string content messages', async () => {
      const fetchMock = createFetchMock({ choices: [{ message: { content: 'result' } }] });
      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });
      const result = await adapter.call([{ role: 'user', content: 'hello' }], { model: 'gpt-4o' });

      assert.equal(result, 'result');
      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      assert.equal(callBody.messages[0].content, 'hello');
    });

    it('uses default apiKey and baseURL from constructor', async () => {
      const fetchMock = createFetchMock({ choices: [{ message: { content: 'result' } }] });
      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock, apiKey: 'sk-default', baseURL: 'https://default.api/v1' });

      await adapter.call([{ role: 'user', content: 'test' }], { model: 'gpt-4o' });

      assert.equal(fetchMock.mock.calls[0][0], 'https://default.api/v1/chat/completions');
      assert.equal(fetchMock.mock.calls[0][1].headers.Authorization, 'Bearer sk-default');
    });

    it('handles empty choices gracefully', async () => {
      const fetchMock = createFetchMock({ choices: [] });
      const adapter = new OpenAICompatibleAdapter({ fetch: fetchMock });

      const result = await adapter.call([{ role: 'user', content: 'test' }], { model: 'gpt-4o' });
      assert.equal(result, '');
    });
  });
});

describe('AnthropicAdapter', () => {
  describe('supportsImages', () => {
    it('returns true for Claude models with image input', () => {
      const adapter = new AnthropicAdapter();
      assert.equal(adapter.supportsImages({ id: 'claude-sonnet-4-6', provider: 'anthropic', input: ['text', 'image'] }), true);
    });

    it('returns false for text-only models', () => {
      const adapter = new AnthropicAdapter();
      assert.equal(adapter.supportsImages({ id: 'deepseek', provider: 'deepseek', input: ['text'] }), false);
    });
  });

  describe('call', () => {
    it('constructs correct Anthropic Messages API request', async () => {
      const fetchMock = mockFn(async () => ({
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

      assert.equal(result, 'analysis result');
      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      assert.equal(callBody.model, 'claude-sonnet-4-6');
      assert.equal(callBody.messages[0].content[1].type, 'image');
      assert.equal(callBody.messages[0].content[1].source.type, 'base64');
      assert.equal(callBody.messages[0].content[1].source.media_type, 'image/png');
      assert.equal(callBody.messages[0].content[1].source.data, 'BASE64DATA');
      assert.equal(fetchMock.mock.calls[0][1].headers['x-api-key'], 'sk-ant-test');
      assert.equal(fetchMock.mock.calls[0][1].headers['anthropic-version'], '2023-06-01');
    });

    it('throws on non-200 response', async () => {
      const fetchMock = mockFn(async () => ({
        ok: false,
        status: 403,
        text: async () => '{"error":{"message":"Forbidden"}}',
      }));

      const adapter = new AnthropicAdapter({ fetch: fetchMock });

      await assert.rejects(
        adapter.call([{ role: 'user', content: 'test' }], { model: 'claude-sonnet-4-6', apiKey: 'bad-key' }),
        /Anthropic API error 403/,
      );
    });

    it('extracts text from content array response', async () => {
      const fetchMock = mockFn(async () => ({
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
      const result = await adapter.call([{ role: 'user', content: 'test' }], { model: 'claude-sonnet-4-6' });

      assert.equal(result, 'first part second part');
    });
  });
});
