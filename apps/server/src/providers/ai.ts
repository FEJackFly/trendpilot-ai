import type {
  AiProvider,
  DraftFormat,
  DraftResult,
  GenerateDraftInput,
  GenerateMode,
} from '@trendpilot/shared';
import type { Env } from '../config/env.js';
import { env } from '../config/env.js';
import { AIError } from './errors.js';
export { AIError, aiErrorStatus, replyAIError } from './errors.js';
import {
  buildAnalyzeMessages,
  buildGenerateMessages,
  extractJson,
  mustBeString,
  mustBeStringArray,
  type ChatMessage,
} from './prompts.js';

/** 分析输入：精简后的帖子信息（provider 不直接依赖 DB 行类型）。 */
export interface AnalyzeInput {
id: number;
text: string;
topic: string;
authorHandle: string;
language: string;
url: string;
}

/** AIProvider.analyze 的返回（不含 id/postId/createdAt，由路由层落库时补充）。 */
export interface AnalysisResult {
topic: string;
coreClaims: string[];
structure: string;
audienceNeeds: string;
contentAngles: string[];
factCheckItems: string[];
provider: AiProvider;
}

/** 生成输入：草稿参数 + 参考帖子原文（路由层负责把 sourcePostIds 解析成帖子）。 */
export interface GenerateInput extends GenerateDraftInput {
sourcePosts: Array<{ id: number; text: string; authorHandle: string; url: string; topic: string}>;
}

/**
* AI 提供商抽象（文档第 10 节）。
* 第一版只有 MockAIProvider；后续接真实模型时实现同一接口即可替换。
*/
export interface AIProvider {
readonly name: AiProvider;
analyze(post: AnalyzeInput): Promise<AnalysisResult>;
generateDraft(input: GenerateInput): Promise<DraftResult>;
}

/* ---------------- 启发式工具 ---------------- */

/** 按中英文标点切分句子。 */
function splitSentences(text: string): string[] {
return text
.split(/(?<=[。！？!?.])\s*/)
.map((s) => s.trim())
.filter((s) => s.length > 0);
}

/** 文本中是否包含数字（数据主张的信号）。 */
function containsNumber(text: string): boolean {
return /[0-9]/.test(text);
}

/** 提取文本中的数字片段（用于事实核查提醒）。 */
function extractNumbers(text: string): string[] {
const m = text.match(/[0-9]+(?:\.[0-9]+)?[%％]?/g);
return m? [...new Set(m)].slice(0, 5): [];
}

/** 简单关键词 → 受众需求映射。 */
const AUDIENCE_HINTS: Array<{ keys: string[]; need: string}> = [
{ keys: ['cursor', 'copilot', 'ai', 'prompt', '代码', '编程', 'code', 'bug', '测试'], need: '想借助 AI 提升编码效率、少踩坑的开发者'},
{ keys: ['react', 'css', '组件', '前端', '性能', 'typescript'], need: '关注前端工程实践与性能优化的开发者'},
{ keys: ['创业', 'startup', '融资', '增长', '用户'], need: '寻找增长思路与避坑经验的创业者/独立开发者'},
{ keys: ['效率', '工具', '工作流', 'productivity'], need: '想优化个人工作流的知识工作者'},
{ keys: ['设计', 'figma', 'ui', 'ux'], need: '关注设计与开发协作的设计师/前端'},
];

function inferAudienceNeeds(text: string, topic: string): string {
const lower = text.toLowerCase();
const hit = AUDIENCE_HINTS.find((h) => h.keys.some((k) => lower.includes(k.toLowerCase())));
const base = hit? hit.need: '对该话题感兴趣的普通读者';
return `${base}（主题：${topic || '未分类'}）`;
}

/** 结构启发式：根据文本特征判断内容结构。 */
function inferStructure(text: string): string {
const sentences = splitSentences(text);
const hasPersonal = /我|自己|我们|my|i /i.test(text);
const hasContrast = /但是|然而|不过|but|however|vs|对比/i.test(text);
const hasData = containsNumber(text);
const parts: string[] = [];
if (hasPersonal) parts.push('个人经历/第一人称叙述');
if (hasContrast) parts.push('转折/对比论证');
if (hasData) parts.push('数据佐证');
parts.push(sentences.length <= 2? '短平快的单观点输出': '多句递进论述');
return parts.join(' + ');
}

