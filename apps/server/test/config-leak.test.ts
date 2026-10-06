import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * 密钥泄露专项：必须用独立文件（独立的模块注册表），以便在 import app 之前
 * 先 stub 环境变量。config.test.ts 已做静态 import，不能复用。
 */
describe('GET /api/config/status 注入假密钥后响应体全文无泄露', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('AI_API_KEY / X_CLIENT_SECRET / X_BEARER_TOKEN 的值不出现在响应体中', async () => {
    vi.stubEnv('AI_API_KEY', 'sk-fake-inject-aaa111');
    vi.stubEnv('X_CLIENT_SECRET', 'xs-fake-inject-bbb222');
    vi.stubEnv('X_BEARER_TOKEN', 'bb-fake-inject-ccc333');
    const { buildApp } = await import('../src/app.js');
    const app = buildApp({ databasePath: ':memory:', seed: false });

    const res = await app.inject({ method: 'GET', url: '/api/config/status' });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).not.toContain('sk-fake-inject-aaa111');
    expect(raw).not.toContain('xs-fake-inject-bbb222');
    expect(raw).not.toContain('bb-fake-inject-ccc333');
    // 全文也不应出现密钥类字段名
    expect(raw).not.toMatch(/"ai_api_key"|"x_client_secret"|"x_bearer_token"/i);

    const body = res.json() as Record<string, unknown>;
    expect(body.aiConfigured).toBe(true); // 注入了 key，标志应为 true
    expect(body.publishingModes).toEqual(['mock']);

    await app.close();
  });
});
