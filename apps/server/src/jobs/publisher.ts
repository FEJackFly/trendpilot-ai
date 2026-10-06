import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/db.js';
import { queryAll, queryOne } from '../db/db.js';
import { env } from '../config/env.js';
import { xApiDisabledError, xApiNotImplementedError, type XApiError } from '../providers/x.js';

/**
 * 发布执行器（文档第 11 节）。
 * - mode='mock'：模拟发布（本地演练，绝不声称发布到了 X）。
 * - mode='x_api'：真实发布执行器本阶段默认不启用；若 DB 中出现此类任务，
 *   明确标记失败（X_API_DISABLED / X_API_NOT_IMPLEMENTED），绝不静默丢弃，
 *   更不会在未配置的情况下向 X 发送任何请求。
 */

const MOCK_FAILURES = [
  { code: 'MOCK_RATE_LIMIT', message: '模拟发布失败：触发模拟限流（演示用错误，非真实 X API 返回）' },
  { code: 'MOCK_NETWORK', message: '模拟发布失败：模拟网络超时（演示用错误，非真实 X API 返回）' },
] as const;

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
}

/**
 * 原子抢任务：只有处于 pending/scheduled 且已到期的任务才能被置为 publishing。
 * 返回 true 表示抢到（本轮由调用者执行），false 表示已被抢走或状态不符——
 * 同一任务不会被并发执行两次。
 */
export function claimTask(db: Db, taskId: number, now: number = Date.now()): boolean {
  const info = db
    .prepare(
      `UPDATE publish_tasks
       SET status = 'publishing', updatedAt = ?
       WHERE id = ? AND status IN ('pending', 'scheduled')
         AND (scheduledAt IS NULL OR scheduledAt <= ?)`,
    )
    .run(now, taskId, now);
  return Number(info.changes) > 0;
}

/** 到期且可执行的任务 ID（scheduledAt 为空=立即，到期=已到时间）。 */
export function dueTaskIds(db: Db, now: number = Date.now()): number[] {
  const rows = queryAll<{ id: number }>(
    db,
    `SELECT id FROM publish_tasks
     WHERE status IN ('pending', 'scheduled')
       AND (scheduledAt IS NULL OR scheduledAt <= ?)
     ORDER BY COALESCE(scheduledAt, 0) ASC, createdAt ASC`,
    now,
  );
  return rows.map((r) => r.id);
}

function setDraftStatus(db: Db, draftId: number, status: 'approved' | 'published'): void {
  // 只从 queued 流转，避免覆盖用户后续的手动状态变更。
  db.prepare("UPDATE drafts SET status = ?, updatedAt = ? WHERE id = ? AND status = 'queued'").run(
    status,
    Date.now(),
    draftId,
  );
}

/**
 * 执行单个任务（先原子抢占，抢不到则跳过）。
 * x_api 任务：真实执行器未启用，直接标记失败（不静默丢弃、不发起外部调用）。
 * @param random 随机函数（默认 Math.random；测试可注入以决定成败）。
 * @returns true=本次执行了该任务，false=未抢到（跳过）。
 */
export function executeTask(db: Db, taskId: number, random: () => number = Math.random): boolean {
  const now = Date.now();
  if (!claimTask(db, taskId, now)) {
    return false;
  }
  const row = queryOne<TaskRow>(db, 'SELECT * FROM publish_tasks WHERE id = ?', taskId);
  if (!row) {
    return true; // 抢占后任务被删：极端情况，视为已处理
  }

  // 真实发布门控：本阶段没有真实执行器，x_api 任务必须明确失败。
  if (row.mode !== 'mock') {
    const err: XApiError = env.X_API_ENABLED ? xApiNotImplementedError('发布') : xApiDisabledError();
    db.prepare(
      `UPDATE publish_tasks
       SET status = 'failed', attempts = attempts + 1,
           errorCode = ?, errorMessage = ?, updatedAt = ?
       WHERE id = ?`,
    ).run(err.code, err.message, Date.now(), taskId);
    setDraftStatus(db, row.draftId, 'approved');
    return true;
  }

  const failed = random() < 0.2;
  if (failed) {
    const err = MOCK_FAILURES[Math.floor(random() * MOCK_FAILURES.length)] ?? MOCK_FAILURES[0];
    db.prepare(
      `UPDATE publish_tasks
       SET status = 'failed', attempts = attempts + 1,
           errorCode = ?, errorMessage = ?, updatedAt = ?
       WHERE id = ?`,
    ).run(err.code, err.message, Date.now(), taskId);
    setDraftStatus(db, row.draftId, 'approved');
  } else {
    db.prepare(
      `UPDATE publish_tasks
       SET status = 'succeeded', externalPostId = ?, errorCode = NULL, errorMessage = NULL, updatedAt = ?
       WHERE id = ?`,
    ).run(`mock_${taskId}`, Date.now(), taskId);
    setDraftStatus(db, row.draftId, 'published');
  }
  return true;
}

/** 跑一轮：扫描到期任务并逐个执行。返回实际执行的任务数。 */
export function runPublisherCycle(db: Db, random: () => number = Math.random): number {
  let executed = 0;
  for (const id of dueTaskIds(db)) {
    if (executeTask(db, id, random)) {
      executed += 1;
    }
  }
  return executed;
}

/**
 * 启动定时发布器（默认每 5 秒一轮）。
 * 返回停止函数；定时器已 unref，不会阻止进程退出。
 */
export function startPublisher(app: FastifyInstance, db: Db, intervalMs = 5000): () => void {
  app.log.info(`模拟发布器已启动（每 ${intervalMs}ms 扫描一轮；仅模拟执行，非真实发布）`);
  const timer = setInterval(() => {
    try {
      const n = runPublisherCycle(db);
      if (n > 0) {
        app.log.info(`模拟发布器本轮执行了 ${n} 个任务（本地演练，非真实发布到 X）`);
      }
    } catch (err) {
      app.log.error(err, '模拟发布器本轮执行出错');
    }
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    app.log.info('模拟发布器已停止');
  };
}