/** 基于主题与文本生成可创作角度。 */
function inferContentAngles(text: string, topic: string): string[] {
const lower = text.toLowerCase();
const angles: string[] = [];
if (/ai|cursor|copilot|prompt|代码|编程/i.test(lower)) {
angles.push('教程：把帖子中的做法拆解成可复现的步骤指南');
angles.push('独立观点：AI 提效的边界——哪些环节仍然必须人工把关');
}
if (containsNumber(text)) {
angles.push('案例分析：用自己的实测数据验证/反驳帖子中的数字');
}
angles.push(`工具对比：与同主题其他方案做横向对比（主题：${topic || '未分类'}）`);
angles.push('经验复盘：讲一个自己踩过的类似坑，给出检查清单');
return [...new Set(angles)].slice(0, 4);
}

/* ---------------- MockAIProvider ---------------- */

const MOCK_MODEL = 'mock-rule-engine-v1';

const MOCK_DISCLAIMER = '以下内容由本地规则引擎生成，仅供流程演示，观点与数据未经验证。';

/**
* MockAIProvider：基于规则的模拟实现。
* - analyze：关键词/文本特征启发式提取主题、观点、结构等。
* - generateDraft：按创作模式套用占位结构生成草稿。
* 所有输出 provider 均为 'mock'，内容首行带模拟声明，绝不伪称调用了真实模型。
*/
export class MockAIProvider implements AIProvider {
readonly name: AiProvider = 'mock';

async analyze(post: AnalyzeInput): Promise<AnalysisResult> {
const sentences = splitSentences(post.text);
const coreClaims = sentences.slice(0, 3).map((s) => s.replace(/^/, '').trim());
if (coreClaims.length === 0) coreClaims.push('（未能从原文提取到有效句子）');

const numbers = extractNumbers(post.text);
const factCheckItems: string[] = [];
if (numbers.length > 0) {
factCheckItems.push(`原文提到数字 ${numbers.join('、')}，引用前请核实出处与口径`);
}
factCheckItems.push('作者身份与经历描述未经核验，视为个人观点而非事实');
factCheckItems.push('二创时不得直接复制原文，需加入独立观点、验证或原创示例');

return {
topic: post.topic || '未分类',
coreClaims,
structure: inferStructure(post.text),
audienceNeeds: inferAudienceNeeds(post.text, post.topic),
contentAngles: inferContentAngles(post.text, post.topic),
factCheckItems,
provider: 'mock',
};
}

async generateDraft(input: GenerateInput): Promise<DraftResult> {
const refs = input.sourcePosts;
const sourceUrls = refs.map((p) => p.url).filter((u) => u && u!== '#');
const refSummary =
refs.length > 0
? refs.map((p, i) => `${i + 1}. ${p.authorHandle}：${p.text.slice(0, 80)}${p.text.length > 80? '…': ''}`).join('\n')
: '（未提供参考帖子）';
const goal = input.goal?.trim() || '分享有价值的观点';
const audience = input.audience?.trim() || '同领域从业者';
const instructions = input.instructions?.trim();

const body = buildBodyByMode(input.mode, {
goal,
audience,
instructions,
language: input.language || 'zh',
refSummary,
refCount: refs.length,
});

const title = buildTitle(input.mode, refs);

return {
title,
content: `${MOCK_DISCLAIMER}\n\n${body}`,
keyPoints: buildKeyPoints(input.mode, goal),
sourceUrls,
needsFactCheck: true,
warnings: [
'模拟生成：内容由本地规则引擎拼装，未经真实大模型验证，观点可能空洞或不准确。',
'引用任何数据、案例前必须人工核实来源。',
'发布前请通读全文，删除模板痕迹，加入你自己的经验与判断。',
],
provider: 'mock',
model: MOCK_MODEL,
};
}
}

const MODE_LABEL: Record<GenerateMode, string> = {
tutorial: '教程',
opinion: '独立观点',
'case-study': '案例分析',
comparison: '工具对比',
longform: '长文',
thread: '系列帖子',
};

interface BodyCtx {
goal: string;
audience: string;
instructions?: string;
language: string;
refSummary: string;
refCount: number;
}

function buildTitle(mode: GenerateMode, refs: GenerateInput['sourcePosts']): string {
const label = MODE_LABEL[mode];
const topic = refs[0]?.topic || '热门话题';
return `${label}：关于「${topic}」的创作草稿`;
}

function buildKeyPoints(mode: GenerateMode, goal: string): string[] {
return [
`创作模式：${MODE_LABEL[mode]}`,
`目标：${goal}`,
'以下正文为模板化占位结构，需人工填充真实经验与数据',
];
}

