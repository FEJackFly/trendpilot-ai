import type { ApiError } from '@trendpilot/shared';
import type { Env } from '../config/env.js';
import { env } from '../config/env.js';

/**
 * X API 适配器（文档第 11 节）。
 * 本阶段不实际调用任何外部 API、不实现任何绕过授权的抓取逻辑：
 * - X_API_ENABLED=false → DisabledXApiClient，所有方法抛 X_API_DISABLED。
 * - X_API_ENABLED=true → RealXApiClient 骨架：接口签名完整（含发布幂等键），
 *   真实 endpoint 接入待后续阶段（需先确认官方 API 权限、价格与配额）。
 */

export type XApiErrorCode = 'X_API_DISABLED' | 'X_API_NOT_CONFIGURED' | 'X_API_NOT_IMPLEMENTED';

export interface XApiError extends ApiError {
  code: XApiErrorCode;
}

/** X 未启用时的标准错误。 */
export function xApiDisabledError(): XApiError {
  return {
    code: 'X_API_DISABLED',
    message:
      'X API 未启用：请在服务端 .env 设置 X_API_ENABLED=true，并按官方文档完成 OAuth 2.0 授权后再试（https://developer.x.com）。',
  };
}

/** 真实 endpoint 尚未接入时的标准错误（骨架已就绪，调用会明确失败，不静默）。 */
export function xApiNotImplementedError(op: string): XApiError {
  return {
    code: 'X_API_NOT_IMPLEMENTED',
    message: `X ${op}适配器骨架已就绪，真实 endpoint 接入待后续阶段（需先确认官方 API 权限、价格与配额）。本次调用未向 X 发送任何请求。`,
  };
}

export interface XSearchParams {
  query: string;
  /** 每页条数，默认 20，上限 100。 */
  maxResults?: number;
}

export interface XSearchHit {
  sourcePostId: string;
  authorHandle: string;
  text: string;
  url: string;
  /** ISO 8601 发布时间。 */
  publishedAt: string;
  likes: number;
  reposts: number;
  replies: number;
  /** 浏览量；仅上游提供时记录，可为空，绝不编造。 */
  views: number | null;
}

export interface XSearchResult {
  posts: XSearchHit[];
}

export interface XPostParams {
  text: string;
  /**
   * 幂等键：调用方传入任务 id（如 `task-123`）。
   * 真实接入时用于 X 侧去重，保证网络超时重试不会重复发布。
   */
  clientMutationId: string;
}

export interface XPostResult {
  externalPostId: string;
}

export interface XApiClient {
  readonly enabled: boolean;
  search(params: XSearchParams): Promise<XSearchResult>;
  post(params: XPostParams): Promise<XPostResult>;
}

/** 未启用时的空实现：所有方法明确抛错，不伪装成功。 */
export class DisabledXApiClient implements XApiClient {
  readonly enabled = false;

  async search(_params: XSearchParams): Promise<XSearchResult> {
    throw xApiDisabledError();
  }

  async post(_params: XPostParams): Promise<XPostResult> {
    throw xApiDisabledError();
  }
}

/**
 * 真实客户端骨架：签名完整，构造时无 token 即 fail fast。
 * 方法体暂抛 X_API_NOT_IMPLEMENTED——本阶段不发起任何外部调用。
 */
export class RealXApiClient implements XApiClient {
  readonly enabled = true;
  private readonly bearerToken: string;

  constructor(opts: { bearerToken: string }) {
    if (!opts.bearerToken || opts.bearerToken.trim().length === 0) {
      const err: XApiError = {
        code: 'X_API_NOT_CONFIGURED',
        message:
          'X_API_ENABLED=true 但未配置 X_BEARER_TOKEN：请在服务端 .env 设置后重启服务（https://developer.x.com）。',
      };
      throw err;
    }
    this.bearerToken = opts.bearerToken;
  }

  /** 供后续阶段真实接入使用；当前阶段仅保留签名。 */
  get authHeader(): string {
    return `Bearer ${this.bearerToken}`;
  }

  async search(_params: XSearchParams): Promise<XSearchResult> {
    throw xApiNotImplementedError('搜索');
  }

  async post(_params: XPostParams): Promise<XPostResult> {
    throw xApiNotImplementedError('发布');
  }
}

/** 按环境变量创建 X 客户端。 */
export function createXApiClient(e: Env = env): XApiClient {
  if (!e.X_API_ENABLED) {
    return new DisabledXApiClient();
  }
  return new RealXApiClient({ bearerToken: e.X_BEARER_TOKEN });
}
