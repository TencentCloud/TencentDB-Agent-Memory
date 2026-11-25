/**
 * PersonaGenerator: generates or updates user persona using the four-layer
 * deep scan model via CleanContextRunner.
 */

import type { MemoryPromptMode } from "../../config.js";
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
import { composeMemorySystemPrompt, resolveTemplateContext } from "../memory-prompt/composer.js";
import { checkTemplateOutput, l3TemplateMaxChars } from "../memory-prompt/template.js";

const TAG = "[memory-tdai] [persona]";

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
   */
  async generateLocalPersona(triggerReason?: string): Promise<"generated" | "unchanged" | "failed"> {
    const startMs = Date.now();
    this.logger?.debug?.(`${TAG} Starting generation: reason="${triggerReason ?? "none"}"`);

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    this.logger?.debug?.(`${TAG} Checkpoint: total_processed=${cp.total_processed}, last_persona_at=${cp.last_persona_at}`);

    const targetFile = StoragePaths.persona;
    const targetLabel = this.promptMode === "code" ? "team operating doctrine" : "persona";

    // 1. Read existing L3 document (strip navigation)
    let existingPersona: string | undefined;
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        raw = await fs.default.readFile(path.default.join(this.dataDir, targetFile), "utf-8");
      }
      if (raw) {
        existingPersona = stripSceneNavigation(raw).trim() || undefined;
      }
      this.logger?.debug?.(`${TAG} Existing ${targetLabel}: ${existingPersona ? `${existingPersona.length} chars` : "empty"}`);
    } catch {
      this.logger?.debug?.(`${TAG} No existing ${targetFile} file`);
    }

    // 2. Load scene index + identify changed scenes
    const index = await readSceneIndex(this.dataDir, this.storage);
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
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", entry.filename), "utf-8");
        }
        if (!raw) continue;
        changedSceneContents.push(
          `### [${changedSceneContents.length + 1}] ${entry.filename}\n\n\`\`\`markdown\n${raw}\n\`\`\``,
        );
      } catch {
        this.logger?.warn(`【P1】${TAG} Could not read scene block: ${entry.filename}`);
      }
    }

    if (changedSceneContents.length === 0 && existingPersona) {
      this.logger?.debug?.(`${TAG} No scene changes and persona exists, skipping generation`);
      return "unchanged";
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
    const personaFilePath = this.storage
      ? targetFile
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, targetFile); })();
    const checkpointPath = this.storage
      ? StoragePaths.checkpoint
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".metadata", "recall_checkpoint.json"); })();

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
      template: resolveTemplateContext(this.memoryPrompt),
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);

    // 7. Backup before LLM run (LLM writes persona.md via tools)
    const bm = new BackupManager(this.storage
      ? undefined  // COS mode: BackupManager not used (TODO: adapt BackupManager for StorageAdapter)
      : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".backup"); })()
    );
    if (!this.storage) {
      const path = await import("node:path");
      await bm.backupFile(path.default.join(this.dataDir, targetFile), "persona", `offset${cp.total_processed}`, this.backupCount);
    }
    const personaWriteMarkerBefore = await readPersonaWriteMarker(
      this.dataDir,
      targetFile,
      this.storage,
    );

    // 8. Run LLM agent (sandboxed to dataDir, tools enabled — LLM writes target L3 file directly)
    // 接收返回文本作为兜底来源：模型不调工具、直接输出 persona 文本时，系统可自行落盘
    let llmText = "";
    try {
      this.logger?.debug?.(`${TAG} Calling LLM for ${targetFile} generation (timeout=180s, tools=enabled, workspaceDir=${this.dataDir})...`);
      // langfuse trace 语义：L3 persona 生成有独立 name / 顶级 user/session 列 / 可筛选 tags。
      const traceParams = buildTraceParams("memory.persona-generate", this.traceContext);
      llmText = (await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: "persona-generation",
        timeoutMs: 180_000,
        // 显式覆盖模型 catalog 值，与 prompt 的 1200/2000 字约束对齐，防止输出失控被截断（finishReason=length）
        maxTokens: 4000,
        workspaceDir: this.dataDir,
        // Service mode: LLM tools read/write via StorageAdapter (COS) instead of local FS
        storage: this.storage,
        storagePrefix: this.storage ? "" : undefined,
        ...traceParams,
      })) ?? "";
      this.logger?.debug?.(`${TAG} LLM runner completed`);
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      this.logger?.error(`【P1】${TAG} Persona generation failed after ${elapsedMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return "failed";
    }
    const personaWriteMarkerAfter = await readPersonaWriteMarker(
      this.dataDir,
      targetFile,
      this.storage,
    );

    // 9. Read LLM-written persona.md; fallback to LLM text output when the file wasn't written
    let personaText = "";
    try {
      let raw: string | null;
      if (this.storage) {
        raw = await this.storage.readFile(targetFile);
      } else {
        const fs = await import("node:fs/promises");
        raw = await fs.default.readFile(personaFilePath, "utf-8");
      }
      personaText = raw ?? "";
    } catch {
      personaText = "";
    }
    const markerUnchanged =
      existingPersona &&
      personaWriteMarkerBefore &&
      personaWriteMarkerAfter === personaWriteMarkerBefore;
    if (!personaText || markerUnchanged) {
      // 安全兜底：仅采纳结构上确实是一份 persona 文档的文本，防止污染 L3
      const fallback = extractPersonaFromText(llmText, this.promptMode);
      if (fallback) {
        this.logger?.info(
          `${TAG} LLM did not write ${targetFile} via tools, falling back to text output (${fallback.length} chars)`,
        );
        personaText = fallback;
      } else {
        this.logger?.error(
          `【P1】${TAG} LLM neither wrote ${targetFile} nor returned valid persona text; preserving checkpoint for retry`,
        );
        return "failed";
      }
    }

    // 10. Strip any navigation the LLM might have added + sanitize for safe injection
    personaText = escapeXmlTags(stripSceneNavigation(personaText).trim());

    if (!personaText) {
      this.logger?.error(`【P1】${TAG} LLM wrote empty ${targetFile} — skipping`);
      return "failed";
    }

    const personaUnchanged =
      existingPersona !== undefined &&
      personaText === escapeXmlTags(existingPersona);

    // 11. Append fresh scene navigation and write final content
    const nav = generateSceneNavigation(index, undefined, false);
    const finalContent = nav ? `${personaText}\n\n${nav}\n` : personaText;
    if (this.storage) {
      await this.storage.writeFile(targetFile, finalContent);
    } else {
      const fs = await import("node:fs/promises");
      await fs.default.writeFile(personaFilePath, finalContent, "utf-8");
    }

    const elapsedMs = Date.now() - startMs;
    this.logger?.info(`${TAG} ${targetFile} written (${finalContent.length} chars) in ${elapsedMs}ms`);
    this.reportTemplateViolations(personaText);

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

    return personaUnchanged ? "unchanged" : "generated";
  }

  /** Template mode: log + report persona.md format violations. Never mutates content. */
  private reportTemplateViolations(personaText: string): void {
    const ctx = resolveTemplateContext(this.memoryPrompt);
    if (!ctx) return;
    try {
      const check = checkTemplateOutput({
        layer: "l3",
        content: personaText,
        templatePrompt: ctx.prompt,
        maxChars: l3TemplateMaxChars(this.promptMode),
      });
      if (check.violations.length === 0) return;
      this.logger?.warn(
        `${TAG} template output violation: memory_prompt_id=${ctx.memoryPromptId} version=${ctx.version} ` +
        `reasons=${check.violations.join(",")} chars=${check.chars}` +
        (check.unknownHeadings.length ? ` unknown_headings=${JSON.stringify(check.unknownHeadings)}` : ""),
      );
      for (const reason of check.violations) {
        report("memory_prompt_template_violation", {
          layer: "l3",
          reason,
          chars: check.chars,
          memoryPromptId: ctx.memoryPromptId,
          memoryPromptVersion: ctx.version,
          instanceId: this.instanceId,
        });
      }
    } catch { /* never block business logic */ }
  }

  /**
   * Backward-compatible wrapper: local generation + checkpoint advance.
   */
  async generate(triggerReason?: string): Promise<boolean> {
    const result = await this.generateLocalPersona(triggerReason);
    if (result !== "generated") return false;

    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    await cpManager.markPersonaGenerated(cp.total_processed);
    return true;
  }
}

async function readPersonaWriteMarker(
  dataDir: string,
  targetFile: string,
  storage?: StorageAdapter,
): Promise<string | undefined> {
  try {
    if (storage) {
      const stat = await storage.stat(targetFile);
      return stat ? `${stat.size}:${stat.lastModified}` : undefined;
    }
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const stat = await fs.default.stat(path.default.join(dataDir, targetFile));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** 兜底文本长度上限：超出视为异常输出，拒绝采纳（正常已被 maxTokens 控制） */
const MAX_FALLBACK_CHARS = 8000;

/**
 * 从模型输出文本中提取可用的 persona 文档；提取失败返回 null（拒绝兜底）。
 * - 剥离 markdown 代码围栏；
 * - 按模板标题锚点截取，锚点之前的思考/废话全部丢弃；
 * - 锚点不存在 / 内容为空 / 超长 → 返回 null。
 */
function extractPersonaFromText(llmText: string, promptMode: MemoryPromptMode): string | null {
  let text = llmText.trim();
  // 1. 剥离 markdown 代码围栏（模型偶尔把输出包在 ```markdown 里）
  text = text.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  // 2. 按模板标题锚点截取
  const anchor = promptMode === "code"
    ? "# Team Operating Doctrine"      // 团队画像模板首行
    : "# User Narrative Profile";      // 用户画像模板首行
  const idx = text.indexOf(anchor);
  if (idx === -1) return null;         // 没有模板锚点 → 不可信，拒绝
  const body = text.slice(idx).trim();
  // 3. 最小校验
  if (!body) return null;
  if (body.length > MAX_FALLBACK_CHARS) return null;
  return body;
}
