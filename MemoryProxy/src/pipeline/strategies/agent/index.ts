/**
 * AgentStrategy 工厂 —— 按 agentSource 分派 10 个 AgentStrategy 实例。
 *
 * 主蓝图 §2.1 列 8 个 (claude-code/codebuddy/codex/workbuddy/dsh/opencode/
 * pi/default); addendum §4.3 追加 hermes/openclaw 两个 header-only agent,
 * 与 pi 共用同一组约束 (supportsSessionForm=false + bypassOnPresetFail=true)。
 * 前 8 个的 derive 源是 `agent-adapters/` 下同名 adapter; hermes/openclaw
 * 无独立 adapter (未做抓包特化), 复用 defaultAdapter 并在 strategy 层补字段 ——
 * 见 hermes.ts 头注释。
 */

import type { AgentStrategy } from "./types.js";
import { claudeCodeStrategy } from "./claude-code.js";
import { codebuddyStrategy } from "./codebuddy.js";
import { codexStrategy } from "./codex.js";
import { workbuddyStrategy } from "./workbuddy.js";
import { dshStrategy } from "./dsh.js";
import { opencodeStrategy } from "./opencode.js";
import { piStrategy } from "./pi.js";
import { hermesStrategy } from "./hermes.js";
import { openclawStrategy } from "./openclaw.js";
import { defaultStrategy } from "./default.js";

export {
  claudeCodeStrategy,
  codebuddyStrategy,
  codexStrategy,
  workbuddyStrategy,
  dshStrategy,
  opencodeStrategy,
  piStrategy,
  hermesStrategy,
  openclawStrategy,
  defaultStrategy,
};

export function resolveAgentStrategy(agentSource: string): AgentStrategy {
  switch (agentSource) {
    case "claude-code": return claudeCodeStrategy;
    case "codebuddy": return codebuddyStrategy;
    case "codex": return codexStrategy;
    case "workbuddy": return workbuddyStrategy;
    case "dsh": return dshStrategy;
    case "opencode": return opencodeStrategy;
    case "pi": return piStrategy;
    // header-only 三方 (addendum §4.3) —— 独立实例而非共用, 便于将来单方特化
    case "hermes": return hermesStrategy;
    case "openclaw": return openclawStrategy;
    default: return defaultStrategy;
  }
}
