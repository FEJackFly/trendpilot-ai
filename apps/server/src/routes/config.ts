import type { FastifyPluginAsync } from 'fastify';
import type { ConfigStatus } from '@trendpilot/shared';
import { env } from '../config/env.js';

export const registerConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ConfigStatus }>('/config/status', async () => ({
    dataMode: env.DATA_MODE,
    aiProvider: env.AI_PROVIDER,
    xApiEnabled: env.X_API_ENABLED,
    // 只返回"是否已配置"的布尔标志，绝不返回密钥原文。
    aiConfigured: env.AI_API_KEY.length > 0,
    // 真实发布未启用前只列 mock；x_api 需真实执行器接入并通过验收后才开放。
    publishingModes: ['mock'],
  }));
};
