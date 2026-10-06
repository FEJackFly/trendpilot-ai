import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AnalyticsOverview, DraftStatus, PublishTaskStatus } from '@trendpilot/shared';
import { buildApp } from '../src/app.js';
import { queryAll, queryValue } from '../src/db/db.js';

const ALL_DRAFT_STATUSES: DraftStatus[] = ['draft', 'review', 'approved', 'queued', 'published', 'archived'];
const ALL_TASK_STATUSES: PublishTaskStatus[] = ['pending', 'scheduled', 'publishing', 'succeeded', 'failed', 'cancelled'];

async function getOverview(app: FastifyInstance): Promise<AnalyticsOverview> {
  const res = await app.inject({ method: 'GET', url: '/api/analytics/overview' });
  expect(res.statusCode).toBe(200);
  return res.json() as AnalyticsOverview;
}

describe('GET /api/analytics/overview（空库）', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ databasePath: ':memory:', seed: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('空库返回全 0，不报错', async () => {
    const o = await getOverview(app);
    expect(o.mode).toBe('demo');
    expect(new Date(o.generatedAt).toISOString()).toBe(o.generatedAt);
    for (const s of ALL_DRAFT_STATUSES) expect(o.draftsByStatus[s], `drafts ${s}`).toBe(0);
    for (const s of ALL_TASK_STATUSES) expect(o.tasksByStatus[s], `tasks ${s}`).toBe(0);
    expect(o.postsByTopic).toEqual([]);
    expect(o.recentActivity).toEqual([]);
    expect(o.publishingFunnel).toEqual({
      approved: 0, queued: 0, publishing: 0, succeeded: 0, failed: 0, cancelled: 0,
    });
    expect(o.dailyTrend).toHaveLength(30);
    expect(o.dailyTrend.every((d) => d.drafts === 0 && d.tasks === 0)).toBe(true);
  });
});

