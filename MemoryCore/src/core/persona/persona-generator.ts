/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 */

import type { MemoryPromptMode } from "../../config.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { buildPersonaPrompt } from "../prompts/persona-generation.js";
import { BackupManager } from "../../utils/backup.js";
import { escapeXmlTags } from "../../utils/sanitize.js";
import { report } from "../report/reporter.js";
import { reportL3LatencyMetrics } from "../report/metric-tracking-l3-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt } from "../memory-prompt/composer.js";

const TAG = "[memory-tdai] [persona]";

async function publishLocalFileAtomically(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export class PersonaGenerator {
  private dataDir: string;
  private runner: LLMRunner;
  private logger: Logger | undefined;
  private backupCount: number;
  private promptMode: MemoryPromptMode;
  private memoryPrompt: ResolvedMemoryPrompt | undefined;
  private instanceId: string | undefined;
  private storage: StorageAdapter | undefined;
  private traceContext: TraceContext | undefined;

  constructor(opts: {
    dataDir: string;
    config: unknown;
    model?: string;
    /** Prompt family for L3 generation (default: chat). */
    promptMode?: MemoryPromptMode;
    /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
    memoryPrompt?: ResolvedMemoryPrompt;
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
    /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
    storage?: StorageAdapter;
    /** langfuse 上报身份四元组（team/user/agent/session），填充 trace 顶级字段。 */
    traceContext?: TraceContext;
  }) {
    this.dataDir = opts.dataDir;
    this.logger = opts.logger;
    this.promptMode = opts.promptMode ?? "chat";
    this.memoryPrompt = opts.memoryPrompt;
    this.backupCount = opts.backupCount ?? 3;
    this.instanceId = opts.instanceId;
    this.storage = opts.storage;
    this.traceContext = opts.traceContext;
    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });
    this.logger?.debug?.(`${TAG} Generator created: model=${opts.model ?? "(default)"}, promptMode=${this.promptMode}, dataDir=${opts.dataDir}`);
  }

  /**
   * Execute local persona generation without advancing checkpoint.
   * Returns `false` only when the published persona already covers every
   * scene. Generation, validation, and publication failures reject so the
   * caller cannot mistake them for a successful no-op and advance checkpoint.
   */
  async generateLocalPersona(triggerReason?: string): Promise<boolean> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const targetFile = StoragePaths.persona;
    const targetLabel = this.promptMode === "code" ? "team operating doctrine" : "persona";

    // 1. Read existing L3 document (strip navigation)
    let existingPersona: string | undefined;
    let existingPersonaFile: string | undefined;
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        raw = await fs.readFile(path.join(this.dataDir, targetFile), "utf-8");
      }
      if (raw) {
        existingPersonaFile = raw;
        existingPersona = stripSceneNavigation(raw).trim() || undefined;
      }
      this.logger?.debug?.(`${TAG} Existing ${targetLabel}: ${existingPersona ? `${existingPersona.length} chars` : "empty"}`);
    } catch (err) {
      if (!this.storage && isNotFound(err)) {
        this.logger?.debug?.(`${TAG} No existing ${targetFile} file`);
      } else {
        throw new Error(`Could not read existing ${targetFile}`, { cause: err });
      }
    }

    // 2. Load scene index + identify changed scenes
    const index = await readSceneIndex(this.dataDir, this.storage, { strict: true })
      .catch((err: unknown) => {
        throw new Error("Could not read scene index", { cause: err });
      });
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
    const changedSceneContents: string[] = [];
    for (const entry of changedScenes) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`);
        } else {
          raw = await fs.readFile(path.join(this.dataDir, "scene_blocks", entry.filename), "utf-8");
        }
        if (raw === null) throw new Error(`Scene block is missing: ${entry.filename}`);
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch (err) {
        this.logger?.warn(`${TAG} Could not read scene block: ${entry.filename}`);
        throw new Error(`Could not read changed scene block: ${entry.filename}`, { cause: err });
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
    const personaFilePath = path.join(this.dataDir, targetFile);
    const checkpointPath = this.storage
      ? StoragePaths.checkpoint
      : path.join(this.dataDir, ".metadata", "recall_checkpoint.json");

    const { systemPrompt: baseSystemPrompt, userPrompt } = buildPersonaPrompt({
      mode,
      promptMode: this.promptMode,
      currentTime: new Date().toISOString(),
      totalProcessed: cp.total_processed,
      sceneCount: index.length,
      changedSceneCount: changedScenes.length,
      changedScenesContent,
      existingPersona,
      triggerInfo: triggerReason,
      personaFilePath,
      checkpointPath,
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);

    // 7. Run the LLM against an isolated draft workspace. Tool calls must not
    // publish directly to the live profile: a later model/API failure can occur
    // after one or more successful write/edit calls. Only a fully completed,
    // validated run is committed below.
    const draftDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tdai-persona-"));
    const draftPath = path.join(draftDir, targetFile);
    if (existingPersonaFile !== undefined) {
      await fs.writeFile(draftPath, existingPersonaFile, "utf-8");
    }

    let personaText: string;
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for ${targetFile} generation (timeout=180s, tools=enabled, workspaceDir=${draftDir})...`);
      // langfuse trace 语义：L3 persona 生成有独立 name / 顶级 user/session 列 / 可筛选 tags。
      const traceParams = buildTraceParams("memory.persona-generate", this.traceContext);
      await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: draftDir,
        // Deliberately omit storage: both standalone and OpenClaw runners then
        // expose file tools rooted in the isolated draft directory.
        ...traceParams,
      });
      this.logger?.debug?.(`${TAG} LLM runner completed`);

      const raw = await fs.readFile(draftPath, "utf-8");
      personaText = raw;
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    } finally {
      await fs.rm(draftDir, { recursive: true, force: true }).catch(() => {});
    }

    // 8. Strip any navigation the LLM might have added + sanitize for safe injection
    personaText = escapeXmlTags(stripSceneNavigation(personaText).trim());

    if (!personaText) {
      this.logger?.error(`${TAG} LLM wrote empty ${targetFile} — skipping`);
      throw new Error(`LLM wrote empty ${targetFile}`);
    }

    // 9. Append fresh scene navigation and publish once. Storage backends expose
    // whole-object replacement; the fs fallback uses tmp+rename so readers see
    // either the previous persona or the complete new one.
    const nav = generateSceneNavigation(index, undefined, false);
    const finalContent = nav ? `${personaText}\n\n${nav}\n` : personaText;
    if (this.storage) {
      await this.storage.writeFile(targetFile, finalContent);
    } else {
      const bm = new BackupManager(path.join(this.dataDir, ".backup"));
      await bm.backupFile(personaFilePath, "persona", `offset${cp.total_processed}`, this.backupCount);
      await publishLocalFileAtomically(personaFilePath, finalContent);
    }

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} ${targetFile} written (${finalContent.length} chars) in ${elapsedMs}ms`);

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

    // ── 评测指标：L3 延迟 + 画像变化 ──
    try {
      reportL3LatencyMetrics({
        instanceId: this.instanceId ?? "",
        generationLatencyMs: elapsedMs,
        personaLengthBefore: existingPersona ? existingPersona.length : 0,
        personaLengthAfter: finalContent.length,
        personaTextBefore: existingPersona ?? "",
        personaTextAfter: personaText,
        hasError: false,
      });
    } catch {
      // 静默忽略
    }

    return true;
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const updated = await this.generateLocalPersona(triggerReason);
    if (!updated) return false;

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