/** 按创作模式生成带占位结构的内容。format 由调用方决定，此处只管正文骨架。 */
function buildBodyByMode(mode: GenerateMode, ctx: BodyCtx): string {
const head = `目标读者：${ctx.audience}\n写作目标：${ctx.goal}\n${ctx.instructions? `补充说明：${ctx.instructions}\n`: ''}\n参考素材（${ctx.refCount} 条）：\n${ctx.refSummary}\n`;
const tail = `\n---\n（以上为模拟生成的占位结构。请替换为你自己的真实经历、数据与判断后再发布。）`;

switch (mode) {
case 'tutorial':
return (
head +
`\n## 步骤 1：准备\n[在此填写准备工作：环境、工具、背景知识]\n\n## 步骤 2：操作\n[在此填写具体操作步骤，建议配截图或代码]\n\n## 步骤 3：验证\n[在此填写如何验证结果符合预期]\n\n## 常见坑\n- [坑 1：…]\n- [坑 2：…]` +
tail
);
case 'opinion':
return (
head +
`\n## 我的观点\n[一句话亮明立场]\n\n## 为什么这么看\n1. [论据 1：…]\n2. [论据 2：…]\n\n## 反方可能怎么说\n[预判反对意见并回应，显得更可信]` +
tail
);
case 'case-study':
return (
head +
`\n## 背景\n[项目/场景背景]\n\n## 做法\n[具体做了什么，关键决策点]\n\n## 结果（需核实数据）\n[量化结果：数字必须有出处]\n\n## 复盘\n[做对了什么、做错了什么、下次怎么做]` +
tail
);
case 'comparison':
return (
head +
`\n## 对比维度\n| 维度 | 方案 A | 方案 B |\n|---|---|---|\n| 上手成本 | [填写] | [填写] |\n| 适用场景 | [填写] | [填写] |\n| 短板 | [填写] | [填写] |\n\n## 结论：什么人选哪个\n[给出明确的选择建议]` +
tail
);
case 'longform':
return (
head +
`\n## 引子\n[用一个具体场景或数据开场]\n\n## 现状\n[讲清楚背景与问题]\n\n## 分析\n[分 2-3 个层次展开]\n\n## 判断与建议\n[给出你的结论]` +
tail
);
case 'thread':
return (
head +
`\n1/ [开篇钩子：一句话讲清这条 thread 的价值]\n\n2/ [观点 1]\n\n3/ [观点 2，配例子]\n\n4/ [观点 3]\n\n5/ [总结 + 引导讨论的问题]` +
tail
);
default:
return head + `\n[正文占位：请按你的思路填充]` + tail;
}
}

/* ---------------- 真实 AI 提供商（OpenAI 兼容接口） ---------------- */

/** OpenAI chat completions 返回的最小结构（只取需要的字段）。 */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** 可注入 fetch，便于单测模拟超时/HTTP 错误/非法 JSON（不发起真实网络调用）。 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleOptions {
  name: Extract<AiProvider, 'openai' | 'anthropic' | 'custom'>;
  apiKey: string;
  baseURL: string;
  model: string;
  /** 请求超时毫秒数，默认 30s。 */
  timeoutMs?: number;
  fetchFn?: FetchFn;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError')
  );
}

