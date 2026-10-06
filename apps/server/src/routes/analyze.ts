import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Analysis, ApiError } from '@trendpilot/shared';
import type { Db } from '../db/db.js';
import { queryOne } from '../db/db.js';
import { createAIProvider, type AnalyzeInput } from '../providers/ai.js';
import { replyAIError } from '../providers/errors.js';

/** DB analyses 行。 */
interface AnalysisRow {
  id: number;
  postId: number;
  topic: string;
  coreClaims: string;
  structure: string;
  audienceNeeds: string;
  contentAngles: string;
  factCheckItems: string;
  createdAt: number;
  provider: string;
}

/** DB posts 行（分析只需要这几个字段）。 */
interface PostRow {
  id: number;
  text: string;
  topic: string;
  authorHandle: string;
  language: string;
  url: string;
}

function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    postId: row.postId,
    topic: row.topic,
    coreClaims: JSON.parse(row.coreClaims) as string[],
    structure: row.structure,
    audienceNeeds: row.audienceNeeds,
    contentAngles: JSON.parse(row.contentAngles) as string[],
    factCheckItems: JSON.parse(row.factCheckItems) as string[],
    createdAt: row.createdAt,
    provider: row.provider as Analysis['provider'],
  };
}

const idParams = z.object({ id: z.coerce.number().int().min(1) });

export function registerAnalyzeRoutes(app: FastifyInstance, db: Db): void {
  /**
   * POST /api/posts/:id/analyze — 分析参考内容。
   * 读取帖子 → AI 提供商（createAIProvider 按环境变量选择 mock/真实）分析 → 存 analyses 表 → 返回分析结果。
   * 同一帖子可重复分析，每次生成一条新记录。帖子不存在 → 404。
   */
  app.post('/posts/:id/analyze', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '帖子 ID 不合法' };
      return reply.status(400).send(body);
    }
    const postId = parsed.data.id;

    const post = queryOne<PostRow>(
      db,
      'SELECT id, text, topic, authorHandle, language, url FROM posts WHERE id = ?',
      postId,
    );
    if (!post) {
      const body: ApiError = { code: 'POST_NOT_FOUND', message: `帖子不存在：${postId}` };
      return reply.status(404).send(body);
    }

    const input: AnalyzeInput = {
      id: post.id,
      text: post.text,
      topic: post.topic,
      authorHandle: post.authorHandle,
      language: post.language,
      url: post.url,
    };
    // createAIProvider 按 AI_PROVIDER 环境变量选择实现；真实 provider 缺 key 时 fail fast。
    let result;
    try {
      result = await createAIProvider().analyze(input);
    } catch (err) {
      replyAIError(reply, err);
      return;
    }

    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO analyses (postId, topic, coreClaims, structure, audienceNeeds, contentAngles, factCheckItems, createdAt, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = insert.run(
      postId,
      result.topic,
      JSON.stringify(result.coreClaims),
      result.structure,
      result.audienceNeeds,
      JSON.stringify(result.contentAngles),
      JSON.stringify(result.factCheckItems),
      now,
      result.provider,
    );

    const row = queryOne<AnalysisRow>(db, 'SELECT * FROM analyses WHERE id = ?', Number(info.lastInsertRowid));
    if (!row) {
      const body: ApiError = { code: 'ANALYSIS_SAVE_FAILED', message: '分析结果保存失败' };
      return reply.status(500).send(body);
    }
    const body: Analysis = toAnalysis(row);
    return reply.status(201).send(body);
  });

  /**
   * GET /api/posts/:id/analyses — 该帖子的历史分析记录（按时间倒序）。
   */
  app.get('/posts/:id/analyses', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '帖子 ID 不合法' };
      return reply.status(400).send(body);
    }
    const post = queryOne<{ id: number }>(db, 'SELECT id FROM posts WHERE id = ?', parsed.data.id);
    if (!post) {
      const body: ApiError = { code: 'POST_NOT_FOUND', message: `帖子不存在：${parsed.data.id}` };
      return reply.status(404).send(body);
    }
    const rows = db
      .prepare('SELECT * FROM analyses WHERE postId = ? ORDER BY createdAt DESC')
      .all(parsed.data.id) as unknown as AnalysisRow[];
    return reply.send({ items: rows.map(toAnalysis), total: rows.length });
  });
}
