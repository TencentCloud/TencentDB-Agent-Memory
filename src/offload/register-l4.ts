/**
 * register-l4.ts — backend-aware L4 skill helper.
 *
 * Extracted from index.ts registerOffload() (Group D decomposition).
 * Reads MMD + offload entries locally, sends to backend, writes the skill
 * file locally, returns a system-context prompt for the current turn.
 */
import type { OffloadStateManager } from "./state-manager.js";
import type { RegisterCtx } from "./register-ctx.js";
import { listMmds, readMmd, readAllOffloadEntries } from "./storage.js";

/** Backend-aware L4 skill creation (captures backendClient via ctx). */
export async function createSkillWithBackend(
  ctx: RegisterCtx,
  stateManager: OffloadStateManager,
  skillCommand: { mmdName: string | null; skillFocus: string | null },
): Promise<any> {
  const { backendClient, logger } = ctx;
  if (!backendClient || !skillCommand.mmdName) return null;
  try {
    const allMmds = await listMmds(stateManager.ctx);
    const mmdFilename = allMmds.find((f) => f.includes(skillCommand.mmdName!)) ?? null;
    if (mmdFilename) {
      const mmdContent = await readMmd(stateManager.ctx, mmdFilename);
      if (mmdContent) {
        const allEntries = await readAllOffloadEntries(stateManager.ctx);
        const nodeIdPattern = /\b(\d{3}-N\d+)\b/g;
        const nodeIds = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = nodeIdPattern.exec(mmdContent)) !== null) {
          nodeIds.add(match[1]);
        }
        const filtered = allEntries.filter((e) => e.node_id && nodeIds.has(e.node_id));
        const resp = await (backendClient as any).l4Generate({
          mmdFilename,
          mmdContent,
          offloadEntries: filtered,
          skillFocus: skillCommand.skillFocus,
        });
        if (!resp) return null;
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const skillsDir = join(stateManager.ctx.dataDir, "skills", resp.skillName);
        await mkdir(skillsDir, { recursive: true });
        await writeFile(join(skillsDir, "SKILL.md"), resp.skillContent, "utf-8");
        const resultPrompt = `<l4_skill_result>\n【Skill 生成完成】\n\n**Skill 名称:** ${resp.skillName}\n**描述:** ${resp.skillDescription}\n**文件路径:** ${join(skillsDir, "SKILL.md")}\n\n---\n${resp.skillContent}\n---\n</l4_skill_result>`;
        return { appendSystemContext: resultPrompt, phase: "completed", skillName: resp.skillName };
      }
    }
  } catch (err) {
    logger.error(`[context-offload] Backend L4 failed: ${err}`);
  }
  return null;
}
