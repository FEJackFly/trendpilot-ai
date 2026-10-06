# TrendPilot AI（本地版）

本地优先的 X（原 Twitter）热门内容发现、分析、AI 原创创作与发布工作台。

> 当前进度：**阶段 6（真实集成）** 已完成，全部 6 个阶段完工。
> 详见下方各阶段说明。

## 技术栈

| 部分   | 技术                                  |
| ------ | ------------------------------------- |
| 前端   | React 18 + Vite 5 + TypeScript + Ant Design + React Router + TanStack Query |
| 后端   | Node.js + Fastify + TypeScript + Zod + Pino + node:sqlite |
| 共享   | `@trendpilot/shared` 共享类型包       |
| 包管理 | pnpm workspace                        |
| 测试   | Vitest（后端）                        |

## 快速开始

```bash
# 1. 安装依赖（项目根目录）
pnpm install

# 2. 同时启动前后端
pnpm dev
```

| 服务 | 地址                  | 说明                          |
| ---- | --------------------- | ----------------------------- |
| 前端 | http://localhost:5173 | Vite dev server               |
| 后端 | http://localhost:3001 | Fastify；可用 `PORT` 环境变量覆盖 |

前端通过 Vite proxy 把 `/api/*` 转发到 `http://localhost:3001`，页面上的"后端状态"卡片会实时显示后端健康检查结果。

## 可用脚本（项目根目录）

| 命令            | 说明                     |
| --------------- | ------------------------ |
| `pnpm dev`      | 同时启动前端 + 后端      |
| `pnpm build`    | 构建全部包               |
| `pnpm typecheck`| 全部包 TypeScript 类型检查 |
| `pnpm test`     | 运行 Vitest 测试         |
| `pnpm lint`     | 全部包 ESLint 检查       |

以上脚本均为跨平台写法（Windows / macOS / Linux 通用）。

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改（阶段 1 无需真实密钥）：

```bash
cp .env.example .env
```

关键变量：`PORT`（默认 3001）、`DATA_MODE`（`mock`/`live`，默认 `mock`）、
`AI_PROVIDER`（默认 `mock`）、`X_API_ENABLED`（默认 `false`）。
后端启动时用 Zod 严格校验，非法值会直接拒绝启动。
`.env` 已加入 `.gitignore`，不要提交真实密钥。

## API（阶段 1）

- `GET /api/health` → `{ ok, service, version, time }`
- `GET /api/config/status` → `{ dataMode, aiProvider, xApiEnabled, aiConfigured }`
  （只返回能力标志，绝不返回密钥原文）

## API（阶段 2 新增）

- `GET /api/posts?keyword=&topic=&language=&sort=hot|new|likes&page=&pageSize=`
  → `{ items, total, page, pageSize, mode }`；`mode` 由服务端硬编码为 `'demo'`
- `GET /api/posts/:id` → 帖子详情（含 `engagement` 与 `score`）；不存在返回
  `404 { code: 'POST_NOT_FOUND', message }`

热度公式：`engagement = likes + 2*reposts + 1.5*replies`，
`score = log(1+engagement) * exp(-ageHours/48)`（见 `apps/server/src/services/score.ts`）。

数据库：`data/trendpilot.db`（SQLite，Node 内置 `node:sqlite`，首次启动自动建表并写入
50 条 mock 种子帖子；重启不重复）。5 张表（`posts`/`analyses`/`drafts`/
`draft_versions`/`publish_tasks`）已建好，本阶段只用 `posts`。

## 前端页面（阶段 2 新增）

| 页面 | 路由 | 说明 |
| ---- | ---- | ---- |
| 仪表盘（占位） | `/dashboard` | 阶段 5 实现 |
| 热门发现 | `/discover` | 搜索、主题/语言筛选、排序、分页、收藏、批量选择 |
| 帖子详情 | `/posts/:id` | 原文、互动指标、热度分数及公式说明；"去分析"按钮提示阶段 3 未实现 |

顶部栏全局显示「演示模式」徽标；加载中 / 空结果 / 接口错误均有明确 UI。

## 阶段 1 完成情况

- [x] pnpm workspace 初始化
- [x] React + Vite + TypeScript 前端可启动（含演示模式徽标、后端状态显示）
- [x] Fastify + TypeScript 后端可启动（Zod 环境校验 + Pino 日志）
- [x] `GET /api/health` 返回成功
- [x] 共享类型包 `@trendpilot/shared`
- [x] 根脚本：dev / build / typecheck / test / lint
- [x] 基础测试（health 结构、config 不泄露密钥、环境变量校验）
- [x] lint / 类型检查 / 测试 / 构建全部通过

## 阶段 6 完成情况：真实集成（AI/X 适配器与配置门控）

