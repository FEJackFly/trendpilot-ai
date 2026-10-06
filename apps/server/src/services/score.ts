/**
 * 热度评分（文档第 9 节）。纯函数，便于单测。
 *
 * engagement = likes + 2 * reposts + 1.5 * replies
 * score = log(1 + engagement) * exp(-ageHours / 48)
 *
 * 说明：
 * - 权重与 48 小时衰减只是起始假设，需用实际数据调整；
 * - 缺少浏览量时不编造（views 不参与公式）；
 * - 互动量高不代表内容优质；热度、主题相关度、内容质量应分开展示。
 */

/** 衰减半衰期（小时）。 */
export const DECAY_HALF_LIFE_HOURS = 48;

export interface EngagementInput {
  likes: number;
  reposts: number;
  replies: number;
}

/** 计算原始互动量。 */
export function engagementOf(input: EngagementInput): number {
  return input.likes + 2 * input.reposts + 1.5 * input.replies;
}

/** 由互动量和帖子年龄（小时）计算热度分数。 */
export function hotScore(engagement: number, ageHours: number): number {
  if (engagement < 0) throw new RangeError('engagement must be >= 0');
  if (ageHours < 0) throw new RangeError('ageHours must be >= 0');
  return Math.log(1 + engagement) * Math.exp(-ageHours / DECAY_HALF_LIFE_HOURS);
}

/** 由发布时间戳（Unix 毫秒）计算年龄（小时）。nowMs 默认为当前时间，便于测试注入。 */
export function ageHoursOf(publishedAt: number, nowMs: number = Date.now()): number {
  return Math.max(0, (nowMs - publishedAt) / 3_600_000);
}