/**
 * OpenAICompatibleProvider：调用 OpenAI-compatible chat completions 接口。
 * - apiKey 为空时构造即抛 AI_NOT_CONFIGURED（fail fast，不等到调用时）。
 * - 超时 30s（AbortController）；所有错误 message 为中文、可诊断，且绝不包含密钥。
 * - 要求模型返回 JSON，解析失败 → AI_BAD_RESPONSE。
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: AiProvider;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new AIError(
        'AI_NOT_CONFIGURED',
        '未配置 AI_API_KEY：请在服务端 .env 中设置 AI_API_KEY 后重启服务。密钥只能放在服务端环境变量或凭据存储中，不要写进前端代码或提交到 git。',
      );
    }
    if (!opts.baseURL || opts.baseURL.trim().length === 0) {
      throw new AIError(
        'AI_NOT_CONFIGURED',
        '未配置 AI_BASE_URL：请在服务端 .env 中设置 AI_BASE_URL（OpenAI 兼容接口地址）后重启服务。',
      );
    }
    this.name = opts.name;
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** 发起一次 chat completions 调用，返回模型文本内容。 */
  private async chat(messages: ChatMessage[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 注意：密钥只出现在发往上游的 Authorization 头中，绝不进入错误 message 或日志。
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
        throw new AIError(
          'AI_UPSTREAM_ERROR',
          `AI 上游返回 HTTP ${res.status}：请检查 AI_API_KEY 是否有效、AI_BASE_URL 是否正确、账户配额是否充足。${snippet ? `上游摘要：${snippet}` : ''}`,
        );
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new AIError('AI_BAD_RESPONSE', 'AI 返回为空（choices[0].message.content 缺失），已丢弃本次结果。');
      }
      return content;
    } catch (err) {
      if (err instanceof AIError) throw err;
      if (isAbortError(err)) {
        throw new AIError(
          'AI_TIMEOUT',
          `AI 请求超时（${Math.round(this.timeoutMs / 1000)}s）：请检查网络连通性、AI_BASE_URL 是否可达，或稍后重试；超时未产生有效结果。`,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new AIError('AI_UPSTREAM_ERROR', `AI 上游网络错误：${reason}。请检查 AI_BASE_URL 与网络。`);
    } finally {
      clearTimeout(timer);
    }
  }

  async analyze(post: AnalyzeInput): Promise<AnalysisResult> {
    const text = await this.chat(buildAnalyzeMessages(post));
    const parsed = extractJson<Record<string, unknown>>(text);
    return {
      topic: mustBeString(parsed.topic, 'topic'),
      coreClaims: mustBeStringArray(parsed.coreClaims, 'coreClaims').slice(0, 3),
      structure: mustBeString(parsed.structure, 'structure'),
      audienceNeeds: mustBeString(parsed.audienceNeeds, 'audienceNeeds'),
      contentAngles: mustBeStringArray(parsed.contentAngles, 'contentAngles').slice(0, 4),
      factCheckItems: mustBeStringArray(parsed.factCheckItems, 'factCheckItems'),
      provider: this.name,
    };
  }

  async generateDraft(input: GenerateInput): Promise<DraftResult> {
    const text = await this.chat(buildGenerateMessages(input));
    const parsed = extractJson<Record<string, unknown>>(text);
    const sourceUrls = input.sourcePosts.map((p) => p.url).filter((u) => u && u !== '#');
    return {
      title: mustBeString(parsed.title, 'title'),
      content: mustBeString(parsed.content, 'content'),
      keyPoints: mustBeStringArray(parsed.keyPoints, 'keyPoints'),
      sourceUrls,
      needsFactCheck: true,
      warnings: [
        '真实模型生成：内容未经人工核实，引用数据、案例前必须核实来源。',
        '发布前请通读全文，删除模板痕迹，加入你自己的经验与判断。',
      ],
      provider: this.name,
      model: this.model,
    };
  }
}

/* ---------------- 工厂 ---------------- */

/**
 * 按环境变量创建 AI 提供商（文档第 10 节：MockAIProvider 与真实 AIProvider 可替换）。
 * - mock → MockAIProvider（无需密钥）。
 * - openai/anthropic/custom → OpenAICompatibleProvider；key 为空时构造即抛 AI_NOT_CONFIGURED。
 * - anthropic 官方接口协议与 OpenAI 不兼容，需经 AI_BASE_URL 指向兼容网关。
 */
export function createAIProvider(e: Env = env): AIProvider {
  switch (e.AI_PROVIDER) {
    case 'mock':
      return new MockAIProvider();
    case 'openai':
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: e.AI_API_KEY,
        baseURL: e.AI_BASE_URL || 'https://api.openai.com/v1',
        model: e.AI_MODEL || 'gpt-4o-mini',
      });
    case 'anthropic': {
      if (!e.AI_BASE_URL.trim()) {
        throw new AIError(
          'AI_NOT_CONFIGURED',
          'AI_PROVIDER=anthropic 需要配置 AI_BASE_URL（OpenAI 兼容网关地址）：Anthropic 官方接口协议与本适配器不同，请通过兼容网关接入。',
        );
      }
      return new OpenAICompatibleProvider({
        name: 'anthropic',
        apiKey: e.AI_API_KEY,
        baseURL: e.AI_BASE_URL,
        model: e.AI_MODEL || 'claude-sonnet-4-5',
      });
    }
    case 'custom': {
      if (!e.AI_BASE_URL.trim()) {
        throw new AIError(
          'AI_NOT_CONFIGURED',
          'AI_PROVIDER=custom 需要配置 AI_BASE_URL（OpenAI 兼容接口地址）。',
        );
      }
      return new OpenAICompatibleProvider({
        name: 'custom',
        apiKey: e.AI_API_KEY,
        baseURL: e.AI_BASE_URL,
        model: e.AI_MODEL || 'default',
      });
    }
  }
}

/** DraftFormat 默认值兜底（非法值时回退为 'post'）。 */
export function normalizeFormat(f: string | undefined): DraftFormat {
const ok: DraftFormat[] = ['post', 'thread', 'article', 'tutorial'];
return (ok as string[]).includes(f?? '')? (f as DraftFormat): 'post';
}
