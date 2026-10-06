import type { Db } from './db.js';
import { queryValue } from './db.js';

/**
 * 种子数据：50 条 mock 帖子（5 主题 × 10 条，中英混合）。
 * - publishedAt 分散在最近 72 小时内；
 * - 互动数据分布合理（少数爆款、多数中等、少数冷门）；
 * - source 全部为 'mock'，绝不伪装成真实数据；
 * - 使用确定性 PRNG，多次 seeding 结果一致；
 * - posts 表已有数据时跳过，保证重启不重复。
 */

interface SeedPost {
  authorHandle: string;
  text: string;
  topic: string;
  language: 'zh' | 'en';
  likes: number;
  reposts: number;
  replies: number;
  /** views 为 null 表示数据源未提供（绝不编造）。 */
  views: number | null;
  /** 发布于多少小时前（0~72）。 */
  ageHours: number;
}

const POSTS: SeedPost[] = [
  // ---- AI Coding ----
  { authorHandle: '@ai_builder', topic: 'AI Coding', language: 'zh', ageHours: 3, likes: 4821, reposts: 812, replies: 356, views: 210000, text: '用 Cursor 重构了三年的祖传代码，AI 直接找出了 5 个隐藏 bug。感觉自己从代码搬运工变成了代码审查官。' },
  { authorHandle: '@code_monk', topic: 'AI Coding', language: 'en', ageHours: 9, likes: 2310, reposts: 340, replies: 128, views: 98000, text: 'Copilot just wrote a better regex than I ever could. I have been humbled.' },
  { authorHandle: '@测试工程师阿茶', topic: 'AI Coding', language: 'zh', ageHours: 15, likes: 1876, reposts: 290, replies: 203, views: 76000, text: '实测：让 AI 写单元测试，覆盖率从 40% 拉到 85%，但有 3 个测试是自欺欺人的 mock，review 时一定要看。' },
  { authorHandle: '@prompt_wizard', topic: 'AI Coding', language: 'en', ageHours: 22, likes: 3102, reposts: 520, replies: 187, views: 132000, text: 'The real 10x engineer in 2026 is just someone who writes really good prompts and actually reads the diff.' },
  { authorHandle: '@全栈老王', topic: 'AI Coding', language: 'zh', ageHours: 28, likes: 954, reposts: 120, replies: 88, views: 41000, text: '把需求文档丢给 AI 生成 API 设计，10 分钟出初稿，剩下时间都在跟产品经理吵字段命名。' },
  { authorHandle: '@debug_diaries', topic: 'AI Coding', language: 'en', ageHours: 35, likes: 1750, reposts: 210, replies: 96, views: 69000, text: 'AI code review caught a race condition I had been chasing for two days. I owe it a coffee. Or electricity.' },
  { authorHandle: '@应届生小林', topic: 'AI Coding', language: 'zh', ageHours: 44, likes: 623, reposts: 74, replies: 112, views: 28000, text: '新人用 AI 一天写完我一周的工作量，我的价值只剩下知道哪里会埋坑。' },
  { authorHandle: '@typed_frank', topic: 'AI Coding', language: 'en', ageHours: 52, likes: 2890, reposts: 445, replies: 231, views: 118000, text: 'Prompt engineering is just programming with extra steps and worse error messages.' },
  { authorHandle: '@DBA老陈', topic: 'AI Coding', language: 'zh', ageHours: 61, likes: 431, reposts: 58, replies: 47, views: null, text: '用 AI 生成 SQL 迁移脚本一时爽，生产环境回滚火葬场，血的教训。' },
  { authorHandle: '@rubber_duck', topic: 'AI Coding', language: 'en', ageHours: 70, likes: 1204, reposts: 156, replies: 74, views: 52000, text: 'My favorite new debugging technique: explain the bug to the AI, realize the answer mid-sentence, close the tab.' },

  // ---- 前端开发 ----
  { authorHandle: '@frontend_daily', topic: '前端开发', language: 'zh', ageHours: 2, likes: 3245, reposts: 512, replies: 289, views: 145000, text: 'React Server Components 用了半年，最大的感受是：心智负担没少，只是转移了。' },
  { authorHandle: '@css_wizardry', topic: '前端开发', language: 'en', ageHours: 8, likes: 1980, reposts: 302, replies: 141, views: 87000, text: 'CSS finally has :has() everywhere and I feel like I time-traveled from 2015.' },
  { authorHandle: '@组件拆分师', topic: '前端开发', language: 'zh', ageHours: 14, likes: 1102, reposts: 134, replies: 76, views: 46000, text: '把 2000 行的巨型组件拆成 20 个小组件，AI 一次就拆对了，注释还写得比我好。' },
  { authorHandle: '@framework_fatigue', topic: '前端开发', language: 'en', ageHours: 20, likes: 2760, reposts: 488, replies: 312, views: 121000, text: 'The number of JS frameworks is now officially larger than the number of JS developers.' },
  { authorHandle: '@性能优化君', topic: '前端开发', language: 'zh', ageHours: 30, likes: 1567, reposts: 243, replies: 118, views: 68000, text: '性能优化实战：首屏从 4.2s 压到 1.1s，靠的不是新框架，是删代码。' },
  { authorHandle: '@tailwind_tom', topic: '前端开发', language: 'en', ageHours: 38, likes: 890, reposts: 97, replies: 203, views: 39000, text: 'Tailwind vs vanilla CSS debates are the new vim vs emacs. I am tired.' },
  { authorHandle: '@设计稿杀手', topic: '前端开发', language: 'zh', ageHours: 47, likes: 743, reposts: 86, replies: 59, views: 31000, text: "用 AI 把 Figma 设计稿转成代码，还原度 90%，剩下 10% 是设计师的'感觉不对'。" },
  { authorHandle: '@strict_ts', topic: '前端开发', language: 'en', ageHours: 55, likes: 2130, reposts: 318, replies: 167, views: 94000, text: 'TypeScript strict mode: where your code finally admits it has trust issues.' },
  { authorHandle: '@微前端受害者', topic: '前端开发', language: 'zh', ageHours: 63, likes: 512, reposts: 61, replies: 84, views: null, text: '微前端踩坑一年总结：拆容易，合难，样式隔离是玄学。' },
  { authorHandle: '@ship_it', topic: '前端开发', language: 'en', ageHours: 71, likes: 1340, reposts: 178, replies: 92, views: 58000, text: "I don't always test my code, but when I do, it's in production." },

  // ---- 创业 ----
  { authorHandle: '@独立开发老周', topic: '创业', language: 'zh', ageHours: 5, likes: 5210, reposts: 934, replies: 487, views: 230000, text: '独立开发第 200 天，MRR 终于破 5000 美元，秘诀：少做功能，多回邮件。' },
  { authorHandle: '@pivot_pete', topic: '创业', language: 'en', ageHours: 11, likes: 1875, reposts: 264, replies: 149, views: 82000, text: 'We pivoted 4 times in 18 months. The 5th idea — the boring one — is what worked.' },
  { authorHandle: '@BP修改器', topic: '创业', language: 'zh', ageHours: 18, likes: 2340, reposts: 387, replies: 196, views: 105000, text: '融资 BP 写了 30 版，投资人只看了第一页：收入曲线。' },
  { authorHandle: '@ten_customers', topic: '创业', language: 'en', ageHours: 26, likes: 3120, reposts: 542, replies: 203, views: 138000, text: "Your startup doesn't need a better landing page. It needs 10 customers who'd riot if you shut down." },
  { authorHandle: '@精益小分队', topic: '创业', language: 'zh', ageHours: 33, likes: 1089, reposts: 156, replies: 134, views: 47000, text: '裁员一半后，效率反而提升了：开会的人少了，干活的人多了。' },
  { authorHandle: '@growth_greta', topic: '创业', language: 'en', ageHours: 41, likes: 2460, reposts: 398, replies: 187, views: 109000, text: 'The best growth hack is a product people actually want. Revolutionary, I know.' },
  { authorHandle: '@出海捕鱼人', topic: '创业', language: 'zh', ageHours: 50, likes: 876, reposts: 102, replies: 67, views: 36000, text: '出海第一年：时差是最便宜的客服外包。' },
  { authorHandle: '@burn_rate', topic: '创业', language: 'en', ageHours: 58, likes: 1930, reposts: 287, replies: 241, views: 86000, text: 'Raised $2M, burned it in 14 months, learned more than my MBA. 0/10 would not recommend the tuition.' },
  { authorHandle: '@冷启动日记', topic: '创业', language: 'zh', ageHours: 66, likes: 654, reposts: 78, replies: 52, views: null, text: '冷启动的真相：前 100 个用户都是 founder 一个个私聊来的。' },
  { authorHandle: '@profit_first', topic: '创业', language: 'en', ageHours: 72, likes: 2870, reposts: 461, replies: 178, views: 126000, text: 'Profitability is a feature. Ship it.' },

  // ---- 生产力工具 ----
  { authorHandle: '@效率手册', topic: '生产力工具', language: 'zh', ageHours: 4, likes: 1980, reposts: 342, replies: 267, views: 89000, text: 'Notion 用了 3 年，我的结论：模板收藏夹比知识库大 10 倍。' },
  { authorHandle: '@analog_amy', topic: '生产力工具', language: 'en', ageHours: 10, likes: 3240, reposts: 512, replies: 298, views: 142000, text: 'I tried 12 to-do apps this year. The winner was a paper notebook.' },
  { authorHandle: '@双链信徒', topic: '生产力工具', language: 'zh', ageHours: 17, likes: 1120, reposts: 148, replies: 189, views: 48000, text: 'Obsidian 双链的真相：链接建得越多，回顾得越少。' },
  { authorHandle: '@system_stacker', topic: '生产力工具', language: 'en', ageHours: 24, likes: 1560, reposts: 203, replies: 134, views: 67000, text: 'My productivity system has a productivity system. Send help.' },
  { authorHandle: '@会议纪要AI', topic: '生产力工具', language: 'zh', ageHours: 32, likes: 2340, reposts: 389, replies: 156, views: 103000, text: '用 AI 做会议纪要，准确率 95%，剩下 5% 是老板的画外音。' },
  { authorHandle: '@inbox_infinity', topic: '生产力工具', language: 'en', ageHours: 40, likes: 1890, reposts: 276, replies: 203, views: 84000, text: 'Inbox zero is a myth perpetuated by people with assistants.' },
  { authorHandle: '@番茄钟选手', topic: '生产力工具', language: 'zh', ageHours: 49, likes: 765, reposts: 89, replies: 112, views: 33000, text: '番茄钟坚持 100 天：专注力没涨，但学会了跟愧疚感和解。' },
  { authorHandle: '@open_tab_tess', topic: '生产力工具', language: 'en', ageHours: 57, likes: 1430, reposts: 187, replies: 98, views: 61000, text: 'The best note-taking app is the one you actually open.' },
  { authorHandle: '@划线收藏家', topic: '生产力工具', language: 'zh', ageHours: 64, likes: 432, reposts: 51, replies: 43, views: null, text: '把微信读书的划线同步到 flomo，一年攒了 2000 条，复习了 0 条。' },
  { authorHandle: '@automate_anna', topic: '生产力工具', language: 'en', ageHours: 69, likes: 2180, reposts: 334, replies: 176, views: 96000, text: 'Automation paradox: I spent 6 hours automating a 5-minute task.' },

  // ---- 设计 ----
  { authorHandle: '@design_lab', topic: '设计', language: 'zh', ageHours: 6, likes: 2870, reposts: 456, replies: 234, views: 128000, text: 'AI 生成 UI 的一年观察：快，但所有产品开始长得一样。' },
  { authorHandle: '@whitespace_will', topic: '设计', language: 'en', ageHours: 13, likes: 1760, reposts: 243, replies: 121, views: 78000, text: "Whitespace is not empty space. It's the most expensive real estate on your screen." },
  { authorHandle: '@组件库守墓人', topic: '设计', language: 'zh', ageHours: 21, likes: 1340, reposts: 178, replies: 167, views: 59000, text: '设计系统做了 200 个组件，业务方只用 20 个，剩下的在吃灰。' },
  { authorHandle: '@button_betty', topic: '设计', language: 'en', ageHours: 29, likes: 2090, reposts: 312, replies: 145, views: 92000, text: "Your users don't care about your 8pt grid. They care that the button works." },
  { authorHandle: '@暗色模式研究员', topic: '设计', language: 'zh', ageHours: 37, likes: 987, reposts: 123, replies: 89, views: 42000, text: '暗色模式不是把背景涂黑：对比度、层级、品牌色都要重做。' },
  { authorHandle: '@convert_carl', topic: '设计', language: 'en', ageHours: 45, likes: 1650, reposts: 234, replies: 112, views: 73000, text: 'Good design is invisible. Great design is invisible and converts.' },
  { authorHandle: '@AI插画学徒', topic: '设计', language: 'zh', ageHours: 54, likes: 743, reposts: 87, replies: 76, views: 32000, text: '跟 AI 协作做插画：出图 100 张，能用的 3 张，改稿依然靠手。' },
  { authorHandle: '@scroll_sam', topic: '设计', language: 'en', ageHours: 62, likes: 1280, reposts: 165, replies: 87, views: 56000, text: 'The fold is dead. Long live the scroll.' },
  { authorHandle: '@B端设计民工', topic: '设计', language: 'zh', ageHours: 68, likes: 521, reposts: 64, replies: 98, views: null, text: 'B 端设计的真相：信息密度才是第一生产力。' },
  { authorHandle: '@a11y_alex', topic: '设计', language: 'en', ageHours: 72, likes: 1940, reposts: 287, replies: 134, views: 85000, text: "Accessibility isn't a feature. It's the baseline we keep forgetting." },
];

/**
 * 写入种子数据。posts 表已有数据时直接跳过（重启不重复）。
 * @returns 实际插入的条数（0 表示已存在，跳过）。
 */
export function seedIfEmpty(db: Db): number {
  const count = queryValue<number>(db, 'SELECT COUNT(*) AS c FROM posts');
  if (count > 0) return 0;

  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO posts
      (source, sourcePostId, authorHandle, text, url, topic, publishedAt, language,
       likes, reposts, replies, views, metricsCapturedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // node:sqlite 没有 db.transaction() helper，手动管理事务。
  db.exec('BEGIN');
  try {
    for (const p of POSTS) {
      const publishedAt = now - Math.round(p.ageHours * 3_600_000);
      insert.run(
        'mock',
        null,
        p.authorHandle,
        p.text,
        '#',
        p.topic,
        publishedAt,
        p.language,
        p.likes,
        p.reposts,
        p.replies,
        p.views,
        now,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return POSTS.length;
}