describe('GET /api/analytics/overview（已知数据）', () => {
  let app: FastifyInstance;
  const now = Date.now();

  /** 已知分布：草稿 3/2/1/2/1/1，任务 2/1/1/2/1/1。 */
  const DRAFT_PLAN: DraftStatus[] = [
    'draft', 'draft', 'draft',
    'review', 'review',
    'approved',
    'queued', 'queued',
    'published',
    'archived',
  ];
  const TASK_PLAN: PublishTaskStatus[] = [
    'pending', 'pending',
    'scheduled',
    'publishing',
    'succeeded', 'succeeded',
    'failed',
    'cancelled',
  ];

  beforeAll(() => {
    app = buildApp({ databasePath: ':memory:', seed: false });
    const db = app.db;

    // 草稿：updatedAt 递增，保证动态排序确定性。
    DRAFT_PLAN.forEach((status, i) => {
      const ts = now - (DRAFT_PLAN.length - i) * 1000;
      db.prepare(
        `INSERT INTO drafts (title, content, status, createdAt, updatedAt)
         VALUES (?, '正文', ?, ?, ?)`,
      ).run(`草稿${i + 1}`, status, ts, ts);
    });
    const draftIds = queryAll<{ id: number }>(db, 'SELECT id FROM drafts ORDER BY id').map((r) => r.id);

    // 任务：挂在前 8 篇草稿上，updatedAt 继续递增（比草稿更新）。
    TASK_PLAN.forEach((status, i) => {
      const ts = now - (TASK_PLAN.length - i) * 100;
      db.prepare(
        `INSERT INTO publish_tasks (draftId, mode, status, attempts, createdAt, updatedAt)
         VALUES (?, 'mock', ?, 0, ?, ?)`,
      ).run(draftIds[i], status, ts, ts);
    });

    // 帖子：AI Coding 2 篇（可手算平均分），设计 1 篇。
    const posts: Array<[string, number, number, number, number]> = [
      // topic, likes, reposts, replies, ageHours
      ['AI Coding', 100, 10, 20, 24],
      ['AI Coding', 0, 0, 0, 48],
      ['设计', 50, 5, 10, 12],
    ];
    posts.forEach(([topic, likes, reposts, replies, ageHours], i) => {
      const publishedAt = now - ageHours * 3_600_000;
      db.prepare(
        `INSERT INTO posts (source, authorHandle, text, topic, publishedAt, likes, reposts, replies, metricsCapturedAt, createdAt)
         VALUES ('mock', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`@author${i}`, `帖子${i}`, topic, publishedAt, likes, reposts, replies, now, now);
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('各状态计数与直接 SQL COUNT 一致', async () => {
    const o = await getOverview(app);
    const db = app.db;
    for (const s of ALL_DRAFT_STATUSES) {
      const expected = queryValue<number>(db, 'SELECT COUNT(*) AS c FROM drafts WHERE status = ?', s);
      expect(o.draftsByStatus[s], `drafts ${s}`).toBe(expected);
    }
    for (const s of ALL_TASK_STATUSES) {
      const expected = queryValue<number>(db, 'SELECT COUNT(*) AS c FROM publish_tasks WHERE status = ?', s);
      expect(o.tasksByStatus[s], `tasks ${s}`).toBe(expected);
    }
    expect(o.draftsByStatus).toEqual({ draft: 3, review: 2, approved: 1, queued: 2, published: 1, archived: 1 });
    expect(o.tasksByStatus).toEqual({
      pending: 2, scheduled: 1, publishing: 1, succeeded: 2, failed: 1, cancelled: 1,
    });
  });

  it('主题帖子数与 SQL COUNT 一致，平均分与手算公式一致', async () => {
    const o = await getOverview(app);
    const byTopic = new Map(o.postsByTopic.map((t) => [t.topic, t]));
    expect(byTopic.get('AI Coding')?.count).toBe(2);
    expect(byTopic.get('设计')?.count).toBe(1);
    // 手算：post1 engagement=100+20+30=150 → ln(151)*exp(-24/48)；post2 engagement=0 → 0。
    const expectedAvg = (Math.log(151) * Math.exp(-24 / 48) + 0) / 2;
    expect(byTopic.get('AI Coding')?.avgScore ?? NaN).toBeCloseTo(expectedAvg, 4);
    const designScore = Math.log(1 + (50 + 2 * 5 + 1.5 * 10)) * Math.exp(-12 / 48);
    expect(byTopic.get('设计')?.avgScore ?? NaN).toBeCloseTo(designScore, 4);
  });

  it('漏斗数字与 SQL COUNT 一致', async () => {
    const o = await getOverview(app);
    expect(o.publishingFunnel).toEqual({
      approved: 1, queued: 2, publishing: 1, succeeded: 2, failed: 1, cancelled: 1,
    });
  });

  it('近期动态取 10 条、按 updatedAt 倒序、type 区分', async () => {
    const o = await getOverview(app);
    expect(o.recentActivity).toHaveLength(10);
    const times = o.recentActivity.map((a) => a.updatedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const a of o.recentActivity) {
      expect(['draft', 'task']).toContain(a.type);
      expect(a.label.length).toBeGreaterThan(0);
    }
    // 任务 updatedAt 更新，应排在前面。
    expect(o.recentActivity[0].type).toBe('task');
  });

  it('近 30 天趋势：30 天全、有空天、当天计数正确', async () => {
    const o = await getOverview(app);
    expect(o.dailyTrend).toHaveLength(30);
    const dates = o.dailyTrend.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(o.dailyTrend.reduce((a, d) => a + d.drafts, 0)).toBe(10);
    expect(o.dailyTrend.reduce((a, d) => a + d.tasks, 0)).toBe(8);
    const today = o.dailyTrend[o.dailyTrend.length - 1];
    expect(today.drafts).toBe(10);
    expect(today.tasks).toBe(8);
    expect(o.dailyTrend.slice(0, 29).every((d) => d.drafts === 0 && d.tasks === 0)).toBe(true);
  });
});
