/**
 * ZCode (智谱 ZCode CLI/桌面端) client adapter.
 *
 * ZCode 的 provider 配置原生走 Anthropic Messages 协议（provider kind
 * "anthropic"，baseURL 形如 `https://open.bigmodel.cn/api/anthropic`），
 * 与 Claude Code 同协议；但请求体内部 block 布局（system-reminder /
 * cache_control 位置）尚未抓包验证 —— 参照 CB stub 的处理方式，保守沿用
 * default 行为，拿到抓包依据后再参考 claude-code.ts 特化。
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const zcodeAdapter: AgentAdapter = {
  agentKind: "zcode",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    return defaultAdapter.extractUserText(content);
  },
};
