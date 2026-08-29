/**
 * mem:help — 返回支持的命令列表及示例
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## 支持的 mem: 命令

| 命令 | 说明 |
|------|------|
| \`mem:session-reset\` | 重置本次会话的团队/Agent/任务绑定，立即弹出重新选择 |
| \`mem:sync\` | 刷新本次会话的全部资产注入（Skill / 记忆 / Knowledge / Task & Agent 描述） |
| \`mem:create-skill [提示词]\` | 把本次对话归档为 Skill，后台异步提取 |
| \`mem:create-task [标题]\` | 从当前会话上下文创建 Task 并绑定到本 session |
| \`mem:update-task [新描述]\` | 更新已绑定 Task 的描述 |
| \`mem:help\` | 显示本帮助 |

---

### 🆕 \`mem:create-task\` — 创建并绑定 Task

**用法**
- **无参数**：LLM 从最近对话中推断 title + description
- **有参数**：参数作为 title（40 字截断），LLM 只生成 description

**若本 session 已绑真实 Task**，返回新 Task 预览，回复以下之一：

| 回复 | 效果 |
|------|------|
| \`mem:create-task confirm\` | ✅ 覆盖绑定，创建新 Task |
| \`mem:update-task\` 或 \`mem:update-task <新描述>\` | ⭐ **推荐** — 继续复用当前 Task，只更新描述 |
| \`mem:create-task cancel\` | 🚫 取消，不做任何改动 |

---

### ✏️ \`mem:update-task\` — 更新当前 Task 描述

**用法**
- **无参数**：LLM 对比 "当前 description + 最近对话" 生成新 description
  - 判无实质改动 → 返回 ℹ️ 无需更新（幂等，可安全重试）
  - 判有改动 → 返回预览
- **有参数**：参数直接作为新 description（不调 LLM），返回预览

**确认预览**：
- ✅ \`mem:update-task confirm\` — 确认
- 🚫 \`mem:update-task cancel\` — 取消

**保护规则**：
- 若本 session 未绑 Task → 拦截并提示先执行 \`mem:create-task\`
- 若绑定的 Task 不是你创建的 → 拒绝更新（不支持跨用户改），建议 \`mem:create-task\` 新建一个属于你的

---

### 示例

\`\`\`
mem:sync
mem:create-skill 重点总结数据库迁移步骤和踩坑
mem:create-task 重构 SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task 补充今天完成的进度与遗留风险
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:help
\`\`\`

> 标准格式为 \`mem:<command>\`，冒号后不加空格。命令名大小写不敏感。`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
