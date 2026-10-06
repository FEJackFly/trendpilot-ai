import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiError, Post, PostSort, PostWithScore, PostListResponse } from '@trendpilot/shared';
import type { Db, SqlParams } from '../db/db.js';
import { queryAll, queryOne } from '../db/db.js';
import { engagementOf, hotScore, ageHoursOf } from '../services/score.js';

/** mode 由服务端硬编码：本阶段只有演示数据，前端不得自行改标。 */
const RESPONSE_MODE = 'demo' as const;

const postsQuerySchema = z.object({
  keyword: z.string().trim().max(200).optional(),
  topic: z.string().trim().max(100).optional(),
  language: z.string().trim().max(10).optional(),
  sort: z.enum(['hot', 'new', 'likes']).default('hot'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** DB 行（snake 与接口一致，均为驼峰列名）。 */
interface PostRow {
  id: number;
  source: string;
  sourcePostId: string | null;
  authorHandle: string;
  text: string;
  url: string;
  topic: string;
  publishedAt: number;
  language: string;
  likes: number;
  reposts: number;
  replies: number;
  views: number | null;
  metricsCapturedAt: number;
  createdAt: number;
}

function toPostWithScore(row: PostRow, nowMs: number): PostWithScore {
  const engagement = engagementOf(row);
  const post: Post = {
    id: row.id,
    source: row.source as Post['source'],
    sourcePostId: row.sourcePostId,
    authorHandle: row.authorHandle,
    text: row.text,
    url: row.url,
    topic: row.topic,
    publishedAt: row.publishedAt,
    language: row.language,
    likes: row.likes,
    reposts: row.reposts,
    replies: row.replies,
    views: row.views,
    metricsCapturedAt: row.metricsCapturedAt,
    createdAt: row.createdAt,
  };
  return { ...post, engagement, score: hotScore(engagement, ageHoursOf(row.publishedAt, nowMs)) };
}

const SORTERS: Record<PostSort, (a: PostWithScore, b: PostWithScore) => number> = {
  hot: (a, b) => b.score - a.score,
  new: (a, b) => b.publishedAt - a.publishedAt,
  likes: (a, b) => b.likes - a.likes,
};

export function registerPostRoutes(app: FastifyInstance, db: Db): void {
  /**
   * GET /api/posts?keyword=&topic=&language=&sort=hot|new|likes&page=&pageSize=
   * 搜索/筛选/分页/排序。返回体含 mode，由服务端硬编码为 'demo'。
   */
  app.get('/posts', async (request, reply) => {
    const parsed = postsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_QUERY', message: '查询参数不合法', details: parsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const q = parsed.data;

    const where: string[] = [];
    const params: SqlParams[] = [];
    if (q.keyword) {
      where.push('(text LIKE ? ESCAPE \'\\\' OR authorHandle LIKE ? ESCAPE \'\\\')');
      const like = `%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (q.topic) {
      where.push('topic = ?');
      params.push(q.topic);
    }
    if (q.language) {
      where.push('language = ?');
      params.push(q.language);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = (queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM posts ${whereSql}`, ...params) as { c: number }).c;

    const rows = queryAll<PostRow>(db, `SELECT * FROM posts ${whereSql}`, ...params);
    const nowMs = Date.now();
    const scored = rows.map((r) => toPostWithScore(r, nowMs)).sort(SORTERS[q.sort]);

    const start = (q.page - 1) * q.pageSize;
    const items = scored.slice(start, start + q.pageSize);

    const body: PostListResponse = {
      items,
      total,
      page: q.page,
      pageSize: q.pageSize,
      mode: RESPONSE_MODE,
    };
    return reply.send(body);
  });

  /** GET /api/posts/:id 帖子详情（含热度分数）。不存在 → 404。 */
  app.get('/posts/:id', async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().min(1) }).safeParse(request.params);
    if (!params.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '帖子 ID 不合法' };
      return reply.status(400).send(body);
    }
    const row = queryOne<PostRow>(db, 'SELECT * FROM posts WHERE id = ?', params.data.id);
    if (!row) {
      const body: ApiError = { code: 'POST_NOT_FOUND', message: `帖子不存在：${params.data.id}` };
      return reply.status(404).send(body);
    }
    return reply.send(toPostWithScore(row, Date.now()));
  });
}
