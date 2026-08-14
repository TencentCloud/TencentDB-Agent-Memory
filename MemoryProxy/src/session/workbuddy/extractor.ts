/**
 * WorkBuddy Session Init — Extractor.
 *
 * WorkBuddy 客户端复用 CC 的 `AskUserQuestion` tool 契约（同 tool name、同
 * questions/answers 结构，抓包 [wb-ask-user-schema] 已实证）。因此用户答复
 * 的 tool_result JSON 结构 与 CC **完全一致**。
 *
 * 本文件直接 re-export CC 的 extractor —— 保持"WB 由独立模块承接"的架构语
 * 义，同时避免复制粘贴 400 行匹配逻辑；未来任一侧行为分叉，只需在此文件
 * 加 wrapper 即可，无需回改上游。
 *
 * 注意：CC extractor 里的 `SKIP_LABEL / MORE_LABEL / ASSET_CONFIRM_*` 常量
 * 是从 `./claude-code/form.js` 引入的。WB form.ts 里定义了同名常量，但
 * 值完全一致（"本次不关联（跳过注入，直接放行）" / "更多 →" 等），因此
 * extractor 用哪个都行；沿用 CC 的即可。
 */

export {
  BYPASS_MARKER,
  MORE_MARKER,
  extractAssetConfirm,
  extractTeamFromOptionText,
  extractTaskFromOptionText,
  extractFromOptionText,
  extractStructured,
  resolveAgent,
  resolveTask,
} from "../claude-code/extractor.js";
