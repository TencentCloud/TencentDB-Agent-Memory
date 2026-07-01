/**
 * Mock 数据工厂 — 为所有 E2E 测试提供确定性、可复现的测试数据。
 *
 * 使用 mulberry32 PRNG 确保所有随机数据可重放。
 */

// ============================
// 确定性 PRNG
// ============================

/** mulberry32 — 确定性伪随机数生成器 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================
// 对话数据生成
// ============================

const USER_TEMPLATES = [
  "你好，我想了解一下{movie}这部电影",
  "请帮我写一个{language}的{function}函数",
  "今天天气怎么样？我在{city}",
  "你能解释一下{algorithm}算法的工作原理吗？",
  "帮我总结一下这篇关于{topic}的文章",
  "我最近在学习{skill}，有什么建议吗？",
  "如何用{framework}搭建一个{appType}？",
  "请将以下文本翻译成{language}：{text}",
  "写一首关于{subject}的诗",
  "帮我调试这段代码：{code}",
  "推荐几本关于{topic}的书",
  "什么是{concept}？请用简单的话解释",
  "帮我设计一个{system}的系统架构",
  "今天{date}有什么重要的{topic}新闻吗？",
  "给我讲个关于{character}的笑话",
];

const ASSISTANT_TEMPLATES = [
  "好的，让我来介绍一下{movie}这部电影。这是一部{class}类型的电影……",
  "以下是{language}版本的{function}函数实现：\n```{language}\nfunction {function}(...) {\n  // 实现代码\n}\n```",
  "根据天气数据，{city}今天的气温是{temp}°C，天气{condition}。",
  "{algorithm}算法的核心思想是{idea}。它的时间复杂度是{complexity}。",
  "这篇关于{topic}的文章主要讨论了以下几个要点：1) {point1} 2) {point2} 3) {point3}",
  "学习{skill}的建议：首先掌握{prerequisite}，然后通过{method}来练习。",
  "用{framework}搭建{appType}的步骤：\n1. 初始化项目\n2. 配置路由\n3. 创建组件",
  "翻译结果：{translated}",
  "好的，以下是一首关于{subject}的诗：\n{poem}",
  "我发现了问题：{fix}。修改后的代码：\n```\n{fixedCode}\n```",
  "推荐以下关于{topic}的书籍：\n1. 《{book1}》— {desc1}\n2. 《{book2}》— {desc2}",
  "{concept}简单来说就是{simple}。举个例子：{example}。",
  "系统架构设计如下：\n- 前端：{frontend}\n- 后端：{backend}\n- 数据库：{database}",
  "今天{topic}领域的最新动态：{news}",
  "哈哈，关于{character}的笑话：\n{setup}\n{punchline}",
];

const FILL_VALUES: Record<string, string[]> = {
  movie: ["Inception", "The Matrix", "Parasite", "Spirited Away", "Interstellar"],
  city: ["北京", "上海", "Tokyo", "New York", "London"],
  language: ["Python", "TypeScript", "Go", "Rust", "Java"],
  function: ["sort", "fetchData", "validate", "transform", "calculate"],
  algorithm: ["二分查找", "快速排序", "Dijkstra", "KMP", "A*"],
  topic: ["AI", "Blockchain", "Quantum Computing", "Climate Change", "Neuroscience"],
  skill: ["Rust", "Machine Learning", "Kubernetes", "React", "System Design"],
  framework: ["Next.js", "FastAPI", "Gin", "Axum", "Spring Boot"],
  appType: ["博客", "电商后台", "API网关", "聊天应用", "数据分析平台"],
  system: ["分布式缓存", "消息队列", "微服务", "推荐引擎", "日志收集"],
  concept: ["闭包", "多态", "CAP定理", "事件循环", "梯度下降"],
  subject: ["春天", "代码", "未来", "星空", "猫"],
  character: ["程序员", "产品经理", "QA工程师", "DBA", "SRE"],
};

function fill(template: string, rand: () => number): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const values = FILL_VALUES[key];
    if (values) return values[Math.floor(rand() * values.length)];
    // 随机生成
    if (key === "temp") return String(Math.floor(rand() * 40) - 5);
    if (key === "condition") return ["晴", "多云", "小雨", "阴"][Math.floor(rand() * 4)];
    if (key === "complexity") return ["O(n)", "O(n log n)", "O(n²)", "O(log n)"][Math.floor(rand() * 4)];
    if (key === "date") return `2026-07-${String(Math.floor(rand() * 30) + 1).padStart(2, "0")}`;
    if (key === "class") return ["科幻", "悬疑", "剧情", "动画"][Math.floor(rand() * 4)];
    if (key === "idea") return ["分治", "贪心", "动态规划", "回溯"][Math.floor(rand() * 4)];
    if (key === "prerequisite") return ["基础语法", "数据结构", "算法基础", "操作系统"][Math.floor(rand() * 4)];
    if (key === "method") return ["做项目", "刷题", "读源码", "写博客"][Math.floor(rand() * 4)];
    if (key === "frontend") return ["React", "Vue", "Svelte", "Angular"][Math.floor(rand() * 4)];
    if (key === "backend") return ["Node.js", "Go", "Python", "Rust"][Math.floor(rand() * 4)];
    if (key === "database") return ["PostgreSQL", "MongoDB", "Redis", "MySQL"][Math.floor(rand() * 4)];
    return `[${key}]`;
  });
}

/** 生成随机对话轮次 */
export function generateConversationTurns(
  count: number,
  seed = 42,
): Array<{ user: string; assistant: string; sessionKey: string }> {
  const rand = mulberry32(seed);
  const turns: Array<{ user: string; assistant: string; sessionKey: string }> = [];

  for (let i = 0; i < count; i++) {
    const userTemplate = USER_TEMPLATES[Math.floor(rand() * USER_TEMPLATES.length)];
    const assistantTemplate = ASSISTANT_TEMPLATES[Math.floor(rand() * ASSISTANT_TEMPLATES.length)];

    turns.push({
      user: fill(userTemplate, rand),
      assistant: fill(assistantTemplate, rand),
      sessionKey: `sess-${Math.floor(rand() * 10)}`,
    });
  }

  return turns;
}

