import type { FastifyPluginAsync } from 'fastify';
import type { HealthStatus } from '@trendpilot/shared';
import { SERVICE_NAME, SERVICE_VERSION } from '../app.js';

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: HealthStatus }>('/health', async () => ({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    time: new Date().toISOString(),
  }));
};
