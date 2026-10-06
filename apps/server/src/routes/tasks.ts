import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ApiError,
  PublishMode,
  PublishTask,
  PublishTaskStatus,
  TaskListResponse,
} from '@trendpilot/shared';
import type { Db, SqlParams } from '../db/db.js';
import { queryAll, queryOne } from '../db/db.js';
import { env } from '../config/env.js';

/**
 * 发布任务路由（文档第 7、11 节）。
 * 本阶段 mode 恒为 'mock'（模拟发布）；只有 approved 草稿可入队。
 */

/** 重试次数上限（含执行失败与手动重试累计）。 */
export const MAX_ATTEMPTS = 3;
/** 重试退避基数（秒）：第 n 次重试延迟 n*30 秒。 */
export const RETRY_BACKOFF_SECONDS = 30;

/**
 * 任务状态机（纯函数，便于单测）。
 * - pending → publishing（执行器抢占）/ scheduled（改排期）/ cancelled
 * - scheduled → pending（到期或改排期）/ cancelled
 * - publishing → succeeded / failed / cancelled
 * - failed → pending（仅经重试接口）
 * - succeeded / cancelled 为终态
 */
const TASK_TRANSITIONS: Record<PublishTaskStatus, PublishTaskStatus[]> = {
  pending: ['scheduled', 'publishing', 'cancelled'],
  scheduled: ['pending', 'cancelled'],
  publishing: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['pending'],
  cancelled: [],
};

