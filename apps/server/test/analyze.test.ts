import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('POST /api/posts/:id/analyze', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    // 内存数据库 + 自动种子 50 条 mock 帖子
    app = buildApp({ databasePath: ':memory:' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('返回结构完整且 provider 标识为 mock', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/posts/1/analyze' });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.postId).toBe(1);
    expect(body.provider).toBe('mock');
    expect(typeof body.topic).toBe('string');
    expect(Array.isArray(body.coreClaims)).toBe(true);
    expect((body.coreClaims as unknown[]).length).toBeGreaterThan(0);
    expect(typeof body.structure).toBe('string');
    expect(typeof body.audienceNeeds).toBe('string');
    expect(Array.isArray(body.contentAngles)).toBe(true);
    expect((body.contentAngles as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(body.factCheckItems)).toBe(true);
    expect((body.factCheckItems as unknown[]).length).toBeGreaterThan(0);
    expect(typeof body.createdAt).toBe('number');
    expect(typeof body.id).toBe('number');
  });

  it('重复分析生成新记录（简单起见不做去重）', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/posts/2/analyze' });
    const second = await app.inject({ method: 'POST', url: '/api/posts/2/analyze' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const b1 = first.json() as { id: number };
    const b2 = second.json() as { id: number };
    expect(b2.id).toBeGreaterThan(b1.id);

    const list = await app.inject({ method: 'GET', url: '/api/posts/2/analyses' });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { total: number };
    expect(listBody.total).toBeGreaterThanOrEqual(2);
  });

  it('帖子不存在 → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/posts/99999/analyze' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { code: string };
    expect(body.code).toBe('POST_NOT_FOUND');
  });

  it('非法 ID → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/posts/abc/analyze' });
    expect(res.statusCode).toBe(400);
  });
});
