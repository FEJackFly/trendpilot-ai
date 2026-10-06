import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiError } from '@trendpilot/shared';
import { registerHealthRoutes } from './routes/health.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerPostRoutes } from './routes/posts.js';
import { registerAnalyzeRoutes } from './routes/analyze.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { openDatabase, migrate, type Db } from './db/db.js';
import { seedIfEmpty } from './db/seed.js';
import { startPublisher } from './jobs/publisher.js';
import { loggerOptions } from './utils/redact.js';
import { env } from './config/env.js';

export const SERVICE_NAME = 'trendpilot-server';
export const SERVICE_VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    /** 内部数据库句柄（测试与运维用，业务代码请走路由层）。 */
    db: Db;
  }
}

export interface BuildAppOptions {
  /** 数据库路径；测试时可传 ':memory:'。默认读环境变量 DATABASE_URL。 */
  databasePath?: string;
  /** 是否执行种子数据写入；测试时可关闭。默认 true。 */
  seed?: boolean;
  /**
   * 是否启动模拟发布器（定时扫描并模拟执行任务）。
   * true=默认 5 秒一轮；数字=自定义间隔毫秒；缺省/ false=不启动。
   * 测试默认不启动，避免定时器干扰断言的确定性。
   */
  publisher?: boolean | number;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  // 日志脱敏：api_key/authorization/client_secret 等字段自动打码为 ***（见 utils/redact）。
  const app = Fastify({ logger: loggerOptions() });

  // 本地开发：允许任意本地端口的前端访问。
  app.register(cors, { origin: [/^http:\/\/localhost:\d+$/] });

  // 数据库：打开 → 建表 → 种子数据（幂等）。
  // 相对路径一律按仓库根目录解析（dev/prod 的 cwd 可能不同，固定位置避免多份 DB）。
  const serverDir = dirname(fileURLToPath(import.meta.url)); // src/ 或 dist/
  const repoRoot = resolve(serverDir, '..', '..', '..');
  const configured = options.databasePath ?? env.DATABASE_URL;
  const dbPath = configured === ':memory:' || isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  const db: Db = openDatabase(dbPath);
  migrate(db);
  app.decorate('db', db);
  if (options.seed !== false) {
    const inserted = seedIfEmpty(db);
    if (inserted > 0) app.log.info(`seeded ${inserted} mock posts`);
  }
  app.addHook('onClose', async () => {
    db.close();
  });

  app.register(registerHealthRoutes, { prefix: '/api' });
  app.register(registerConfigRoutes, { prefix: '/api' });
  // posts/analyze/drafts 路由需要 db 实例：包一层插件以便挂 /api 前缀。
  app.register(
    async (instance) => {
      registerPostRoutes(instance, db);
      registerAnalyzeRoutes(instance, db);
      registerDraftRoutes(instance, db);
      registerTaskRoutes(instance, db);
      registerAnalyticsRoutes(instance, db);
    },
    { prefix: '/api' },
  );

  // 模拟发布器：定时扫描到期任务并模拟执行（仅模拟，非真实发布）。
  if (options.publisher) {
    const intervalMs = typeof options.publisher === 'number' ? options.publisher : 5000;
    const stopPublisher = startPublisher(app, db, intervalMs);
    app.addHook('onClose', async () => {
      stopPublisher();
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const body: ApiError = { code: 'INTERNAL_ERROR', message: 'Internal server error' };
    reply.status(500).send(body);
  });

  return app;
}
