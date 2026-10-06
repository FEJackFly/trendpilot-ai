import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  AIError,
  MockAIProvider,
  OpenAICompatibleProvider,
  createAIProvider,
} from '../src/providers/ai.js';
import { aiErrorStatus } from '../src/providers/errors.js';
import { extractJson } from '../src/providers/prompts.js';

/** 假密钥：用于断言错误信息/日志中绝不出现密钥原文。 */
const FAKE_KEY = 'sk-test-fake-key-abcdef-12345';

const BASE_OPTS = {
  name: 'openai' as const,
  apiKey: FAKE_KEY,
  baseURL: 'https://example.test/v1',
  model: 'test-model',
};

function okFetch(payload: unknown): (url: string, init: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

function chatPayload(content: unknown) {
  return { choices: [{ message: { content } }] };
}

const ANALYZE_JSON = JSON.stringify({
  topic: 'AI Coding',
  coreClaims: ['观点1', '观点2'],
  structure: '多句递进论述',
  audienceNeeds: '开发者',
  contentAngles: ['角度1'],
  factCheckItems: ['核实项1'],
});

const SAMPLE_ANALYZE_INPUT = {
  id: 1,
  text: '示例文本',
  topic: '',
  authorHandle: 'tester',
  language: 'zh',
  url: '',
};

describe('createAIProvider 工厂', () => {
  it('mock 返回 MockAIProvider', () => {
    expect(createAIProvider({ ...env, AI_PROVIDER: 'mock' })).toBeInstanceOf(MockAIProvider);
  });

  it('openai 缺 AI_API_KEY 时实例化即抛 AI_NOT_CONFIGURED（fail fast）', () => {
    let caught: unknown;
    try {
      createAIProvider({ ...env, AI_PROVIDER: 'openai', AI_API_KEY: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AIError);
    expect((caught as AIError).code).toBe('AI_NOT_CONFIGURED');
    expect((caught as AIError).message).not.toContain(FAKE_KEY);
  });

  it('custom 缺 AI_BASE_URL 时抛 AI_NOT_CONFIGURED', () => {
    let caught: unknown;
    try {
      createAIProvider({ ...env, AI_PROVIDER: 'custom', AI_API_KEY: FAKE_KEY, AI_BASE_URL: '' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AIError);
    expect((caught as AIError).code).toBe('AI_NOT_CONFIGURED');
  });

  it('anthropic 缺 AI_BASE_URL 时抛 AI_NOT_CONFIGURED（官方协议不兼容，需网关）', () => {
    expect(() => createAIProvider({ ...env, AI_PROVIDER: 'anthropic', AI_API_KEY: FAKE_KEY, AI_BASE_URL: '' })).toThrowError(
      AIError,
    );
  });
});

describe('OpenAICompatibleProvider 错误路径（注入 fetch，不发起真实调用）', () => {
  it('超时 → AI_TIMEOUT，且 message 不含密钥', async () => {
    const hanging: (url: string, init: RequestInit) => Promise<Response> = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, timeoutMs: 60, fetchFn: hanging });
    let caught: unknown;
    try {
      await p.analyze(SAMPLE_ANALYZE_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AIError);
    expect((caught as AIError).code).toBe('AI_TIMEOUT');
    expect((caught as AIError).message).not.toContain(FAKE_KEY);
    expect(aiErrorStatus('AI_TIMEOUT')).toBe(504);
  });

  it('HTTP 401 → AI_UPSTREAM_ERROR（message 含状态码，不含密钥）', async () => {
    const unauthorized = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, fetchFn: unauthorized });
    let caught: unknown;
    try {
      await p.analyze(SAMPLE_ANALYZE_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AIError);
    expect((caught as AIError).code).toBe('AI_UPSTREAM_ERROR');
    expect((caught as AIError).message).toContain('401');
    expect((caught as AIError).message).not.toContain(FAKE_KEY);
  });

  it('非法 JSON → AI_BAD_RESPONSE', async () => {
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, fetchFn: okFetch(chatPayload('not json at all')) });
    await expect(p.analyze(SAMPLE_ANALYZE_INPUT)).rejects.toMatchObject({ code: 'AI_BAD_RESPONSE' });
  });

  it('JSON 缺字段 → AI_BAD_RESPONSE', async () => {
    const p = new OpenAICompatibleProvider({
      ...BASE_OPTS,
      fetchFn: okFetch(chatPayload(JSON.stringify({ topic: 'x' }))),
    });
    await expect(p.analyze(SAMPLE_ANALYZE_INPUT)).rejects.toMatchObject({ code: 'AI_BAD_RESPONSE' });
  });

  it('网络异常 → AI_UPSTREAM_ERROR', async () => {
    const broken = async () => {
      throw new Error('fetch failed');
    };
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, fetchFn: broken });
    await expect(p.analyze(SAMPLE_ANALYZE_INPUT)).rejects.toMatchObject({ code: 'AI_UPSTREAM_ERROR' });
  });
});

describe('OpenAICompatibleProvider 成功路径', () => {
  it('analyze 返回结构化结果（provider 取自实例名）', async () => {
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, fetchFn: okFetch(chatPayload(ANALYZE_JSON)) });
    const r = await p.analyze(SAMPLE_ANALYZE_INPUT);
    expect(r.topic).toBe('AI Coding');
    expect(r.coreClaims).toHaveLength(2);
    expect(r.provider).toBe('openai');
  });

  it('generateDraft 返回草稿结果（needsFactCheck=true）', async () => {
    const genJson = JSON.stringify({ title: '标题', content: '正文', keyPoints: ['要点1'] });
    const p = new OpenAICompatibleProvider({ ...BASE_OPTS, fetchFn: okFetch(chatPayload(genJson)) });
    const r = await p.generateDraft({
      sourcePostIds: [],
      mode: 'opinion',
      sourcePosts: [],
    });
    expect(r.title).toBe('标题');
    expect(r.needsFactCheck).toBe(true);
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('test-model');
  });

  it('容忍 markdown 代码围栏', async () => {
    const p = new OpenAICompatibleProvider({
      ...BASE_OPTS,
      fetchFn: okFetch(chatPayload('```json\n' + ANALYZE_JSON + '\n```')),
    });
    const r = await p.analyze(SAMPLE_ANALYZE_INPUT);
    expect(r.topic).toBe('AI Coding');
  });
});

describe('extractJson', () => {
  it('非法输入抛 AI_BAD_RESPONSE', () => {
    expect(() => extractJson('nope')).toThrowError(AIError);
  });
});
