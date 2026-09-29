/**
 * 合成体注入结果的抽取与贴回（Responses 客户端专用）。
 *
 * 背景：codex / workbuddy handler 走的是「构造一个 OpenAI Chat 形状的合成体 →
 * 交给通用 InjectionPipeline → 把注入结果贴回真正的 Responses 请求」这条路。
 * 历史实现只抽 `messages[0]`（system），因此任何 `user.*` 注入点（如 L1 召回
 * `tdai-l1-recall-injector` 的 `point="user.before"`）会落在合成体的占位 user
 * 消息上并被**静默丢弃** —— 请求照样 200，只是记忆没了。
 *
 * 本模块把这件事收敛成两个纯函数：
 *   - `splitSyntheticInjection`：按 role 抽出 system 段与 user 段的注入增量；
 *   - `prependToLastUserMessage`：把 user 段增量贴回 Responses 请求里最后一个
 *     user message 的 content 头部（= `user.before` 的语义位置）。
 *
 * 两个函数都不抛错：形态不符时原样返回，调用方保持「注入失败不破坏请求」的既有
 * 降级姿势。
 */

/** 取 body.messages（非数组时返回空数组）。 */
function messageList(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body.messages;
  return Array.isArray(messages) ? (messages as Array<Record<string, unknown>>) : [];
}

/** 取一条消息的纯文本 content（content-block 数组形态不参与增量计算）。 */
function textOf(message: Record<string, unknown> | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/**
 * 增量 = 注入后的文本去掉我们预先写进合成体的原始文本。
 *
 * 注入器既可能在用户文本**之前**插入（`user.before`），也可能追加在后
 * （`user.after`），因此前后缀各判一次；两者都不匹配时保守返回注入后的全文
 * ——宁可多贴一段，也不静默丢记忆。
 */
function delta(before: string, after: string): string {
  if (before.length === 0) return after;
  if (after.startsWith(before)) return after.slice(before.length);
  if (after.endsWith(before)) return after.slice(0, after.length - before.length);
  return after;
}

/**
 * 抽出合成体的注入结果。
 *
 * 只吃「注入后的 messages 数组」而不是整个 body：handler 里那个变量
 * （`injectedMessages`）在 Opik 等并行分支上由不同的表达式赋值，但名字与类型一致，
 * 因此这样取可以让本函数的调用点只做**纯新增**，不与并行分支的改动抢同一行。
 *
 * @param original      跑管线**之前**的合成体（含预填的 session_context 与占位 user 文本）
 * @param injectedMessages 跑管线**之后**的 `messages` 数组
 * @returns `systemText`：system 段全文（含预填内容，直接贴 developer message）；
 *          `userText`：user 段**增量**（不含占位符，可直接贴最后一个 user message）
 */
export function splitSyntheticInjection(
  original: Record<string, unknown>,
  injectedMessages: Array<Record<string, unknown>> | undefined,
): { systemText: string; userText: string } {
  const before = messageList(original);
  const after = Array.isArray(injectedMessages) ? injectedMessages : [];
  return {
    systemText: textOf(after[0]),
    userText: delta(textOf(before[1]), textOf(after[1])).trim(),
  };
}

/**
 * 把注入块前插到 Responses 请求里**最后一个** user message 的 content 头部。
 *
 * 为什么取「最后一个」：多轮对话里最后一条 user message 才是本轮提问，
 * `user.before` 的语义就是「紧跟在本轮提问之前」，所以贴在那里既符合注入点
 * 语义，也不会因为落在 developer 段而与 system 注入互相污染。
 *
 * 防御性 short-circuit（均返回原 body，不抛错、不改原对象）：
 *   - `input` 不是数组或为空；
 *   - 找不到 `type=message && role=user && content 为数组` 的条目
 *     （客户端非首帧时尾部可能是 function_call_output / function_call）。
 */
export function prependToLastUserMessage(
  body: Record<string, unknown>,
  block: unknown,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  let targetIndex = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || item.role !== "user") continue;
    if (!Array.isArray(item.content)) continue;
    targetIndex = i;
    break;
  }
  if (targetIndex < 0) return body;

  const target = input[targetIndex] as Record<string, unknown>;
  const newInput = [...input];
  newInput[targetIndex] = { ...target, content: [block, ...(target.content as unknown[])] };
  return { ...body, input: newInput };
}
