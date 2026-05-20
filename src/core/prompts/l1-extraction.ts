/**
 * L1 Extraction Prompt: 情境切分 + 记忆提取
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `你是专业的"情境切分与记忆提取专家"。
你的任务是分析用户的对话，判断情境切换，并从中提取结构化的核心记忆（仅限 persona, episodic, instruction 三类）。

### 任务一：情境切分（Scene Segmentation）
分析【待提取的新消息】，结合【上一个情境】，判断并输出当前对话的情境。
- 继承：无明显切换，沿用上一个情境。
- 切换条件：用户发出明确指令（如"换话题"）、意图转变、或提出独立新目标。
- 一段对话可能只有一个情境，也可能有多个情境（话题多次切换时）。
- 命名规则："我（AI）在和xxx（用户身份）做xxx（目标活动）"（中文，30-50字，单句，全局唯一）。

---

### 任务二：核心记忆提取（Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心信息。

【通用提取原则】
1. 宁缺毋滥：过滤琐碎闲聊、临时性指令和一次性操作（如"这次、本单"）；剔除不可靠的边缘信息。
2. 独立完整：记忆必须"跳出当前对话依然成立"，无上下文也能看懂。提取主体必须以"用户（姓名）"或"AI"为核心。
3. 归纳合并：强关联或因果关系的多条消息，必须合并为一条完整记忆，不可碎片化。

【支持提取的三大类型】（必须严格遵守类型规则）

1. 个性化记忆 (type: "persona")
   - 定义：用户的稳定属性、偏好、技能、价值观、习惯（如住所、职业、饮食禁忌）。
   - 提取句式："用户（[姓名]）喜欢/是/擅长..."
   - 打分 (priority)：80-100（健康/禁忌/核心特质）；50-70（一般喜好/技能）；<50（模糊次要，可丢弃）。
   - 触发词：喜欢、习惯、经常、我这个人...

2. 客观事件记忆 (type: "episodic")
   - 定义：客观发生的动作、决定、计划或达成结果。绝不包含纯主观感受。
   - 对 AI 编程、研究、文档、爬虫、数据、服务器、插件等工作流，以下内容即使只属于某个项目，也应提取为 episodic：明确交付物、验收标准、关键路径、真实文件路径/仓库路径、数据产物、运行环境、已确认的 blocker、root cause、修复决定、复现结论、用户纠正过的技术假设、已完成/未完成状态。
   - 提取句式："用户（[姓名]）在 [最好是精确绝对时间] 于 [地点] [做了某事（可以包含起因、经过、结果）]"。
   - 时间约束：尽量基于消息的 timestamp 推算绝对时间，如能确定则在 metadata 中输出 activity_start_time 和 activity_end_time（ISO 8601格式）。无法确定时可省略。
   - 打分 (priority)：80-100（重要事件/计划）；60-70（一般完整活动）；<60（琐碎事项，直接丢弃）。

3. 全局指令记忆 (type: "instruction")
   - 定义：用户对 AI 提出的长期行为规则、格式偏好、语气控制。
   - 如果用户在项目工作流中定义了可复用的执行规则（例如必须直接修改源文件、交付物是最终数据而不是代码、必须实时监控 ETA、不要在 HPC 登录节点跑重活、先验证路径/依赖/代理可达性），即使它来自某个历史任务，也应提取为 instruction，除非文本明确限定为"只限这一次"。
   - 提取句式："用户要求/希望 AI 以后回答时..."
   - 触发词：以后都、从现在开始、记住、必须。
   - 打分 (priority)：-1（极其严格的全局死命令）；90-100（核心行为规则）；70-80（重要要求）；<70（临时要求，直接丢弃）。

---

### 不应该提取的内容
- 琐碎闲聊、问候；临时性的纯工具性请求（如"这次帮我翻译一下"）
- 一次性操作指令（如"这次、本单"相关）
- 重复的内容；AI助手自身的行为或输出
- 不属于以上3类的信息
- 纯主观感受（不带客观事件的情绪表达）
- 不要因为内容是项目级、工作流级、agent 执行级而丢弃；只要未来继续该项目、复现 bug、查找产物或理解用户偏好时有帮助，就应保留。

---

### 任务三：输出格式规范（JSON）
返回且仅返回一个合法的 JSON 数组。第一个字符必须是 "["，最后一个字符必须是 "]"。
禁止输出分析过程、标题、Markdown、自然语言解释、工具调用意图或任何 JSON 外文本。
数组的每一项是一个情境，包含该情境的消息范围和抽取到的记忆：

[
  {
    "scene_name": "当前生成或继承的情境名称",
    "message_ids": ["属于该情境的消息ID列表"],
    "memories": [
      {
        "content": "完整、独立的记忆陈述（按对应类型的句式要求）",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["消息ID_1", "消息ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata 字段说明：
- episodic 类型：如能确定活动时间，填入 {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- 其他类型或无法确定时间：输出空对象 {}

如果整段对话无有意义的记忆，也要输出情境分割结果，memories 为空数组：
[
  {
    "scene_name": "情境名称",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符（如 \`\`\`json）或解释文本。`;

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "无" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "无";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `只返回 JSON 数组。不要写分析、标题、说明或 Markdown。

【上一个情境】：${previousSceneName}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：
${newText}`;
}
