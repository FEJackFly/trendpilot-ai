import { AIError } from './errors.js';
import type { AnalyzeInput } from './ai.js';
import type { GenerateInput } from './ai.js';

/**
 * 真实 AI 提供商的 prompt 模板（文档第 10 节）。
 * 要求模型只返回 JSON；解析与校验失败由 extractJson 抛 AI_BAD_RESPONSE。
 */

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** analyze 返回的 JSON 结构说明（写进 system prompt）。 */
export const ANALYZE_RESPONSE_SCHEMA = `{
  "topic": "string，主题分类（尽量用帖子原文的主题）",
  "coreClaims": ["string，核心观点，最多 3 条"],
  "structure": "string，内容结构描述（一句话）",
  "audienceNeeds": "string，这类内容的受众需求（一句话）",
  "contentAngles": ["string，可用于二创的角度，最多 4 条"],
  "factCheckItems": ["string，引用前必须核实的主张"]
}`;

/** generate 返回的 JSON 结构说明。 */
export const GENERATE_RESPONSE_SCHEMA = `{
  "title": "string，草稿标题",
  "content": "string，草稿正文（Markdown）",
  "keyPoints": ["string，要点"]
}`;

const ORIGINALITY_RULES = [
  '必须用自己的话重写，严禁复制原文超过 50 个连续字符。',
  '必须加入独立观点、个人经验、验证方法或原创示例中的至少一项。',
  '原文中的数字、案例、结论一律视为"待核实"，在 factCheckItems/正文中明确提醒读者核实。',
  '只返回 JSON，不要返回任何解释性文字或 Markdown 代码围栏之外的文字。',
].join('\n');

export function buildAnalyzeMessages(post: AnalyzeInput): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是社交媒体内容分析助手。分析给定的帖子，提取主题、核心观点、结构、受众需求、可创作角度和需要核实的主张。',
        '只返回 JSON，JSON 结构如下：',
        ANALYZE_RESPONSE_SCHEMA,
        ORIGINALITY_RULES,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `作者：${post.authorHandle}`,
        `主题：${post.topic || '未分类'}`,
        `语言：${post.language || 'zh'}`,
        `原文：`,
        post.text,
      ].join('\n'),
    },
  ];
}

const MODE_LABEL: Record<GenerateInput['mode'], string> = {
  tutorial: '教程',
  opinion: '独立观点',
  'case-study': '案例分析',
  comparison: '工具对比',
  longform: '长文',
  thread: '系列帖子',
};

export function buildGenerateMessages(input: GenerateInput): ChatMessage[] {
  const refs =
    input.sourcePosts.length > 0
      ? input.sourcePosts
          .map((p, i) => `${i + 1}. ${p.authorHandle}（${p.topic || '未分类'}）：${p.text}`)
          .join('\n')
      : '（未提供参考帖子）';
  return [
    {
      role: 'system',
      content: [
        '你是中文内容创作助手。根据参考素材和创作要求，写一篇原创草稿。',
        '只返回 JSON，JSON 结构如下：',
        GENERATE_RESPONSE_SCHEMA,
        ORIGINALITY_RULES,
        '正文用 Markdown，长度适中，结尾可加一句引导讨论的问题。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `创作模式：${MODE_LABEL[input.mode]}`,
        `写作目标：${input.goal?.trim() || '分享有价值的观点'}`,
        `目标读者：${input.audience?.trim() || '同领域从业者'}`,
        `语言：${input.language || 'zh'}`,
        input.instructions?.trim() ? `补充说明：${input.instructions.trim()}` : '',
        '参考素材（仅供启发，不得复制）：',
        refs,
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
  ];
}

/**
 * 从模型返回文本中提取 JSON（容忍 Markdown 代码围栏 ```json ... ```）。
 * 解析失败 → AI_BAD_RESPONSE（message 不含原文全文，只给摘要，避免日志膨胀）。
 */
export function extractJson<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const snippet = cleaned.slice(0, 120).replace(/\s+/g, ' ');
    throw new AIError(
      'AI_BAD_RESPONSE',
      `AI 返回内容不是合法 JSON，已丢弃本次结果。请重试；若持续失败请检查模型与 prompt 配置。返回摘要：${snippet || '（空）'}`,
    );
  }
}

/** 断言值为非空字符串数组，否则抛 AI_BAD_RESPONSE（字段名用于诊断）。 */
export function mustBeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new AIError('AI_BAD_RESPONSE', `AI 返回的 JSON 中字段 "${field}" 不是字符串数组，已丢弃本次结果。`);
  }
  return value as string[];
}

/** 断言值为字符串，否则抛 AI_BAD_RESPONSE。 */
export function mustBeString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AIError('AI_BAD_RESPONSE', `AI 返回的 JSON 中字段 "${field}" 不是字符串，已丢弃本次结果。`);
  }
  return value;
}
