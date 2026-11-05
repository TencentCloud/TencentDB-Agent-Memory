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
| \`mem:config-lock\` | 把当前 session 的 Team/Agent/Task 保存为**账户级默认**，之后新 Session 自动跳过选择（覆盖旧配置前会先展示待保存内容，需 \`confirm\`） |
| \`mem:config-unlock\` | 清除账户级默认；下次新 Session 恢复手动选择（**不影响本次对话**） |
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

### 🔒 \`mem:config-lock\` — 保存账户级默认 (Team/Agent/Task)

**用法**
- \`mem:config-lock\` — 把当前 session 的 Team/Agent/Task 保存为账户默认。
- **会覆盖一组不同旧配置时，先展示待保存内容等你确认**（避免误覆盖）：
  1. \`mem:config-lock\` → 展示「待保存配置 + 将被覆盖的旧配置」
  2. \`mem:config-lock confirm\` → 确认并保存
  3. \`mem:config-lock cancel\` → 取消，不改任何东西
- 当前**没有**旧配置、或旧配置与本次完全相同时，直接一步保存，不再多问。
- 确认有效期 5 分钟，超时重跑 \`mem:config-lock\` 即可。

**生效范围**
- 保存后**所有新 Session** 自动跳过「是否关联团队资产 / Team / Agent / Task」选择。
- 已经开始的 Session 不受影响。
- 仅本人：admin 也只能保存自己的默认，不能代设成员。
- 已有默认配置时**直接覆盖**（本就是该命令的预期语义）。
- 若保存错了：执行 \`mem:config-unlock\` 解除，或重跑本命令覆盖。

**前置条件**
- 当前 session 已完成 Team/Agent 选择 (已 initialized)，否则命令会提示先选好 Team/Agent。
- Task 为 "暂时跳过" 也可以保存 (存为虚拟 \`default\`，表示不绑定任何 Task)。

---

### 🔓 \`mem:config-unlock\` — 清除账户级默认

**用法**
- \`mem:config-unlock\` → 直接清除 (幂等；没有默认也 ok)。
- **不影响本次对话** —— 当前 Agent 身份不变。

**生效范围**
- 下次新开 Session 恢复 header preset → 手动表单的回退链路。
- 若想换一组默认：\`mem:config-unlock\` → 开新会话重选 Team/Agent/Task → \`mem:config-lock\`。
- 想直接修改也可以去面板「Agents · 我的 Session 默认配置」。

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
mem:config-lock
mem:config-lock confirm
mem:config-lock cancel
mem:config-unlock
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
