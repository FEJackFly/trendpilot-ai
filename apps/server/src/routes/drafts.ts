import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ApiError,
  Draft,
  DraftFormat,
  DraftListResponse,
  DraftStatus,
  DraftVersion,
  DraftVersionListResponse,
  GenerateMode,
} from '@trendpilot/shared';
import type { Db, SqlParams } from '../db/db.js';
import { queryAll, queryOne } from '../db/db.js';
import { createAIProvider, normalizeFormat, type GenerateInput } from '../providers/ai.js';
import { replyAIError } from '../providers/errors.js';

/** DB drafts 行。 */
interface DraftRow {
  id: number;
  title: string;
  content: string;
  language: string;
  format: string;
  status: string;
  sourcePostIds: string;
  sourceUrls: string;
  provider: string;
  model: string;
  needsFactCheck: number;
  createdAt: number;
  updatedAt: number;
}

/** DB draft_versions 行。 */
interface DraftVersionRow {
  id: number;
  draftId: number;
  content: string;
  createdAt: number;
  changeNote: string;
}

function toDraft(row: DraftRow, versionCount?: number): Draft {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    language: row.language,
    format: row.format as DraftFormat,
    status: row.status as DraftStatus,
    sourcePostIds: JSON.parse(row.sourcePostIds) as number[],
    sourceUrls: JSON.parse(row.sourceUrls) as string[],
    provider: row.provider as Draft['provider'],
    model: row.model,
    needsFactCheck: row.needsFactCheck === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(versionCount !== undefined ? { versionCount } : {}),
  };
}

function toDraftVersion(row: DraftVersionRow): DraftVersion {
  return {
    id: row.id,
    draftId: row.draftId,
    content: row.content,
    createdAt: row.createdAt,
    changeNote: row.changeNote,
  };
}

const idParams = z.object({ id: z.coerce.number().int().min(1) });

const createDraftSchema = z.object({
  title: z.string().trim().max(200).default(''),
  content: z.string().max(100000).default(''),
  language: z.string().trim().max(10).default('zh'),
  format: z.enum(['post', 'thread', 'article', 'tutorial']).default('post'),
  sourcePostIds: z.array(z.number().int().min(1)).max(50).default([]),
});

const updateDraftSchema = z.object({
  title: z.string().trim().max(200).optional(),
  content: z.string().max(100000).optional(),
  changeNote: z.string().trim().max(500).optional(),
  /** 仅允许 draft→review（提交审核）/ review→draft（退回修改）。 */
  status: z.enum(['draft', 'review']).optional(),
});

const generateSchema = z.object({
  sourcePostIds: z.array(z.number().int().min(1)).max(50).default([]),
  mode: z.enum(['tutorial', 'opinion', 'case-study', 'comparison', 'longform', 'thread']),
  goal: z.string().trim().max(500).optional(),
  language: z.string().trim().max(10).default('zh'),
  audience: z.string().trim().max(200).optional(),
  instructions: z.string().trim().max(2000).optional(),
  format: z.enum(['post', 'thread', 'article', 'tutorial']).default('post'),
});