> 本阶段**不实际调用**任何外部 API、不要求用户提供密钥。目标是真实适配器的
> 代码路径完整可用、配置门控正确、失败可诊断、模拟/真实模式可清晰区分。

### 后端

- `src/providers/ai.ts`：新增 `OpenAICompatibleProvider`（OpenAI-compatible chat
  completions，`AI_BASE_URL` 可配，默认 `https://api.openai.com/v1`，30s 超时），
  `createAIProvider(env)` 工厂按 `AI_PROVIDER` 选择实现；真实 provider 在
  `AI_API_KEY` 为空时**构造即抛** `AI_NOT_CONFIGURED`（fail fast）。
  结构化错误码：`AI_NOT_CONFIGURED` / `AI_TIMEOUT` / `AI_UPSTREAM_ERROR` /
  `AI_BAD_RESPONSE`，message 为中文、可诊断、**绝不包含密钥**。
- `src/providers/prompts.ts`：analyze / generate 的 prompt 模板，要求模型只返回
  JSON（含 JSON schema 说明）；解析失败 → `AI_BAD_RESPONSE`。
- `src/providers/x.ts`：`XApiClient` 接口 + `DisabledXApiClient`
 （`X_API_ENABLED=false` 时所有方法抛 `X_API_DISABLED`）+ `RealXApiClient` 骨架
  （签名完整，`post` 含 `clientMutationId` 幂等键；真实 endpoint 待后续阶段）。
  不实现任何绕过授权的抓取逻辑。
- `GET /api/config/status` 新增 `publishingModes: ['mock']`
  （真实发布未启用前只列 mock）；仍只返回能力标志，不返回密钥。
- `src/jobs/publisher.ts`：只执行 `mode='mock'` 任务；DB 中若出现 `x_api`
  任务且 X 未配置 → 标记 `failed` / `X_API_DISABLED`，绝不静默丢弃，
  不向 X 发送任何请求。
- 日志脱敏：`src/utils/redact.ts`，pino `redact` 对 `api_key` / `authorization` /
  `client_secret` 等字段自动打码为 `***`。

### 前端

- 新增 `/settings` 设置页：数据模式（只读，由服务端决定）、AI 提供商
  （当前状态 + 配置指引下拉，**不提供密钥输入框**）、X API（启用状态 +
  官方申请指引 https://developer.x.com）、安全提示区。
- 顶部「演示模式」徽标改为后端 `/api/config/status` 驱动：
  `mock` → 橙色「演示模式」，`live` → 绿色「真实数据模式」。
- 发布中心：任务 mode 徽标（模拟/真实）；`x_api` 任务的取消/重试走二次确认
  Modal（展示账号 / 内容 / 计划时间三要素）。mock 流程不变。

### 真实集成配置步骤（需要时）

```bash
cp .env.example .env
```

| 变量 | 说明 |
| ---- | ---- |
| `AI_PROVIDER` | `mock`（默认）/`openai`/`anthropic`/`custom` |
| `AI_API_KEY` | 真实 provider 必填；只放服务端环境变量或凭据存储 |
| `AI_BASE_URL` | openai 可缺省；anthropic/custom 必填（OpenAI 兼容网关地址）|
| `AI_MODEL` | 模型名；缺省按 provider 取默认值 |
| `X_API_ENABLED` | 默认 `false`；真实发布需 `true` + 官方 OAuth 授权 |
| `X_BEARER_TOKEN` | `X_API_ENABLED=true` 时必填 |

### 安全注意事项

- 密钥只存服务端环境变量/凭据存储，不提交 git（`.env` 已在 `.gitignore`），
  不在前端输入、传输或展示，不出现在日志中（自动脱敏）。
- `/api/config/status` 只返回"是否已配置"的布尔标志。
- 模拟数据绝不标为真实数据；`mode` 字段一律由服务端决定。
- 真实发布上线前必须：二次确认账号/内容/时间、检查 API 配额与平台自动化政策、
  使用任务锁与幂等键防止重复发布。

### 测试

- 缺 `AI_API_KEY` 时 `createAIProvider({AI_PROVIDER:'openai'})` → `AI_NOT_CONFIGURED`
- 注入 fetch 模拟超时 → `AI_TIMEOUT`（message 不含密钥）；HTTP 401 →
  `AI_UPSTREAM_ERROR`；非法 JSON → `AI_BAD_RESPONSE`
- 日志脱敏：含 `api_key`/`authorization`/`client_secret` 的对象输出为 `***`
- 注入假密钥后 `GET /api/config/status` 响应体全文不含密钥值
- X 未启用时 `x_api` 任务 → 执行器标记 `failed` / `X_API_DISABLED`
- 全量：87 个测试通过（前序 65 个继续通过），typecheck / lint / build 全过
