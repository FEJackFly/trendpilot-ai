import type { LoggerOptions } from 'pino';

/**
 * 日志脱敏（文档第 12 节：日志不得输出密钥、访问令牌或完整敏感请求头）。
 * pino 的 redact 会在序列化时把命中路径的值替换为 '***'。
 */
export const REDACT_CENSOR = '***';

/**
 * 敏感字段路径（pino redact 语法）。
 * 覆盖顶层、常见嵌套对象（config/headers/body）与 Fastify 请求头位置。
 */
export const SENSITIVE_PATHS: string[] = [
  // 顶层
  'api_key',
  'apiKey',
  'apikey',
  'authorization',
  'client_secret',
  'clientSecret',
  'secret',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'password',
  // 一层嵌套（如 { config: { api_key } }、{ headers: { authorization } }）
  '*.api_key',
  '*.apiKey',
  '*.authorization',
  '*.client_secret',
  '*.clientSecret',
  '*.secret',
  '*.token',
  '*.access_token',
  '*.password',
  // Fastify / HTTP 常见位置
  'req.headers.authorization',
  'request.headers.authorization',
];

/** 供 Fastify({ logger }) 使用的 pino 配置（含脱敏）。 */
export function loggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: SENSITIVE_PATHS,
      censor: REDACT_CENSOR,
    },
  };
}