const draftsQuerySchema = z.object({
  status: z.enum(['draft', 'review', 'approved', 'queued', 'published', 'archived']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 状态机：PATCH 允许的状态流转。
 * - draft → review（提交审核）
 * - review → draft（退回修改）
 * 审核通过走 POST /:id/approve（draft/review → approved）。
 */
const PATCH_TRANSITIONS: Record<string, string[]> = {
  draft: ['review'],
  review: ['draft'],
};

function invalidTransition(from: string, to: string): ApiError {
  return { code: 'INVALID_STATUS_TRANSITION', message: `不允许的状态流转：${from} → ${to}` };
}

function insertVersion(db: Db, draftId: number, content: string, changeNote: string): void {
  db.prepare('INSERT INTO draft_versions (draftId, content, createdAt, changeNote) VALUES (?, ?, ?, ?)').run(
    draftId,
    content,
    Date.now(),
    changeNote,
  );
}

function versionCountOf(db: Db, draftId: number): number {
  return (queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM draft_versions WHERE draftId = ?', draftId) as { c: number }).c;
}

export function registerDraftRoutes(app: FastifyInstance, db: Db): void {
  /** POST /api/drafts — 创建草稿（status 默认为 draft），同时写入初始版本。 */
  app.post('/drafts', async (request, reply) => {
    const parsed = createDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_BODY', message: '请求体不合法', details: parsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const b = parsed.data;
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO drafts (title, content, language, format, status, sourcePostIds, sourceUrls, provider, model, needsFactCheck, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 'draft', ?, '[]', 'mock', '', 0, ?, ?)`,
      )
      .run(b.title, b.content, b.language, b.format, JSON.stringify(b.sourcePostIds), now, now);
    const draftId = Number(info.lastInsertRowid);
    insertVersion(db, draftId, b.content, '创建草稿');

    const row = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_SAVE_FAILED', message: '草稿保存失败' };
      return reply.status(500).send(body);
    }
    return reply.status(201).send(toDraft(row, 1));
  });

  /** GET /api/drafts — 草稿列表（status 筛选、分页，按更新时间倒序）。 */
  app.get('/drafts', async (request, reply) => {
    const parsed = draftsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_QUERY', message: '查询参数不合法', details: parsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const q = parsed.data;
    const where: string[] = [];
    const params: SqlParams[] = [];
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM drafts ${whereSql}`, ...params) as { c: number }).c;
    const rows = queryAll<DraftRow>(
      db,
      `SELECT * FROM drafts ${whereSql} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`,
      ...params,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    );
    const body: DraftListResponse = {
      items: rows.map((r) => toDraft(r)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
    return reply.send(body);
  });

  /** GET /api/drafts/:id — 草稿详情（含版本数）。 */
  app.get('/drafts/:id', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '草稿 ID 不合法' };
      return reply.status(400).send(body);
    }
    const row = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', parsed.data.id);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${parsed.data.id}` };
      return reply.status(404).send(body);
    }
    return reply.send(toDraft(row, versionCountOf(db, row.id)));
  });

  /**
   * PATCH /api/drafts/:id — 修改标题/正文；content 变化时写一条版本记录。
   * status 只允许 draft↔review 流转。
   */
  app.patch('/drafts/:id', async (request, reply) => {
    const idParsed = idParams.safeParse(request.params);
    if (!idParsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '草稿 ID 不合法' };
      return reply.status(400).send(body);
    }
    const bodyParsed = updateDraftSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      const body: ApiError = { code: 'INVALID_BODY', message: '请求体不合法', details: bodyParsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const draftId = idParsed.data.id;
    const row = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${draftId}` };
      return reply.status(404).send(body);
    }
    const b = bodyParsed.data;

    // 状态流转校验
    if (b.status && b.status !== row.status) {
      const allowed = PATCH_TRANSITIONS[row.status] ?? [];
      if (!allowed.includes(b.status)) {
        return reply.status(400).send(invalidTransition(row.status, b.status));
      }
    }

    const newTitle = b.title !== undefined ? b.title : row.title;
    const newContent = b.content !== undefined ? b.content : row.content;
    const newStatus = b.status ?? row.status;
    const contentChanged = newContent !== row.content;

    db.prepare('UPDATE drafts SET title = ?, content = ?, status = ?, updatedAt = ? WHERE id = ?').run(
      newTitle,
      newContent,
      newStatus,
      Date.now(),
      draftId,
    );
    if (contentChanged) {
      insertVersion(db, draftId, newContent, b.changeNote || '内容更新');
    }

    const updated = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!updated) {
      const body: ApiError = { code: 'DRAFT_SAVE_FAILED', message: '草稿保存失败' };
      return reply.status(500).send(body);
    }
    return reply.send(toDraft(updated, versionCountOf(db, draftId)));
  });

  /**
   * POST /api/drafts/:id/generate — AI 生成草稿内容（createAIProvider 按环境变量选择 mock/真实）。
   * 生成结果写入草稿 content 并记一条版本（changeNote=AI 生成（provider 名））。
   */
  app.post('/drafts/:id/generate', async (request, reply) => {
    const idParsed = idParams.safeParse(request.params);
    if (!idParsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '草稿 ID 不合法' };
      return reply.status(400).send(body);
    }
    const bodyParsed = generateSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      const body: ApiError = { code: 'INVALID_BODY', message: '请求体不合法', details: bodyParsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const draftId = idParsed.data.id;
    const row = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${draftId}` };
      return reply.status(404).send(body);
    }
    const g = bodyParsed.data;

    // 解析参考帖子（不存在的 ID 直接忽略）
    const sourcePosts =
      g.sourcePostIds.length > 0
        ? queryAll<{ id: number; text: string; authorHandle: string; url: string; topic: string }>(
            db,
            `SELECT id, text, authorHandle, url, topic FROM posts WHERE id IN (${g.sourcePostIds.map(() => '?').join(',')})`,
            ...g.sourcePostIds,
          )
        : [];

    const genInput: GenerateInput = {
      sourcePostIds: g.sourcePostIds,
      mode: g.mode as GenerateMode,
      goal: g.goal,
      language: g.language,
      audience: g.audience,
      instructions: g.instructions,
      format: g.format,
      sourcePosts,
    };
    // createAIProvider 按 AI_PROVIDER 环境变量选择实现；真实 provider 缺 key 时 fail fast。
    let result;
    try {
      result = await createAIProvider().generateDraft(genInput);
    } catch (err) {
      replyAIError(reply, err);
      return;
    }

    const now = Date.now();
    db.prepare(
      'UPDATE drafts SET title = ?, content = ?, format = ?, sourcePostIds = ?, sourceUrls = ?, provider = ?, model = ?, needsFactCheck = ?, updatedAt = ? WHERE id = ?',
    ).run(
      result.title,
      result.content,
      normalizeFormat(g.format),
      JSON.stringify(g.sourcePostIds),
      JSON.stringify(result.sourceUrls),
      result.provider,
      result.model,
      result.needsFactCheck ? 1 : 0,
      now,
      draftId,
    );
    insertVersion(db, draftId, result.content, `AI 生成（${result.provider}）`);

    const updated = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!updated) {
      const body: ApiError = { code: 'DRAFT_SAVE_FAILED', message: '草稿保存失败' };
      return reply.status(500).send(body);
    }
    // 生成结果的要点/警告随草稿一起返回，方便前端展示。
    return reply.send({ ...toDraft(updated, versionCountOf(db, draftId)), keyPoints: result.keyPoints, warnings: result.warnings });
  });

  /**
   * POST /api/drafts/:id/approve — 审核通过。
   * 仅 draft/review → approved，其余一律 400 INVALID_STATUS_TRANSITION。
   */
  app.post('/drafts/:id/approve', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '草稿 ID 不合法' };
      return reply.status(400).send(body);
    }
    const draftId = parsed.data.id;
    const row = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${draftId}` };
      return reply.status(404).send(body);
    }
    if (row.status !== 'draft' && row.status !== 'review') {
      return reply.status(400).send(invalidTransition(row.status, 'approved'));
    }
    db.prepare('UPDATE drafts SET status = ?, updatedAt = ? WHERE id = ?').run('approved', Date.now(), draftId);
    const updated = queryOne<DraftRow>(db, 'SELECT * FROM drafts WHERE id = ?', draftId);
    if (!updated) {
      const body: ApiError = { code: 'DRAFT_SAVE_FAILED', message: '草稿保存失败' };
      return reply.status(500).send(body);
    }
    return reply.send(toDraft(updated, versionCountOf(db, draftId)));
  });

  /** GET /api/drafts/:id/versions — 版本历史（按时间倒序）。 */
  app.get('/drafts/:id/versions', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '草稿 ID 不合法' };
      return reply.status(400).send(body);
    }
    const row = queryOne<{ id: number }>(db, 'SELECT id FROM drafts WHERE id = ?', parsed.data.id);
    if (!row) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${parsed.data.id}` };
      return reply.status(404).send(body);
    }
    const rows = queryAll<DraftVersionRow>(
      db,
      'SELECT * FROM draft_versions WHERE draftId = ? ORDER BY createdAt DESC, id DESC',
      parsed.data.id,
    );
    const body: DraftVersionListResponse = { items: rows.map(toDraftVersion), total: rows.length };
    return reply.send(body);
  });
}
