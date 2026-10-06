import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 数据访问层（基于 Node 24 内置 node:sqlite，免原生编译、跨平台）。
 * 职责：打开数据库、建表（migrate）、提供最小 query helper。
 * 注意：SQL 参数一律用占位符绑定，禁止字符串拼接用户输入。
 *
 * 用 createRequire 加载 node:sqlite：vitest 的 vite-node 对 `node:sqlite`
 * 静态 import 解析有问题（会误解析为裸包名 sqlite），走 require 则正确
 *  external 化为 Node 内置模块。tsx / node 直接运行不受影响。
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type Db = import('node:sqlite').DatabaseSync;
/** SQL 占位符参数类型（node:sqlite 原生类型）。 */
export type SqlParams = import('node:sqlite').SQLInputValue;

/** 建全部 5 张表（文档第 7 节）。本阶段只用 posts，其余为后续阶段准备。 */
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'mock',
  sourcePostId TEXT,
  authorHandle TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  publishedAt INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'zh',
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  views INTEGER,
  metricsCapturedAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_publishedAt ON posts (publishedAt DESC);
CREATE INDEX IF NOT EXISTS idx_posts_topic ON posts (topic);
CREATE INDEX IF NOT EXISTS idx_posts_language ON posts (language);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  postId INTEGER NOT NULL REFERENCES posts (id),
  topic TEXT NOT NULL DEFAULT '',
  coreClaims TEXT NOT NULL DEFAULT '[]',
  structure TEXT NOT NULL DEFAULT '',
  audienceNeeds TEXT NOT NULL DEFAULT '',
  contentAngles TEXT NOT NULL DEFAULT '[]',
  factCheckItems TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mock'
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh',
  format TEXT NOT NULL DEFAULT 'post',
  status TEXT NOT NULL DEFAULT 'draft',
  sourcePostIds TEXT NOT NULL DEFAULT '[]',
  sourceUrls TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL DEFAULT 'mock',
  model TEXT NOT NULL DEFAULT '',
  needsFactCheck INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draftId INTEGER NOT NULL REFERENCES drafts (id),
  content TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL,
  changeNote TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS publish_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draftId INTEGER NOT NULL REFERENCES drafts (id),
  mode TEXT NOT NULL DEFAULT 'mock',
  status TEXT NOT NULL DEFAULT 'pending',
  scheduledAt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  externalPostId TEXT,
  errorCode TEXT,
  errorMessage TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
`;

/** 打开数据库（文件路径不存在时自动建目录）。 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  return new DatabaseSync(path);
}

/** 执行建表迁移（幂等）。 */
export function migrate(db: Db): void {
  db.exec(MIGRATIONS);
}

/** 最小 query helper：返回全部行（对象数组）。 */
export function queryAll<T>(db: Db, sql: string, ...params: SqlParams[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** 最小 query helper：返回首行或 undefined。 */
export function queryOne<T>(db: Db, sql: string, ...params: SqlParams[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** 最小 query helper：返回单值（count 等）。 */
export function queryValue<T>(db: Db, sql: string, ...params: SqlParams[]): T {
  const row = db.prepare(sql).get(...params) as Record<string, T> | undefined;
  if (!row) throw new Error(`queryValue: no row for ${sql}`);
  return Object.values(row)[0] as T;
}
