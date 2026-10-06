import { z } from 'zod';

/**
 * 严格解析 "true"/"false" 字符串为布尔值。
 * 不用 z.coerce.boolean()，因为它会把 "false" 当成 true（非空字符串恒为真）。
 */
const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1).default('./data/trendpilot.db'),
  DATA_MODE: z.enum(['mock', 'live']).default('mock'),
  AI_PROVIDER: z.enum(['mock', 'openai', 'anthropic', 'custom']).default('mock'),
  AI_API_KEY: z.string().default(''),
  /** OpenAI 兼容接口地址；openai 可缺省（默认官方地址），anthropic/custom 必填。 */
  AI_BASE_URL: z.string().default(''),
  /** 模型名；缺省时按 provider 取默认值。 */
  AI_MODEL: z.string().default(''),
  X_API_ENABLED: booleanFromString,
  X_CLIENT_ID: z.string().default(''),
  X_CLIENT_SECRET: z.string().default(''),
  /** X API v2 应用级 Bearer Token；X_API_ENABLED=true 时必填。 */
  X_BEARER_TOKEN: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

/** 校验环境变量；非法值直接抛 ZodError，服务拒绝启动。 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

export const env: Env = parseEnv();