/** 生成随机记忆条目 */
export function generateMemoryEntries(
  count: number,
  seed = 42,
): Array<{ content: string; type: string; scene: string }> {
  const rand = mulberry32(seed);
  const types = ["episodic", "instruction", "persona"];
  const scenes = ["工作", "学习", "娱乐", "健康", "社交"];
  const entries: Array<{ content: string; type: string; scene: string }> = [];

  for (let i = 0; i < count; i++) {
    entries.push({
      content: `记忆条目 #${i}: ${fill(USER_TEMPLATES[Math.floor(rand() * USER_TEMPLATES.length)], rand)}`,
      type: types[Math.floor(rand() * types.length)],
      scene: scenes[Math.floor(rand() * scenes.length)],
    });
  }

  return entries;
}

/** 生成随机会话键 */
export function generateSessionKeys(count: number, seed = 42): string[] {
  const rand = mulberry32(seed);
  const keys = new Set<string>();

  while (keys.size < count) {
    const id = Math.floor(rand() * 100000).toString(36);
    keys.add(`session-${id}-${Math.floor(rand() * 1000)}`);
  }

  return Array.from(keys);
}

// ============================
// 多语言测试数据
// ============================

export const MULTILINGUAL_DATA = [
  { lang: "中文", text: "你好世界！今天天气真好啊。" },
  { lang: "日本語", text: "こんにちは世界！今日の天気はとてもいいですね。" },
  { lang: "한국어", text: "안녕하세요 세계! 오늘 날씨가 정말 좋네요." },
  { lang: "العربية", text: "مرحبا بالعالم! الطقس جميل اليوم." },
  { lang: "Русский", text: "Привет мир! Сегодня такая хорошая погода." },
  { lang: "हिन्दी", text: "नमस्ते दुनिया! आज मौसम बहुत अच्छा है।" },
  { lang: "Emoji", text: "Hello 🌍! Weather today ☀️🌈 — great for a 🚶‍♂️ in the 🌳!" },
  { lang: "Mixed", text: "我在Tokyo塔🗼看夜景🌃，吃了すし🍣，très bien! 👍" },
  { lang: "RTL", text: "שלום עולם! מזג האוויר היום מקסים." },
  { lang: "Code", text: "```typescript\nconst hello = (name: string): string => `你好 ${name}! 🌍`;\n```" },
];

// ============================
// 边缘 payload
// ============================

export const EDGE_PAYLOADS = [
  { name: "空字符串", payload: "" },
  { name: "单个空格", payload: " " },
  { name: "换行符", payload: "\n" },
  { name: "Tab 字符", payload: "\t" },
  { name: "Null 字节", payload: "hello\0world" },
  { name: "控制字符", payload: "\x00\x01\x02\x03\x1f" },
  { name: "超长 ASCII", payload: "A".repeat(100000) },
  { name: "超长中文", payload: "测试".repeat(50000) },
  { name: "JSON 嵌套", payload: JSON.stringify({ a: { b: { c: { d: { e: "deep" } } } } }) },
  { name: "Unicode 代理对", payload: "😀 👍" },
  { name: "HTML 标签", payload: "<script>alert('xss')</script>" },
  { name: "SQL 注入", payload: "'; DROP TABLE users; --" },
  { name: "Markdown", payload: "## 标题\n**粗体**\n`代码`\n[链接](url)" },
  { name: "Math", payload: "∫₀ⁿ x² dx = n³/3" },
  { name: "空 JSON 对象", payload: "{}" },
];