export function canTransition(from: PublishTaskStatus, to: PublishTaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

interface TaskRow {
  id: number;
  draftId: number;
  mode: string;
  status: string;
  scheduledAt: number | null;
  attempts: number;
  externalPostId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  draftTitle: string | null;
}

function toTask(row: TaskRow): PublishTask {
  return {
    id: row.id,
    draftId: row.draftId,
    ...(row.draftTitle != null ? { draftTitle: row.draftTitle } : {}),
    mode: row.mode as PublishMode,
    status: row.status as PublishTaskStatus,
    scheduledAt: row.scheduledAt,
    attempts: row.attempts,
    externalPostId: row.externalPostId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function getTask(db: Db, id: number): TaskRow | undefined {
  return queryOne<TaskRow>(
    db,
    `SELECT t.*, d.title AS draftTitle FROM publish_tasks t
     LEFT JOIN drafts d ON d.id = t.draftId WHERE t.id = ?`,
    id,
  );
}

function invalidTransition(from: string, to: string): ApiError {
  return { code: 'INVALID_STATUS_TRANSITION', message: `不允许的状态流转：${from} → ${to}` };
}

const idParams = z.object({ id: z.coerce.number().int().min(1) });

const createTaskSchema = z.object({
  draftId: z.number().int().min(1),
  /** 计划发布时间（Unix 毫秒）；缺省=立即执行。 */
  scheduledAt: z.number().int().positive().optional(),
});

const tasksQuerySchema = z.object({
  status: z.enum(['pending', 'scheduled', 'publishing', 'succeeded', 'failed', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const updateTaskSchema = z.object({
  /** null=立即执行；时间戳=排期。 */
  scheduledAt: z.number().int().positive().nullable(),
});

export function registerTaskRoutes(app: FastifyInstance, db: Db): void {
  const listMode = env.DATA_MODE === 'mock' ? 'demo' : 'live';

  /**
   * POST /api/tasks — 创建发布任务（入队）。
   * 仅 status=approved 的草稿可入队；mode 本阶段硬编码为 'mock'。
   * scheduledAt 缺省 → pending（立即）；有值 → scheduled。
   */
  app.post('/tasks', async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_BODY', message: '请求体不合法', details: parsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const { draftId, scheduledAt } = parsed.data;
    const draft = queryOne<{ id: number; status: string; title: string }>(
      db,
      'SELECT id, status, title FROM drafts WHERE id = ?',
      draftId,
    );
    if (!draft) {
      const body: ApiError = { code: 'DRAFT_NOT_FOUND', message: `草稿不存在：${draftId}` };
      return reply.status(404).send(body);
    }
    if (draft.status !== 'approved') {
      const body: ApiError = {
        code: 'DRAFT_NOT_APPROVED',
        message: `只有已审核通过的草稿才能加入发布队列（当前状态：${draft.status}）`,
      };
      return reply.status(400).send(body);
    }

    const now = Date.now();
    const status: PublishTaskStatus = scheduledAt != null ? 'scheduled' : 'pending';
    const info = db
      .prepare(
        `INSERT INTO publish_tasks (draftId, mode, status, scheduledAt, attempts, createdAt, updatedAt)
         VALUES (?, 'mock', ?, ?, 0, ?, ?)`,
      )
      .run(draftId, status, scheduledAt ?? null, now, now);
    const taskId = Number(info.lastInsertRowid);
    db.prepare("UPDATE drafts SET status = 'queued', updatedAt = ? WHERE id = ? AND status = 'approved'").run(now, draftId);

    const row = getTask(db, taskId);
    if (!row) {
      const body: ApiError = { code: 'TASK_SAVE_FAILED', message: '发布任务保存失败' };
      return reply.status(500).send(body);
    }
    return reply.status(201).send(toTask(row));
  });

  /** GET /api/tasks — 任务列表（status 筛选、分页，按创建时间倒序）。 */
  app.get('/tasks', async (request, reply) => {
    const parsed = tasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_QUERY', message: '查询参数不合法', details: parsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const q = parsed.data;
    const where: string[] = [];
    const params: SqlParams[] = [];
    if (q.status) {
      where.push('t.status = ?');
      params.push(q.status);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM publish_tasks t ${whereSql}`, ...params) as {
      c: number;
    };
    const rows = queryAll<TaskRow>(
      db,
      `SELECT t.*, d.title AS draftTitle FROM publish_tasks t
       LEFT JOIN drafts d ON d.id = t.draftId
       ${whereSql} ORDER BY t.createdAt DESC, t.id DESC LIMIT ? OFFSET ?`,
      ...params,
      q.pageSize,
      (q.page - 1) * q.pageSize,
    );
    const body: TaskListResponse = {
      items: rows.map(toTask),
      total: total.c,
      page: q.page,
      pageSize: q.pageSize,
      mode: listMode,
    };
    return reply.send(body);
  });

  /** GET /api/tasks/:id — 任务详情。 */
  app.get('/tasks/:id', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '任务 ID 不合法' };
      return reply.status(400).send(body);
    }
    const row = getTask(db, parsed.data.id);
    if (!row) {
      const body: ApiError = { code: 'TASK_NOT_FOUND', message: `发布任务不存在：${parsed.data.id}` };
      return reply.status(404).send(body);
    }
    return reply.send(toTask(row));
  });

  /**
   * PATCH /api/tasks/:id — 改排期。
   * 仅 pending/scheduled 可改；scheduledAt=null → pending（立即），有值 → scheduled。
   */
  app.patch('/tasks/:id', async (request, reply) => {
    const idParsed = idParams.safeParse(request.params);
    if (!idParsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '任务 ID 不合法' };
      return reply.status(400).send(body);
    }
    const bodyParsed = updateTaskSchema.safeParse(request.body);
    if (!bodyParsed.success) {
      const body: ApiError = { code: 'INVALID_BODY', message: '请求体不合法', details: bodyParsed.error.flatten() };
      return reply.status(400).send(body);
    }
    const taskId = idParsed.data.id;
    const row = getTask(db, taskId);
    if (!row) {
      const body: ApiError = { code: 'TASK_NOT_FOUND', message: `发布任务不存在：${taskId}` };
      return reply.status(404).send(body);
    }
    const from = row.status as PublishTaskStatus;
    if (from !== 'pending' && from !== 'scheduled') {
      const body: ApiError = {
        code: 'INVALID_STATUS_TRANSITION',
        message: `当前状态 ${from} 不允许改排期（仅 pending/scheduled 可改）`,
      };
      return reply.status(400).send(body);
    }
    const newStatus: PublishTaskStatus = bodyParsed.data.scheduledAt == null ? 'pending' : 'scheduled';
    if (newStatus !== from && !canTransition(from, newStatus)) {
      return reply.status(400).send(invalidTransition(from, newStatus));
    }
    db.prepare('UPDATE publish_tasks SET status = ?, scheduledAt = ?, updatedAt = ? WHERE id = ?').run(
      newStatus,
      bodyParsed.data.scheduledAt,
      Date.now(),
      taskId,
    );
    const updated = getTask(db, taskId);
    if (!updated) {
      const body: ApiError = { code: 'TASK_SAVE_FAILED', message: '发布任务保存失败' };
      return reply.status(500).send(body);
    }
    return reply.send(toTask(updated));
  });

  /**
   * POST /api/tasks/:id/cancel — 取消任务。
   * 仅 pending/scheduled/publishing 可取消 → cancelled；草稿回退 approved。
   */
  app.post('/tasks/:id/cancel', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '任务 ID 不合法' };
      return reply.status(400).send(body);
    }
    const taskId = parsed.data.id;
    const row = getTask(db, taskId);
    if (!row) {
      const body: ApiError = { code: 'TASK_NOT_FOUND', message: `发布任务不存在：${taskId}` };
      return reply.status(404).send(body);
    }
    const from = row.status as PublishTaskStatus;
    if (!canTransition(from, 'cancelled')) {
      return reply.status(400).send(invalidTransition(from, 'cancelled'));
    }
    const now = Date.now();
    db.prepare("UPDATE publish_tasks SET status = 'cancelled', updatedAt = ? WHERE id = ?").run(now, taskId);
    db.prepare("UPDATE drafts SET status = 'approved', updatedAt = ? WHERE id = ? AND status = 'queued'").run(
      now,
      row.draftId,
    );
    const updated = getTask(db, taskId);
    if (!updated) {
      const body: ApiError = { code: 'TASK_SAVE_FAILED', message: '发布任务保存失败' };
      return reply.status(500).send(body);
    }
    return reply.send(toTask(updated));
  });

  /**
   * POST /api/tasks/:id/retry — 重试失败任务。
   * 仅 failed 可重试 → pending（attempts+1）；attempts 达上限 → 400 RETRY_LIMIT_EXCEEDED。
   * 退避：scheduledAt = now + attempts*30 秒，由定时器自然触发。
   */
  app.post('/tasks/:id/retry', async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) {
      const body: ApiError = { code: 'INVALID_ID', message: '任务 ID 不合法' };
      return reply.status(400).send(body);
    }
    const taskId = parsed.data.id;
    const row = getTask(db, taskId);
    if (!row) {
      const body: ApiError = { code: 'TASK_NOT_FOUND', message: `发布任务不存在：${taskId}` };
      return reply.status(404).send(body);
    }
    const from = row.status as PublishTaskStatus;
    if (from !== 'failed') {
      return reply.status(400).send(invalidTransition(from, 'pending'));
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      const body: ApiError = {
        code: 'RETRY_LIMIT_EXCEEDED',
        message: `重试次数已达上限（${MAX_ATTEMPTS} 次），请检查后手动处理`,
      };
      return reply.status(400).send(body);
    }
    const now = Date.now();
    const attempts = row.attempts + 1;
    const scheduledAt = now + attempts * RETRY_BACKOFF_SECONDS * 1000;
    db.prepare(
      `UPDATE publish_tasks
       SET status = 'pending', attempts = ?, scheduledAt = ?,
           errorCode = NULL, errorMessage = NULL, updatedAt = ?
       WHERE id = ?`,
    ).run(attempts, scheduledAt, now, taskId);
    const updated = getTask(db, taskId);
    if (!updated) {
      const body: ApiError = { code: 'TASK_SAVE_FAILED', message: '发布任务保存失败' };
      return reply.status(500).send(body);
    }
    return reply.send(toTask(updated));
  });
}
