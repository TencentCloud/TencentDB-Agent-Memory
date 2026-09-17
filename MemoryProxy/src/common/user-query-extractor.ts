/**
 * User query extractor —— 从 CC / CodeBuddy / 其他 coding agent 的 user
 * message content 里剥掉一切 harness 上下文，只保留"用户真正键入的文本"。
 *
 * 使用场景（proxy 内三处共用）：
 *   1. tdai/recorder.ts::extractLatestUserMessage —— L0 写入
 *   2. agent-adapters/codebuddy.ts::extractUserText —— mem 命令 parser +
 *      normalize-conversation 抽 skill buffer 干净文本
 *   3. mem-command 通过 adapter.extractUserText 间接调用
 *
 * 抽取语义（按优先级排列）：
 *
 *   0) CC 客户端内部 prompt / tool_result 伪装 / session-init 回执，
 *      以及 DSH 纯文本 `Current runtime context.` 快照 → 整条丢弃，返回 ""，
 *      调用方据此决定本轮不写 L0 / 不进 skill buffer
 *
 *   1) 显式 `<user_query>...</user_query>` 块（CodeBuddy 标准 + CC 部分模板）
 *      → 只提取块内 join，即便同条消息同时含 session-init 表单也不受影响
 *
 *   2) 无 user_query 时按顺序剥离：
 *      - `<question_answer>...</question_answer>` （session-init 表单回填）
 *      - 常见 XML wrapper（system-reminder / additional_data / user_info /
 *        open_and_recently_viewed_files / session / persisted-output /
 *        tool_use_error / tool_result 等）
 *      - 单行 tool 回显（Bash 完成 / Read 的 cat -n 格式 / Write 成功回执）
 *      - MEMORY.md 风格 yaml frontmatter 块
 *      - 「会话初始化 — ...」标题残留行
 *      → 剥离完剩下什么就是用户键入
 *
 * 迁移历史：本文件由 tdai/recorder.ts 抽离而来（原为 tdai 私有），语义未变。
 * 见 docs/design/2026-07-30-cc-request-routing-plan.md 附录 + codebuddy adapter
 * 抓包结论。
 */

/**
 * 会话初始化（选择 Team / Agent / 任务）表单问答的标题标记。
 * 用于剥离残留的标题行；真实用户输入不受影响。
 */
const SESSION_INIT_TITLE_MARKER = "会话初始化";

/**
 * Claude Code CLI 用 role=user 塞进对话流的"内部辅助 prompt"识别器。
 *
 * 场景：CC 客户端会用 role=user 承载多种**非用户真实输入**的内容，如果整条命中
 * 任一模式，直接判定为"非人类输入" → 该轮不写 L0，避免污染记忆库。
 *
 * 命中规则设计：
 *   - 全消息**开头**出现明显 CC 模式标记（[SUGGESTION MODE]、[TITLE MODE] 等）；
 *   - 或 CC 结构化元数据 JSON（{"parentUuid": ..., "promptId": ...}）；
 *   - 或系统级 recap/summary prompt（"The user stepped away and is coming back..."）；
 *   - 或 session-init AskUserQuestion 的回执（"Your questions have been answered:"）；
 *   - 或 tool 输出被伪装成 user 的典型格式（"(Bash completed with no output)"、
 *     `<persisted-output>` 大文件占位、CC 时间戳日志块）。
 *
 * 匹配用 startsWith / 全串锚定 —— 不误伤真实用户输入。
 */
const CC_INTERNAL_PROMPT_PATTERNS: RegExp[] = [
  // CC 模式标记：[XXX MODE: ...] / [XXX: ...]
  /^\s*\[(?:SUGGESTION|TITLE|SUMMARY|COMPACT|COMPACTION|ANALYSIS|EVAL|RECAP|MEMORY|SIDECHAIN)\s+MODE[:\s]/i,
  // CC 会话恢复 prompt（在 core prompts/session-resume 里定义）
  /^\s*The user stepped away and is coming back\.\s*Recap/i,
  // AskUserQuestion 回执（session-init 或运行时问答）
  /^\s*Your questions have been answered:\s*"/i,
  // CC 结构化 promptId 元数据 JSON（首字符是数字 + JSON 或直接 JSON 元信息）
  /^\s*\d+\s*\{"parentUuid"|^\s*\{"parentUuid":\s*"[^"]+","isSidechain"/,
  // CC 用时间戳前缀重放对话日志（[2026-07-11T...][user] / [assistant]）
  /^\s*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\]]*\]\[(?:user|assistant|system)\]/,
  // 注：<persisted-output> / (Bash completed with no output) 移到 2b/2c 的
  //     wrapper 剥离层处理 —— 它们经常和用户下一句拼在同一条 user 消息里，
  //     只应剥除自身、保留用户后续输入。
];

function isClaudeCodeInternalPrompt(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return CC_INTERNAL_PROMPT_PATTERNS.some((re) => re.test(t));
}

/**
 * DSH 把运行环境快照作为独立 `role=user` 消息追加在真实提问之后。
 * 固定开头，与 session-init 跳过逻辑同一锚点，避免 L0 把 harness 元数据
 * 当成用户输入。真实用户提问不会以这段英文开头。
 */
export const DSH_RUNTIME_CONTEXT_PREFIX = "Current runtime context.";

