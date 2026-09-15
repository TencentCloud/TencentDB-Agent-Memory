/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { formatForLLM } from "../../utils/time.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { buildPersonaPrompt, type PersonaToolDialect } from "../prompts/persona-generation.js";
import { BackupManager } from "../../utils/backup.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { report } from "../report/reporter.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai] [persona]";

export class PersonaGenerator {
  private dataDir: string;
  private runner: LLMRunner;
  private logger: Logger | undefined;
  private backupCount: number;
  private instanceId: string | undefined;
  /** Tool-name dialect for the persona prompt, derived from the active runner. */
  private toolDialect: PersonaToolDialect;

  constructor(opts: {
    dataDir: string;
    config: unknown;
    model?: string;
    backupCount?: number;
    logger?: Logger;
    /** Plugin instance ID for metric reporting (optional) */
    instanceId?: string;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     * Must be configured with `enableTools: true`.
     */
    llmRunner?: LLMRunner;
  }) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.backupCount = opts.backupCount ?? 3;
    this.instanceId = opts.instanceId;
    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });
    // The injected runner is the host-neutral StandaloneLLMRunner (gateway/Hermes),
    // whose file tools are write_to_file/replace_in_file. The fallback
    // CleanContextRunner uses OpenClaw's write/edit. Tell the prompt which set to
    // reference so the model can actually call the write tool (not emit raw text).
    this.toolDialect = opts.llmRunner ? "standalone" : "openclaw";
    this.logger?.debug?.(`${TAG} Generator created: model=${opts.model ?? "(default)"}, dataDir=${opts.dataDir}, toolDialect=${this.toolDialect}`);
  }

  /**
   * Execute local persona generation without advancing checkpoint.
   */
  async generateLocalPersona(triggerReason?: string): Promise<boolean> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const personaPath = path.join(this.dataDir, "persona.md");

    // 1. Read existing persona (strip navigation)
    let existingPersona: string | undefined;
    try {
      const raw = await fs.readFile(personaPath, "utf-8");
      existingPersona = stripSceneNavigation(raw).trim() || undefined;
      this.logger?.debug?.(`${TAG} Existing persona: ${existingPersona ? `${existingPersona.length} chars` : "empty"}`);
    } catch {
      this.logger?.debug?.(`${TAG} No existing persona file`);
    }

    // 2. Load scene index + identify changed scenes
    const index = await readSceneIndex(this.dataDir);
    const changedScenes = index.filter((e) => {
      if (!cp.last_persona_time) return true;
      const updatedMs = new Date(e.updated).getTime();
      const personaMs = new Date(cp.last_persona_time).getTime();
      // If either date is unparseable (NaN), treat as changed (conservative)
      if (Number.isNaN(updatedMs) || Number.isNaN(personaMs)) return true;
      return updatedMs > personaMs;
    });
    this.logger?.debug?.(`${TAG} Scene index: ${index.length} total, ${changedScenes.length} changed since last persona`);

    // 3. Read changed scene contents (full raw content including META, matching Python reference)
    const blocksDir = path.join(this.dataDir, "scene_blocks");
    const changedSceneContents: string[] = [];
    for (const entry of changedScenes) {
      try {
        const raw = await fs.readFile(path.join(blocksDir, entry.filename), "utf-8");
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch {
        this.logger?.warn(`${TAG} Could not read scene block: ${entry.filename}`);
      }
    }

    if (changedSceneContents.length === 0 && existingPersona) {
      this.logger?.debug?.(`${TAG} No scene changes and persona exists, skipping generation`);
      return false;
    }

    // 4. Determine mode
    const mode = existingPersona ? "incremental" : "first";
    this.logger?.debug?.(`${TAG} Generation mode: ${mode}, ${changedSceneContents.length} scene blocks to process`);

    // 5. Build changed scenes section with guidance (matching Python reference format)
    let changedScenesContent: string;
    if (changedSceneContents.length > 0) {
      changedScenesContent =
        `\n\n## 📄 变化场景完整内容\n\n` +
        `*自上次 Persona 更新后，以下 ${changedSceneContents.length} 个场景发生了变化。工程已为你预加载完整内容：*\n\n` +
        changedSceneContents.join("\n\n") +
        `\n\n---\n\n` +
        `⚠️ **重点分析变化场景**：上述场景是自上次更新后的**新增/修改内容**，请**重点分析**这些场景中的新信息。\n`;
    } else {
      changedScenesContent = `\n\n⚠️ **无变化场景**：所有场景均已在上次 Persona 更新中分析过，本次可直接读取所有场景进行全局审视。\n`;
    }

    // 6. Build prompt
    const { systemPrompt, userPrompt } = buildPersonaPrompt({
      mode,
      currentTime: formatForLLM(new Date()),
      totalProcessed: cp.total_processed,
      sceneCount: index.length,
      changedSceneCount: changedScenes.length,
      changedScenesContent,
      existingPersona,
      triggerInfo: triggerReason,
      personaFilePath: personaPath,
      checkpointPath: path.join(this.dataDir, ".metadata", "recall_checkpoint.json"),
      toolDialect: this.toolDialect,
    });

    // 7. Backup before LLM run (LLM writes persona.md via tools)
    const bm = new BackupManager(path.join(this.dataDir, ".backup"));
    await bm.backupFile(personaPath, "persona", `offset${cp.total_processed}`, this.backupCount);

    // 8. Run LLM agent (sandboxed to dataDir, tools enabled — LLM writes persona.md directly)
    let runOutput = "";
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for persona generation (timeout=180s, tools=enabled, workspaceDir=${this.dataDir})...`);
      runOutput = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: this.dataDir,
        // Standalone runner exposes write_to_file: force the model to write the
        // file via tool (the OpenClaw runner ignores this flag and uses its own).
        forceWriteTool: this.toolDialect === "standalone",
      });
      this.logger?.debug?.(`${TAG} LLM runner completed`);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return false;
    }

    // 9. Read the LLM-written persona.md and apply post-processing.
    //    Fallback: OpenAI-compatible models with weak tool-calling (e.g.
    //    Moonshot/Kimi) often emit the persona as assistant TEXT instead of
    //    invoking the write_to_file tool. In that case persona.md is never
    //    created and an otherwise-successful generation would be silently lost.
    //    When the file is missing but the runner returned text, persist that
    //    text as the persona so L3 is robust to tool-calling variance.
    let personaText: string;
    try {
      personaText = await fs.readFile(personaPath, "utf-8");
    } catch {
      if (runOutput && runOutput.trim()) {
        this.logger?.warn(`${TAG} LLM did not call write_to_file; persisting returned assistant text as persona.md (${runOutput.length} chars)`);
        personaText = runOutput;
      } else {
        this.logger?.error(`${TAG} LLM did not write persona.md and returned no text — treating as failure`);
        return false;
      }
    }

    // 10. Strip any navigation the LLM might have added + sanitize for safe injection
    personaText = escapeXmlTags(stripSceneNavigation(personaText).trim());

    if (!personaText) {
      this.logger?.error(`${TAG} LLM wrote empty persona.md — skipping`);
      return false;
    }

    // 11. Append fresh scene navigation and write final content
    const nav = generateSceneNavigation(index);
    const finalContent = nav ? `${personaText}\n\n${nav}\n` : personaText;
    await fs.writeFile(personaPath, finalContent, "utf-8");

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} Persona written (${finalContent.length} chars) in ${elapsedMs}ms`);

    // ── l3_persona_generation metric ──
    if (this.instanceId && this.logger) {
      report("l3_persona_generation", {
        triggerReason: triggerReason ?? "unknown",
        mode: existingPersona ? "incremental" : "initial",
        newPersonaContent: personaText,
        newPersonaLength: personaText.length,
        totalDurationMs: elapsedMs,
        success: true,
        error: null,
      });
    }

    return true;
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const updated = await this.generateLocalPersona(triggerReason);
    if (!updated) return false;

    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}
