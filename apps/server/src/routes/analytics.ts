import type { FastifyInstance } from 'fastify';
import type {
  ActivityItem,
  AnalyticsOverview,
  DailyTrendPoint,
  DraftStatus,
  PublishingFunnel,
  PublishTaskStatus,
  TopicStat,
} from '@trendpilot/shared';
import type { Db } from '../db/db.js';
import { queryAll, queryValue } from '../db/db.js';
import { ageHoursOf, engagementOf, hotScore } from '../services/score.js';

/**
 * 数据复盘路由（文档第 5、8 节）。
 * GET /api/analytics/overview：仪表盘与复盘页的全部汇总数据。
 * 所有数字均为 SQLite 实际记录的 COUNT / 聚合结果，不编造；
 * mode 由服务端硬编码为 'demo'（本阶段只有演示数据，前端不得自行改标）。
 */

const RESPONSE_MODE = 'demo' as const;

/** 全状态零值表（保证空库时返回全 0，而非缺 key）。 */
const ALL_DRAFT_STATUSES: DraftStatus[] = ['draft', 'review', 'approved', 'queued', 'published', 'archived'];
const ALL_TASK_STATUSES: PublishTaskStatus[] = ['pending', 'scheduled', 'publishing', 'succeeded', 'failed', 'cancelled'];

interface StatusCountRow {
  status: string;
  count: number;
}

interface PostScoreRow {
  topic: string;
  likes: number;
  reposts: number;
  replies: number;
  publishedAt: number;
}

interface TopicCountRow {
  topic: string;
  count: number;
}

interface ActivityRow {
  type: 'draft' | 'task';
  id: number;
  label: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** yyyy-MM-dd（本地时区），用于按天聚合。 */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function registerAnalyticsRoutes(app: FastifyInstance, db: Db): void {
  app.get('/analytics/overview', async (): Promise<AnalyticsOverview> => {
    const now = Date.now();

    // 各状态草稿数 / 任务数：直接 COUNT，全状态补 0。
    const draftsByStatus = Object.fromEntries(ALL_DRAFT_STATUSES.map((s) => [s, 0])) as Record<DraftStatus, number>;
    for (const row of queryAll<StatusCountRow>(db, 'SELECT status, COUNT(*) AS count FROM drafts GROUP BY status')) {
      if (row.status in draftsByStatus) draftsByStatus[row.status as DraftStatus] = row.count;
    }
    const tasksByStatus = Object.fromEntries(ALL_TASK_STATUSES.map((s) => [s, 0])) as Record<PublishTaskStatus, number>;
    for (const row of queryAll<StatusCountRow>(db, 'SELECT status, COUNT(*) AS count FROM publish_tasks GROUP BY status')) {
      if (row.status in tasksByStatus) tasksByStatus[row.status as PublishTaskStatus] = row.count;
    }

    // 各主题帖子数 + 平均热度分：计数走 SQL，热度分复用阶段 2 评分公式（JS 计算，与帖子列表一致）。
    const topicCounts = queryAll<TopicCountRow>(db, 'SELECT topic, COUNT(*) AS count FROM posts GROUP BY topic');
    const posts = queryAll<PostScoreRow>(db, 'SELECT topic, likes, reposts, replies, publishedAt FROM posts');
    const scoresByTopic = new Map<string, number[]>();
    for (const p of posts) {
      const score = hotScore(engagementOf(p), ageHoursOf(p.publishedAt, now));
      const arr = scoresByTopic.get(p.topic) ?? [];
      arr.push(score);
      scoresByTopic.set(p.topic, arr);
    }
    const postsByTopic: TopicStat[] = topicCounts.map((row) => {
      const scores = scoresByTopic.get(row.topic) ?? [];
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      return { topic: row.topic, count: row.count, avgScore };
    });

    // 最近 10 条动态：drafts + publish_tasks 按 updatedAt 倒序列取。
    const recentRows = queryAll<ActivityRow>(
      db,
      `SELECT 'draft' AS type, id, title AS label, status, createdAt, updatedAt FROM drafts
       UNION ALL
       SELECT 'task' AS type, t.id, d.title AS label, t.status, t.createdAt, t.updatedAt
       FROM publish_tasks t LEFT JOIN drafts d ON d.id = t.draftId
       ORDER BY updatedAt DESC, id DESC LIMIT 10`,
    );
    const recentActivity: ActivityItem[] = recentRows.map((r) => ({
      type: r.type,
      id: r.id,
      label: r.label ?? '',
      status: r.status as ActivityItem['status'],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    // 发布漏斗：approved→queued（草稿侧）→publishing→succeeded（任务侧），失败/取消单独列。
    const publishingFunnel: PublishingFunnel = {
      approved: queryValue<number>(db, "SELECT COUNT(*) AS count FROM drafts WHERE status = 'approved'"),
      queued: queryValue<number>(db, "SELECT COUNT(*) AS count FROM drafts WHERE status = 'queued'"),
      publishing: queryValue<number>(db, "SELECT COUNT(*) AS count FROM publish_tasks WHERE status = 'publishing'"),
      succeeded: queryValue<number>(db, "SELECT COUNT(*) AS count FROM publish_tasks WHERE status = 'succeeded'"),
      failed: queryValue<number>(db, "SELECT COUNT(*) AS count FROM publish_tasks WHERE status = 'failed'"),
      cancelled: queryValue<number>(db, "SELECT COUNT(*) AS count FROM publish_tasks WHERE status = 'cancelled'"),
    };

    // 近 30 天按天聚合（含空天，供复盘页做 7/30 天筛选）。
    const dailyTrend: DailyTrendPoint[] = [];
    const draftDays = queryAll<{ day: string; count: number }>(
      db,
      `SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
       FROM drafts WHERE createdAt >= ? GROUP BY day`,
      now - 30 * 86_400_000,
    );
    const taskDays = queryAll<{ day: string; count: number }>(
      db,
      `SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS count
       FROM publish_tasks WHERE createdAt >= ? GROUP BY day`,
      now - 30 * 86_400_000,
    );
    const draftMap = new Map(draftDays.map((r) => [r.day, r.count]));
    const taskMap = new Map(taskDays.map((r) => [r.day, r.count]));
    for (let i = 29; i >= 0; i--) {
      const key = dayKey(now - i * 86_400_000);
      dailyTrend.push({ date: key, drafts: draftMap.get(key) ?? 0, tasks: taskMap.get(key) ?? 0 });
    }

    return {
      mode: RESPONSE_MODE,
      generatedAt: new Date(now).toISOString(),
      draftsByStatus,
      tasksByStatus,
      postsByTopic,
      recentActivity,
      publishingFunnel,
      dailyTrend,
    };
  });
}