export function isDshRuntimeContextSnapshot(text: string): boolean {
  return text.trimStart().startsWith(DSH_RUNTIME_CONTEXT_PREFIX);
}

/**
 * 从原始 user content 文本抽取用户真实键入。
 *
 * 返回空字符串意味着"这条 user message 全是 harness 噪声"，调用方应据此
 * 决定不写 L0 / 不进 skill buffer / 不匹配 mem 命令。
 *
 * 参数 `raw` 必须已是**字符串**（数组 content 由调用方自行 join —— 参见
 * agent-adapters 各自的 extractUserText 实现）。
 */
export function extractUserQueryText(raw: string): string {
  // 0) CC 内部 prompt / tool_result 伪装 / 表单回执 → 整条丢弃（不写 L0）
  //    这是最高优先级：即便同时含 <user_query> 也整条判定为非人类输入。
  //    真实用户输入不会命中这些锚定在开头/整串的模式。
  if (isClaudeCodeInternalPrompt(raw)) return "";
  // DSH runtime-context 快照：纯文本、无 XML wrapper，必须整条丢弃，
  // 否则 extractLatestUserMessage 从后往前扫会把它当成真实提问写入 L0。
  if (isDshRuntimeContextSnapshot(raw)) return "";

  // 1) 优先：显式 <user_query> 块（即便同一条消息里还夹着 session-init 问答，
  //    也只取真实 query，用户输入完整保留）。
  const queries: string[] = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1].trim();
    if (inner) queries.push(inner);
  }
  if (queries.length > 0) return queries.join("\n\n");

  // 2) 没有显式 user_query：剥离所有"非用户键入"的内容片段，保留剩余的
  //    用户真实输入。核心原则：只有用户手打的文本值得写 L0；一切 tool 回显
  //    / 系统提醒 / 文件正文 / 表单工件 / CC 本地 memory 内容 —— 全部剥除。
  let text = raw;

  // 2a) session-init 表单回答 <question_answer>...</question_answer>
  text = text.replace(/<question_answer[^>]*>[\s\S]*?<\/question_answer>/gi, "");

  // 2b) XML 包裹类：CC / CodeBuddy 塞进 user role 的各种 harness 段
  //     - system-reminder / system_reminder（两种拼写都覆盖）
  //     - additional_data（CB 每条 user 首段都夹这个：current_time 等）
  //     - user_info（CB 首条 user 塞的 OS/shell/workspace 元信息）
  //     - open_and_recently_viewed_files
  //     - session（proxy 自己注入的 session context 包裹）
  //     - persisted-output（CC "Output too large" 大文件占位）
  //     - tool_use_error / tool-use-error / tool-result / tool_result（伪 wrapper）
  for (const tag of [
    "system-reminder", "system_reminder",
    "additional_data",
    "user_info",
    "open_and_recently_viewed_files",
    "session",
    "persisted-output", "persisted_output",
    "tool_use_error", "tool-use-error",
    "tool_result", "tool-result",
  ]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // 2c) 行级过滤：单行匹配的 tool 回显 / 文件片段 / memory frontmatter
  //     每条规则单行判定，匹配则删除该行；不阻断其它行的用户输入。
  const LINE_DROP_PATTERNS: RegExp[] = [
    // CC Write/Edit tool 成功回执
    /^\s*The file .+ has been (updated|created) successfully.*$/i,
    /^\s*File created successfully at:/i,
    // CC Bash tool 静默完成
    /^\s*\(Bash completed with no output\)\s*$/,
    // CC read tool 返回的 cat -n 行号格式（"     1  内容" / "1  内容"）
    // 至少 3 位数字更严格；1-2 位可能与用户输入冲突（如用户列表 "1 abc"）
    // 因此这里只匹配"数字 + 2 空格 + 内容"且行首无其它字符 —— cat -n 特有格式
    /^\s{0,6}\d+\t/,   // cat -n 用 tab 分隔（Read tool 的标准格式）
    // MEMORY.md 相关：CC session_init/memory 命令产生的输出
    /^\s*File .+ has been (updated|created)/i,
  ];
  text = text
    .split("\n")
    .filter((line) => !LINE_DROP_PATTERNS.some((re) => re.test(line)))
    .join("\n");

  // 2d) 整块剥除：MEMORY.md yaml frontmatter（--- 到 ---，含 metadata）
  //     格式：
  //       ---
  //       name: ...
  //       description: ...
  //       metadata: ...
  //       ---
  //     只匹配"至少含 name / description / metadata / node_type 关键字"的 frontmatter
  //     以避免误伤 markdown 分割线。
  text = text.replace(
    /(?:^|\n)---\s*\n(?:[a-z_][a-z0-9_]*:\s*.*\n)*?(?:name|description|metadata|node_type|originSessionId):[\s\S]*?\n---\s*(?:\n|$)/gi,
    "\n",
  );

  // 2e) 残留的会话初始化表单标题行（如「会话初始化 — 选择 Agent 与任务」）
  text = text
    .split("\n")
    .filter((line) => !line.includes(SESSION_INIT_TITLE_MARKER))
    .join("\n");

  // 2f) 折叠多余空行（前面剥除后可能留下大段空行）
  text = text.replace(/\n{3,}/g, "\n\n");

  // 剩余即用户真实输入；若整条本就全是 CC 工件，这里会自然变空 → 不写 L0。
  return text.trim();
}
