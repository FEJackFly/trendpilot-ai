import type { FastifyReply } from 'fastify';
import type { ApiError } from '@trendpilot/shared';

/**
 * AI 提供商的结构化错误（文档第 14 节：失败可诊断）。
 * 所有 message 均为中文、可指导排查，且绝不包含密钥原文。
 */
export type AIErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_TIMEOUT'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_BAD_RESPONSE';

export class AIError extends Error {
  readonly code: AIErrorCode;

  constructor(code: AIErrorCode, message: string) {
    super(message);
    this.name = 'AIError';
    this.code = code;
  }
}

/** AIError → HTTP 状态码映射（路由层用）。 */
export function aiErrorStatus(code: AIErrorCode): number {
  switch (code) {
    case 'AI_NOT_CONFIGURED':
      return 503; // 服务端未配置，可修复
    case 'AI_TIMEOUT':
      return 504;
    case 'AI_UPSTREAM_ERROR':
    case 'AI_BAD_RESPONSE':
      return 502;
  }
}

/**
 * 路由层用：在 catch 中调用。AIError → 带 code 的中文错误响应；
 * 非 AIError 则原样抛出，走全局 500 处理。
 */
export function replyAIError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AIError) {
    const body: ApiError = { code: err.code, message: err.message };
    reply.status(aiErrorStatus(err.code)).send(body);
    return;
  }
  throw err;
}