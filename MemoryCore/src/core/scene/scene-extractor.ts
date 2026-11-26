/**
 * SceneExtractor: LLM-driven memory extraction into scene blocks.
 *
 * Replaces the keyword-based SceneManager.processNewMemories() with an
 * LLM agent that autonomously reads/writes scene block files using tools.
 *
 * Security: The LLM is sandboxed — workspaceDir is set to scene_blocks/
 * so it can ONLY operate on .md scene files. System files (checkpoint,
 * scene_index, persona.md) are physically invisible to the LLM.
 *
 * Flow:
 *   1. Backup + load scene index + build summaries
 *   2. Assemble extraction prompt with memories + scene context
 *   3. Run via CleanContextRunner (tools enabled, sandboxed to scene_blocks/)
 *   4. Cleanup: remove soft-deletes, sync index, update navigation
 *   5. Parse LLM text output for out-of-band persona update signals
 */

import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { BackupManager } from "../../utils/backup.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { parseSceneBlock, formatSceneBlock } from "../scene/scene-format.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import { normalizeSceneFilenames } from "./filename-normalizer.js";
import type { MemoryPromptMode } from "../../config.js";
import { buildSceneExtractionPrompt } from "../prompts/scene-extraction.js";
import { report } from "../report/reporter.js";
import { reportL2LatencyMetrics } from "../report/metric-tracking-l2-latency.js";
import type { LLMRunner, Logger, TraceContext } from "../types.js";
import { buildTraceParams } from "../types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { ResolvedMemoryPrompt } from "../memory-prompt/types.js";
import { composeMemorySystemPrompt, resolveTemplateContext } from "../memory-prompt/composer.js";
import { checkTemplateOutput, L2_TEMPLATE_MAX_CHARS } from "../memory-prompt/template.js";
import { createHash } from "node:crypto";

const TAG = "[memory-tdai] [extractor]";

/** Minimal per-scene snapshot used by the size budget (raw file + parsed body). */
interface SceneSizeSnapshot {
  raw: string;
  content: string;
}

/** Render a byte count for logs and prompt warnings. */
function formatSceneBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

type ExtractorLogger = Logger;

export interface ExtractionResult {
  memoriesProcessed: number;
  success: boolean;
  error?: string;
  /** True if LLM ran but produced no file changes (scene_index unchanged). */
  emptyExtraction?: boolean;
  /** Persisted final scene-file delta, captured after index synchronization. */
  sceneDiff?: PersistedSceneDiff;
  /**
   * Scenes whose content was rewritten in this run although every input
   * memory was older than what the scene already covered (late arrival).
   * Recorded only; content is not reverted.
   */
  lateArrivalRewrites?: string[];
}

export interface SceneFileSnapshot {
  filename: string;
  sha256: string;
  chars: number;
  parseable: boolean;
  created: string;
  updated: string;
  summary: string;
  heat: number;
  /** Present in memory only; diagnostic serialization decides whether it may be logged. */
  content: string;
  raw: string;
}

export interface PersistedSceneDiff {
  beforeFiles: string[];
  afterFiles: string[];
  created: SceneFileSnapshot[];
  updated: Array<{ before: SceneFileSnapshot; after: SceneFileSnapshot }>;
  deleted: SceneFileSnapshot[];
}

export interface SceneExtractorOptions {
  dataDir: string;
  config: unknown;
  model?: string;
  maxScenes?: number;
  /** Prompt family for L2 scene extraction (default: chat). */
  promptMode?: MemoryPromptMode;
  /** Resolved custom strategy. Undefined preserves the current system prompt exactly. */
  memoryPrompt?: ResolvedMemoryPrompt;
  sceneBackupCount?: number;
  /**
   * Max bytes for a single scene block file. Enforced both in the prompt
   * (oversized scenes are called out) and at write-back (growth rejected).
   */
  maxSceneBytes?: number;
  timeoutMs?: number;
  logger?: ExtractorLogger;
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
  /** langfuse 上报身份四元组（team/user/agent/session）。传下来会填充 trace 顶级字段。 */
  traceContext?: TraceContext;
}

/**
 * Parse LLM text output for a persona update request signal.
 *
 * Supports multiple formats for robustness:
 * - Block: [PERSONA_UPDATE_REQUEST]reason: xxx[/PERSONA_UPDATE_REQUEST]
 * - Inline: PERSONA_UPDATE_REQUEST: xxx
 */
export function parsePersonaUpdateSignal(text: string): { reason: string } | null {
  // Block format: [PERSONA_UPDATE_REQUEST]...[/PERSONA_UPDATE_REQUEST]
  const blockMatch = text.match(
    /\[PERSONA_UPDATE_REQUEST\]\s*(?:reason:\s*)?(.+?)\s*\[\/PERSONA_UPDATE_REQUEST\]/s,
  );
  if (blockMatch) return { reason: blockMatch[1]!.trim() };

  // Inline format: PERSONA_UPDATE_REQUEST: reason text
  const inlineMatch = text.match(
    /PERSONA_UPDATE_REQUEST:\s*(.+?)(?:\n|$)/,
  );
  if (inlineMatch) return { reason: inlineMatch[1]!.trim() };

  return null;
}

export class SceneExtractor {
  private dataDir: string;
  private runner: LLMRunner;
  private maxScenes: number;
  private maxSceneBytes: number;
  /**
   * Count of scene rewrites driven entirely by late-arriving (older) memories
   * since this extractor was created. Observability only — such rewrites are
   * recorded, never reverted.
   */
  lateArrivalRewrites = 0;
  private sceneBackupCount: number;
  private promptMode: MemoryPromptMode;
  private memoryPrompt: ResolvedMemoryPrompt | undefined;
  private timeoutMs: number;
  private logger: ExtractorLogger | undefined;
  private instanceId: string | undefined;
  private storage: StorageAdapter | undefined;
  private traceContext: TraceContext | undefined;

  /** Log prefix carrying instanceId, so service-mode logs can be filtered per instance. */
  private get tag(): string {
    return `${TAG} [${this.instanceId ?? "-"}]`;
  }

  constructor(opts: SceneExtractorOptions) {
    this.dataDir = opts.dataDir;
    this.maxScenes = opts.maxScenes ?? 15;
    this.maxSceneBytes = opts.maxSceneBytes ?? 262144;
    this.promptMode = opts.promptMode ?? "chat";
    this.memoryPrompt = opts.memoryPrompt;
    this.sceneBackupCount = opts.sceneBackupCount ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 480_000; // 8 min — multi-step tool calls over large scenes
    this.logger = opts.logger;
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

    this.logger?.debug?.(`${this.tag} Created: dataDir=${opts.dataDir}, model=${opts.model ?? "(default)"}, promptMode=${this.promptMode}, maxScenes=${this.maxScenes}, timeout=${this.timeoutMs}ms`);
  }

  /**
   * Extract a batch of memories into scene blocks using the LLM agent.
   *
   * @param memories - Array of raw memory records from the API
   * @returns Extraction result with count and success flag
   */
  async extract(memories: Array<{ content: string; created_at: string; event_time?: string; id?: string }>): Promise<ExtractionResult> {
    const extractStartMs = Date.now();
    this.logger?.info(`${this.tag} extract() start: ${memories.length} memories`);

    if (memories.length === 0) {
      // Early return used to be debug-only, so a run that silently did nothing
      // was indistinguishable from a run that never started. Promote to info
      // with an explicit reason so the skip is greppable.
      this.logger?.info?.(`${this.tag} extract() skipped: reason=empty_input dur_ms=${Date.now() - extractStartMs}`);
      return { memoriesProcessed: 0, success: true };
    }

    const sceneBlocksDir = this.storage ? StoragePaths.sceneBlocksDir : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, "scene_blocks"); })();
    const metadataDir = this.storage ? StoragePaths.metadataDir : await (async () => { const path = await import("node:path"); return path.default.join(this.dataDir, ".metadata"); })();

    // Ensure directories exist
    if (this.storage) {
      await this.storage.mkdir(StoragePaths.sceneBlocksDir);
      await this.storage.mkdir(StoragePaths.metadataDir);
    } else {
      const fs = await import("node:fs/promises");
      await fs.default.mkdir(sceneBlocksDir, { recursive: true });
      await fs.default.mkdir(metadataDir, { recursive: true });
    }

    // Phase 1: Backup
    const backupStartMs = Date.now();
    const cpManager = new CheckpointManager(this.dataDir, this.logger, this.storage);
    const cp = await cpManager.read();
    // BackupManager is only meaningful for local-fs deployments. In service
    // mode (StorageAdapter / COS) snapshot/restore is the storage backend's
    // responsibility, so `bm` stays undefined and the catch-block restore
    // below short-circuits to a no-op.
    let bm: BackupManager | undefined;
    if (!this.storage) {
      const path = await import("node:path");
      bm = new BackupManager(path.default.join(this.dataDir, ".backup"));
      await bm.backupDirectory(sceneBlocksDir, "scene_blocks", `offset${cp.total_processed}`, this.sceneBackupCount);
    }
    this.logger?.debug?.(`${this.tag} extract() backup phase: ${Date.now() - backupStartMs}ms`);

    // Phase 2: Load scene index
    const indexStartMs = Date.now();
    const index = await readSceneIndex(this.dataDir, this.storage);
    this.logger?.debug?.(`${this.tag} extract() scene index loaded: ${index.length} entries (${Date.now() - indexStartMs}ms)`);

    // Build scene summaries for the prompt (relative filenames only).
    // Declared here, filled after snapshots are read so each entry can show
    // the scene's last_event_time.
    let sceneSummaries = "";
    let existingSceneFiles: string[] = [];

    // Build scene count warning (tiered system)
    let sceneCountWarning: string | undefined;
    const sceneCount = index.length;
    if (sceneCount >= this.maxScenes) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，已达到或超过 ${this.maxScenes} 个上限！\n**你必须先执行 MERGE 操作**，将最相似的 2-4 个场景合并为 1 个，然后再处理新记忆。\n参考合并对象：热度最低或主题高度重叠的场景。`;
      this.logger?.warn(`${this.tag} extract() scene count at limit: ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount === this.maxScenes - 1) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，距离上限只差 1 个！\n本次处理**只能 UPDATE 现有场景，不能 CREATE 新场景**。`;
      this.logger?.warn(`${this.tag} extract() scene count near limit (CREATE blocked): ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount >= this.maxScenes - 3) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，建议优先考虑 UPDATE 或主动 MERGE 相似场景。`;
      this.logger?.debug?.(`${this.tag} extract() scene count approaching limit: ${sceneCount}/${this.maxScenes}`);
    }

    // Snapshot scene index + content before LLM — used later to diff created/updated/deleted
    const preExtractIndex = new Map(index.map((e) => [e.filename, e.summary]));
    // Also snapshot scene content so we can detect content-only changes vs metadata-only changes
    const preExtractSnapshots = new Map<string, SceneFileSnapshot>();
    // 每个场景已覆盖到的最新对话时间（META.last_event_time），旧场景没有该字段
    const preExtractEventTimes = new Map<string, string>();
    for (const e of index) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${e.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", e.filename), "utf-8");
        }
        if (!raw) continue;
        const block = parseSceneBlock(raw, e.filename);
        preExtractSnapshots.set(e.filename, snapshotSceneFile(e.filename, raw, block));
        if (block.meta.last_event_time) preExtractEventTimes.set(e.filename, block.meta.last_event_time);
      } catch { /* non-fatal */ }
    }

    // 本批记忆的对话时间范围。event_time 缺失（旧调用方）时退回 created_at。
    const batchEventTimes = memories
      .map((m) => m.event_time || m.created_at)
      .filter((t): t is string => !!t && Number.isFinite(Date.parse(t)))
      .map((t) => new Date(t).toISOString())
      .sort();
    const batchMaxEventTime = batchEventTimes[batchEventTimes.length - 1];
    const batchMinEventTime = batchEventTimes[0];

    ({ summaries: sceneSummaries, filenames: existingSceneFiles } =
      this.buildSceneSummaries(index, preExtractEventTimes));

    // Build scene size warning. Scene *count* alone cannot bound prompt size:
    // once the count ceiling blocks CREATE, every new memory is appended into
    // existing files and they grow without bound. Surfacing concrete per-file
    // sizes lets the LLM compact instead of blindly appending.
    const sceneSizeWarning = this.buildSceneSizeWarning(preExtractSnapshots);

    // Phase 3: Build prompt
    const promptStartMs = Date.now();
    const memoriesJson = JSON.stringify(
      memories.map((m) => ({
        content: m.content,
        // 对话发生时间（不是 L1 写入时间）。LLM 用它和场景的"已覆盖对话至"比较新旧。
        event_time: m.event_time || m.created_at,
        id: m.id ?? "",
      })),
      null,
      2,
    );

    const currentTimestamp = formatTimestamp(new Date());

    const { systemPrompt: baseSystemPrompt, userPrompt } = buildSceneExtractionPrompt({
      memoriesJson,
      sceneSummaries: sceneSummaries || "(无已有场景)",
      currentTimestamp,
      sceneCountWarning,
      sceneSizeWarning,
      existingSceneFiles,
      maxScenes: this.maxScenes,
      maxSceneBytes: this.maxSceneBytes,
      promptMode: this.promptMode,
      template: resolveTemplateContext(this.memoryPrompt),
    });
    const systemPrompt = composeMemorySystemPrompt(baseSystemPrompt, this.memoryPrompt);
    this.logger?.debug?.(`${this.tag} extract() prompt built: ${userPrompt.length} chars (${Date.now() - promptStartMs}ms)`);

    // Phase 4: Run LLM agent (sandboxed to scene_blocks/)
    let llmOutput = "";
    let llmDurationMs = 0;
    try {
      this.logger?.debug?.(`${this.tag} extract() starting LLM runner (timeout=${this.timeoutMs}ms, maxTokens=model default)...`);
      const runnerStartMs = Date.now();
      // langfuse trace 语义：L2 场景抽取有独立 name / 顶级 user/session 列 / 可筛选 tags。
      const traceParams = buildTraceParams("memory.scene-extract", this.traceContext);
      llmOutput = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: `scene-extract-${Date.now()}`,
        instanceId: this.instanceId,
        timeoutMs: this.timeoutMs,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: sceneBlocksDir,
        // Service mode: LLM tools read/write via StorageAdapter (COS) instead of local FS
        storage: this.storage,
        storagePrefix: this.storage ? StoragePaths.sceneBlocksDir : undefined,
        ...traceParams,
      }) ?? "";
      llmDurationMs = Date.now() - runnerStartMs;
      this.logger?.debug?.(`${this.tag} extract() LLM runner completed: ${llmDurationMs}ms`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const totalMs = Date.now() - extractStartMs;
      this.logger?.error(`【P1】${this.tag} extract() LLM runner failed after ${totalMs}ms: ${errMsg}`);

      // Restore scene_blocks/ from the Phase 1 backup so partial LLM writes
      // (or a wiped sandbox) don't leak into the next recall cycle.
      // Fail-soft: a restore failure must never mask the original LLM error.
      // In service mode (`this.storage` set) we never took a local backup,
      // so `bm` is undefined and we skip restore — the storage backend
      // owns its own snapshot/restore semantics.
      if (bm) {
        try {
          const result = await bm.restoreLatestDirectory("scene_blocks", sceneBlocksDir);
          if (result.restored) {
            this.logger?.warn(`${this.tag} extract() restored scene_blocks/ from backup: ${result.from}`);
          } else {
            this.logger?.debug?.(`${this.tag} extract() no scene_blocks backup to restore from (first run or empty)`);
          }
        } catch (restoreErr) {
          const rMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          this.logger?.warn(`【P1】${this.tag} extract() restore failed (non-fatal, original LLM error preserved): ${rMsg}`);
        }
      }

      return { memoriesProcessed: 0, success: false, error: errMsg };
    }

    // Phase 4.5: Enforce the per-scene byte budget.
    //
    // The prompt asks the LLM to compact oversized scenes, but that is only
    // advisory. Here we make it binding: any scene that was already at/over
    // the limit and came back *larger* is rolled back to its previous content.
    // This runs before soft-delete cleanup and index sync so that reverted
    // files are indexed with their restored content.
    const sizeGuardStartMs = Date.now();
    const revertedScenes = await this.enforceSceneSizeLimit(preExtractSnapshots);
    if (revertedScenes.length > 0) {
      this.logger?.warn(
        `${this.tag} extract() size guard reverted ${revertedScenes.length} oversized scene update(s) ` +
        `in ${Date.now() - sizeGuardStartMs}ms: ${revertedScenes.join(", ")}`,
      );
    }

    // Phase 5: Subsequent processing — safe cleanup of soft-deleted files
    //
    // Security: The LLM has no `exec` tool and cannot run shell commands.
    // Instead, it "deletes" files by writing the marker `[DELETED]` to the file
    // (writing empty/whitespace-only content is rejected by core's write tool
    // parameter validation). Here we detect and remove those soft-deleted files
    // before syncing the index, so syncSceneIndex won't re-index stale entries.
    //
    // We also detect "META-only" files — files that contain only a META header
    // (e.g. [ARCHIVE] or [CONSOLIDATED] markers) but no actual scene content.
    // These are artifacts of LLM merges that didn't properly delete old files.
    const cleanupStartMs = Date.now();
    let cleanedCount = 0;
    // Template mode: post-write format check on files touched by this run (warn only).
    const templateCtx = resolveTemplateContext(this.memoryPrompt);
    const changedByThisRun = (file: string, raw: string): boolean =>
      preExtractSnapshots.get(file)?.sha256 !== createHash("sha256").update(raw).digest("hex");
    try {
      let allFiles: string[];
      if (this.storage) {
        allFiles = await this.storage.readdirNames(StoragePaths.sceneBlocksDir, ".md");
      } else {
        const fs = await import("node:fs/promises");
        allFiles = (await fs.default.readdir(sceneBlocksDir)).filter((f: string) => f.endsWith(".md"));
      }
      for (const file of allFiles) {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${file}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", file), "utf-8");
        }
        if (!raw || raw.trim().length === 0 || raw.trim() === "[DELETED]") {
          // Empty file or [DELETED] marker — soft-delete
          if (this.storage) {
            await this.storage.unlink(`${StoragePaths.sceneBlocksDir}${file}`);
          } else {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            await fs.default.unlink(path.default.join(this.dataDir, "scene_blocks", file));
          }
          cleanedCount++;
          this.logger?.debug?.(`${this.tag} extract() removed soft-deleted file: ${file}`);
        } else {
          // Check if file has only META header but no actual content
          const block = parseSceneBlock(raw, file);
          if (!block.content || block.content.trim().length === 0) {
            if (this.storage) {
              await this.storage.unlink(`${StoragePaths.sceneBlocksDir}${file}`);
            } else {
              const fs = await import("node:fs/promises");
              const path = await import("node:path");
              await fs.default.unlink(path.default.join(this.dataDir, "scene_blocks", file));
            }
            cleanedCount++;
            this.logger?.debug?.(`${this.tag} extract() removed META-only file (no content): ${file}`);
          } else if (templateCtx && changedByThisRun(file, raw)) {
            this.reportTemplateViolations(file, raw, templateCtx.prompt);
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue to index sync
      this.logger?.warn(`【P1】${this.tag} extract() soft-delete cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    this.logger?.debug?.(`${this.tag} extract() soft-delete cleanup: removed ${cleanedCount} empty files (${Date.now() - cleanupStartMs}ms)`);

    // Phase 5b: Normalize filenames (defensive — LLM occasionally produces names
    // with spaces / punctuation despite the prompt forbidding them, e.g.
    // "Daily Rhythm in Shanghai.md". Such names break downstream consumers
    // that parse Markdown navigation refs with `\S+\.md` style regexes
    // (health-checker), shell tools, and URL-encoded path consumers.
    //
    // Renaming here — *before* syncSceneIndex — means scene_index.json and
    // every downstream reader (PersonaGenerator, recall, profile-sync) only
    // ever sees canonical filenames. Idempotent and safe to run repeatedly.
    const normStartMs = Date.now();
    try {
      const normResult = await normalizeSceneFilenames(sceneBlocksDir, this.logger);
      if (normResult.renamed > 0) {
        this.logger?.info(
          `${this.tag} extract() filename normalization: renamed ${normResult.renamed}, skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      } else {
        this.logger?.debug?.(
          `${this.tag} extract() filename normalization: skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      }
    } catch (normErr) {
      // Non-fatal — log and continue. Index sync below will simply pick up
      // whatever names are present on disk.
      this.logger?.warn(`【P1】${this.tag} extract() filename normalization error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
    }

    // Phase 5c: Conversation-time bookkeeping (code-maintained, never by LLM).
    //   - 晚到检测：本批记忆的最新对话时间早于某场景已覆盖的时间，说明是积压
    //     乱序补录的旧信息；若该场景内容被改写，只记录告警 + 计数，不回滚。
    //   - 推进 last_event_time：内容发生变化的场景，更新为 max(原值, 本批最大)。
    const eventTimeResult = await this.applySceneEventTimes(
      preExtractSnapshots, preExtractEventTimes, batchMaxEventTime,
    );
    if (eventTimeResult.lateRewrites.length > 0) {
      this.logger?.warn(
        `${this.tag} extract() late-arriving memories rewrote newer scene(s): ` +
        `batch event_time ${batchMinEventTime} ~ ${batchMaxEventTime}, ` +
        eventTimeResult.lateRewrites.map((r) => `${r.filename}(covered_to=${r.lastEventTime})`).join(", ") +
        " (recorded only, not reverted)",
      );
    }

    // Phase 6: Sync scene index (rebuilds from remaining non-empty files)
    const syncStartMs = Date.now();
    await syncSceneIndex(this.dataDir, this.storage);
    this.logger?.debug?.(`${this.tag} extract() scene index synced: ${Date.now() - syncStartMs}ms`);

    // Phase 7: Update persona.md navigation (GAP-4 fix)
    const navStartMs = Date.now();
    try {
      await this.updateSceneNavigation();
      this.logger?.debug?.(`${this.tag} extract() persona.md navigation updated: ${Date.now() - navStartMs}ms`);
    } catch (navErr) {
      // Non-fatal — log and continue
      this.logger?.warn(`【P1】${this.tag} extract() failed to update persona navigation: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
    }

    // Phase 8: Parse LLM output for out-of-band persona update signal
    if (llmOutput) {
      const signal = parsePersonaUpdateSignal(llmOutput);
      if (signal) {
        await cpManager.setPersonaUpdateRequest(signal.reason);
        this.logger?.debug?.(`${this.tag} extract() persona update requested by LLM: ${signal.reason}`);
      }
    }

    const totalMs = Date.now() - extractStartMs;
    this.logger?.info(`${this.tag} extract() completed: ${memories.length} memories processed in ${totalMs}ms`);

    const sceneDiff = await this.capturePersistedDiff(preExtractSnapshots);
    const resultScenes: Array<{ title: string; summary: string; content: string; status: "created" | "updated" }> = [
      ...sceneDiff.created.map((scene) => ({
        title: scene.filename.replace(/\.md$/, ""),
        summary: scene.summary,
        content: scene.content,
        status: "created" as const,
      })),
      ...sceneDiff.updated
        .filter(({ before, after }) => before.content !== after.content)
        .map(({ after }) => ({
          title: after.filename.replace(/\.md$/, ""),
          summary: after.summary,
          content: after.content,
          status: "updated" as const,
        })),
    ];
    const scenesCreated = sceneDiff.created.length;
    const scenesUpdated = sceneDiff.updated.filter(({ before, after }) => before.content !== after.content).length;
    const scenesDeleted = sceneDiff.deleted.length;

    // ── l2_extraction metric ──
    if (this.instanceId && this.logger) {

      report("l2_extraction", {
        inputMemoryCount: memories.length,
        resultSceneCount: resultScenes.length,
        resultScenes,
        scenesCreated,
        scenesUpdated,
        scenesDeleted,
        llmDurationMs,
        totalDurationMs: totalMs,
        success: true,
        error: null,
      });

      // ── 评测指标：L2 延迟 + 场景变化 ──
      try {
        const postSceneCount = (await readSceneIndex(this.dataDir, this.storage)).length;
        reportL2LatencyMetrics({
          instanceId: this.instanceId ?? "",
          extractionLatencyMs: totalMs,
          llmDurationMs: llmDurationMs > 0 ? llmDurationMs : null,
          sceneCountBefore: preExtractIndex.size,
          sceneCountAfter: postSceneCount,
          scenesCreated,
          scenesUpdated,
          scenesDeleted,
          hasError: false,
        });
      } catch {
        // 静默忽略
      }
    }

    // Detect empty extraction: pre and post scene_index both empty means LLM didn't write anything
    const postIndex = await readSceneIndex(this.dataDir, this.storage);
    const emptyExtraction = preExtractIndex.size === 0 && postIndex.length === 0;
    if (emptyExtraction) {
      this.logger?.warn(`${this.tag} extract() empty extraction detected: LLM produced no file changes`);
    }

    // Preserve the historical enumerable result shape: several callers compare
    // this object structurally. The in-process L2 runner can still read the
    // diagnostic delta, but it is not accidentally serialized as user content.
    const result: ExtractionResult = {
      memoriesProcessed: memories.length,
      success: true,
      emptyExtraction,
      ...(eventTimeResult.lateRewrites.length > 0
        ? { lateArrivalRewrites: eventTimeResult.lateRewrites.map((r) => r.filename) }
        : {}),
    };
    Object.defineProperty(result, "sceneDiff", {
      value: sceneDiff,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return result;
  }

  private async capturePersistedDiff(
    before: Map<string, SceneFileSnapshot>,
  ): Promise<PersistedSceneDiff> {
    const finalIndex = await readSceneIndex(this.dataDir, this.storage);
    const after = new Map<string, SceneFileSnapshot>();
    for (const entry of finalIndex) {
      try {
        let raw: string | null;
        if (this.storage) {
          raw = await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${entry.filename}`);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          raw = await fs.default.readFile(
            path.default.join(this.dataDir, "scene_blocks", entry.filename),
            "utf-8",
          );
        }
        if (!raw) continue;
        const block = parseSceneBlock(raw, entry.filename);
        after.set(entry.filename, snapshotSceneFile(entry.filename, raw, block));
      } catch {
        // A final index entry without a readable file is still visible through afterFiles.
      }
    }

    const created: SceneFileSnapshot[] = [];
    const updated: Array<{ before: SceneFileSnapshot; after: SceneFileSnapshot }> = [];
    const deleted: SceneFileSnapshot[] = [];
    for (const [filename, snapshot] of after) {
      const old = before.get(filename);
      if (!old) created.push(snapshot);
      else if (old.sha256 !== snapshot.sha256) updated.push({ before: old, after: snapshot });
    }
    for (const [filename, snapshot] of before) {
      if (!after.has(filename)) deleted.push(snapshot);
    }
    return {
      beforeFiles: [...before.keys()].sort(),
      afterFiles: finalIndex.map((entry) => entry.filename).sort(),
      created,
      updated,
      deleted,
    };
  }

  /**
   * Build a tiered size warning from the pre-extraction snapshots.
   *
   * Mirrors the scene *count* warning, but on the byte axis. Oversized scenes
   * are listed by name with their actual size so the LLM knows exactly which
   * files must be compacted rather than appended to.
   */
  private buildSceneSizeWarning(snapshots: Map<string, SceneSizeSnapshot>): string | undefined {
    if (snapshots.size === 0) return undefined;

    const limit = this.maxSceneBytes;
    // 80% of budget — early enough that compaction can still happen gracefully.
    const nearLimit = Math.floor(limit * 0.8);

    const over: Array<[string, number]> = [];
    const near: Array<[string, number]> = [];
    for (const [filename, snap] of snapshots) {
      const bytes = Buffer.byteLength(snap.raw, "utf-8");
      if (bytes >= limit) over.push([filename, bytes]);
      else if (bytes >= nearLimit) near.push([filename, bytes]);
    }
    if (over.length === 0 && near.length === 0) return undefined;

    const fmt = (entries: Array<[string, number]>): string => entries
      .sort((a, b) => b[1] - a[1])
      .map(([f, b]) => `  - \`${f}\`（${formatSceneBytes(b)}）`)
      .join("\n");

    const parts: string[] = [];
    if (over.length > 0) {
      parts.push(
        `以下场景**已超过单文件体积上限 ${formatSceneBytes(limit)}**：\n${fmt(over)}\n` +
        `**禁止向这些场景追加任何内容**。本次必须先对它们执行精简（合并重复条目、删除过时内容、压缩冗长表述），` +
        `使体积降到上限以内。若新记忆属于这些场景，请在精简后再写入；精简不得丢失关键事实。`,
      );
      this.logger?.warn(
        `${this.tag} extract() scene size over limit: ${over.length} file(s) exceed ` +
        `${formatSceneBytes(limit)} [${over.map(([f, b]) => `${f}=${formatSceneBytes(b)}`).join(", ")}]`,
      );
    }
    if (near.length > 0) {
      parts.push(
        `以下场景**接近体积上限**（已超过 80%）：\n${fmt(near)}\n` +
        `优先考虑精简或拆分，避免继续膨胀。`,
      );
      this.logger?.debug?.(
        `${this.tag} extract() scene size approaching limit: ${near.length} file(s) over ${formatSceneBytes(nearLimit)}`,
      );
    }
    return parts.join("\n\n");
  }

  /**
   * Maintain META.last_event_time and detect late-arriving rewrites.
   *
   * For every scene whose *content* changed in this run:
   *   - If the whole batch is older than what the scene already covered
   *     (batchMax < last_event_time), the LLM rewrote a newer scene using
   *     older information. We only record it (warn + returned list) — the
   *     content is left as written.
   *   - last_event_time := max(previous, batchMax). It never moves backwards,
   *     so a late batch cannot make a scene look older than it is.
   *
   * Newly created scenes get last_event_time = batchMax. Soft-deleted /
   * removed files are skipped.
   */
  private async applySceneEventTimes(
    before: ReadonlyMap<string, { content: string }>,
    prevEventTimes: ReadonlyMap<string, string>,
    batchMax: string | undefined,
  ): Promise<{ lateRewrites: Array<{ filename: string; lastEventTime: string }>; stamped: string[] }> {
    const lateRewrites: Array<{ filename: string; lastEventTime: string }> = [];
    const stamped: string[] = [];
    if (!batchMax) return { lateRewrites, stamped };

    let files: string[] = [];
    try {
      if (this.storage) {
        files = (await this.storage.readdir(StoragePaths.sceneBlocksDir, ".md"))
          .map((e) => e.key.replace(/^.*\//, ""))
          .filter((f) => f.endsWith(".md"));
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        files = (await fs.default.readdir(path.default.join(this.dataDir, "scene_blocks")))
          .filter((f) => f.endsWith(".md"));
      }
    } catch (err) {
      this.logger?.warn?.(`【P1】${this.tag} extract() event-time bookkeeping skipped (list failed): ${err instanceof Error ? err.message : String(err)}`);
      return { lateRewrites, stamped };
    }

    for (const filename of files) {
      try {
        const raw = await this.readSceneRaw(filename);
        if (!raw || raw.trim() === "[DELETED]") continue;
        const block = parseSceneBlock(raw, filename);
        const prev = before.get(filename);
        if (prev && prev.content === block.content) continue; // 内容未变，不推进

        const prevTime = prevEventTimes.get(filename) ?? block.meta.last_event_time;
        if (prev && prevTime && batchMax < prevTime) {
          lateRewrites.push({ filename, lastEventTime: prevTime });
          this.lateArrivalRewrites++;
        }
        const next = !prevTime || batchMax > prevTime ? batchMax : prevTime;
        if (block.meta.last_event_time === next) continue;

        const updated = formatSceneBlock({ ...block.meta, last_event_time: next }, block.content);
        if (this.storage) {
          await this.storage.writeFile(`${StoragePaths.sceneBlocksDir}${filename}`, updated);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          await fs.default.writeFile(path.default.join(this.dataDir, "scene_blocks", filename), updated, "utf-8");
        }
        stamped.push(filename);
      } catch (err) {
        this.logger?.warn?.(
          `【P1】${this.tag} extract() event-time bookkeeping failed for "${filename}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { lateRewrites, stamped };
  }

  /** Template mode: log + report format violations for a scene written by this run. Never mutates content. */
  private reportTemplateViolations(file: string, raw: string, templatePrompt: string): void {
    try {
      const check = checkTemplateOutput({ layer: "l2", content: raw, templatePrompt, maxChars: L2_TEMPLATE_MAX_CHARS });
      if (check.violations.length === 0) return;
      this.logger?.warn(
        `${this.tag} template output violation: file=${file} memory_prompt_id=${this.memoryPrompt?.memory_prompt_id} ` +
        `version=${this.memoryPrompt?.version} reasons=${check.violations.join(",")} chars=${check.chars}` +
        (check.unknownHeadings.length ? ` unknown_headings=${JSON.stringify(check.unknownHeadings)}` : ""),
      );
      for (const reason of check.violations) {
        report("memory_prompt_template_violation", {
          layer: "l2",
          reason,
          file,
          chars: check.chars,
          memoryPromptId: this.memoryPrompt?.memory_prompt_id,
          memoryPromptVersion: this.memoryPrompt?.version,
          instanceId: this.instanceId,
        });
      }
    } catch { /* never block business logic */ }
  }

  /** Read a scene file's raw content (storage adapter or local fs); null if missing. */
  private async readSceneRaw(filename: string): Promise<string | null> {
    try {
      if (this.storage) {
        return await this.storage.readFile(`${StoragePaths.sceneBlocksDir}${filename}`);
      }
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      return await fs.default.readFile(path.default.join(this.dataDir, "scene_blocks", filename), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write-back guard: revert updates that grow an already-oversized scene.
   *
   * The prompt instructs the LLM to compact oversized scenes, but prompts are
   * advisory. This enforces the budget: if a scene was already at/over the
   * limit and the LLM made it *larger*, the previous content is restored so a
   * single misbehaving extraction cannot push a file further out of bounds.
   *
   * Shrinking an oversized scene is always allowed (that is the desired
   * compaction), and scenes within budget are never touched.
   *
   * @returns filenames whose content was reverted.
   */
  private async enforceSceneSizeLimit(
    snapshots: Map<string, SceneSizeSnapshot>,
  ): Promise<string[]> {
    const reverted: string[] = [];

    // 先判断本轮是否发生了 MERGE / 删除：若任一原有场景被软删除或消失，
    // 其内容很可能已被合并进某个超限场景。此时回滚该超限场景会让被删场景的
    // 内容彻底丢失，因此整轮跳过回滚（只记录告警），保证数据不丢。
    let mergeOrDeleteDetected = false;
    for (const filename of snapshots.keys()) {
      const current = await this.readSceneRaw(filename);
      if (current === null || current.trim() === "[DELETED]") {
        mergeOrDeleteDetected = true;
        break;
      }
    }

    for (const [filename, snap] of snapshots) {
      const beforeBytes = Buffer.byteLength(snap.raw, "utf-8");
      // Only guard scenes that were already at/over budget before this run.
      if (beforeBytes < this.maxSceneBytes) continue;

      const relPath = `${StoragePaths.sceneBlocksDir}${filename}`;
      try {
        const raw = await this.readSceneRaw(filename);
        if (!raw) continue;

        // Soft-deleted files are a legitimate shrink path — never revert them.
        if (raw.trim() === "[DELETED]") continue;

        const afterBytes = Buffer.byteLength(raw, "utf-8");
        if (afterBytes <= beforeBytes) continue; // compacted or unchanged — good

        if (mergeOrDeleteDetected) {
          this.logger?.warn(
            `${this.tag} extract() scene size limit exceeded by "${filename}" ` +
            `(${formatSceneBytes(beforeBytes)} → ${formatSceneBytes(afterBytes)}), ` +
            `but a scene was merged/deleted in this run; keeping content to avoid data loss`,
          );
          continue;
        }

        const block = parseSceneBlock(raw, filename);
        const restored = formatSceneBlock(block.meta, snap.content);
        if (this.storage) {
          await this.storage.writeFile(relPath, restored);
        } else {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          await fs.default.writeFile(
            path.default.join(this.dataDir, "scene_blocks", filename), restored, "utf-8",
          );
        }

        reverted.push(filename);
        this.logger?.warn(
          `${this.tag} extract() scene size limit enforced: reverted growth of "${filename}" ` +
          `(${formatSceneBytes(beforeBytes)} → ${formatSceneBytes(afterBytes)}, ` +
          `limit ${formatSceneBytes(this.maxSceneBytes)}); content restored`,
        );
      } catch (err) {
        this.logger?.warn(
          `【P1】${this.tag} extract() scene size check failed for "${filename}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return reverted;
  }

  /**
   * Build human-readable scene summaries for the prompt,
   * and collect the list of existing scene filenames (relative).
   *
   * Includes a capacity counter at the top (e.g. "当前场景总数：5 / 15")
   * so the LLM can immediately see how close it is to the limit.
   */
  private buildSceneSummaries(
    index: SceneIndexEntry[],
    lastEventTimes: ReadonlyMap<string, string> = new Map(),
  ): { summaries: string; filenames: string[] } {
    if (index.length === 0) return { summaries: "", filenames: [] };

    const lines: string[] = [];
    const filenames: string[] = [];

    // Inject capacity counter at the top — LLM sees this first
    lines.push(`**当前场景总数：${index.length} / ${this.maxScenes}**`);
    lines.push("");

    for (const entry of index) {
      filenames.push(entry.filename);
      lines.push(`### ${entry.filename}`);
      const lastEvent = lastEventTimes.get(entry.filename);
      lines.push(
        `**热度**: ${entry.heat} | **更新**: ${entry.updated}` +
        (lastEvent ? ` | **已覆盖对话至**: ${lastEvent}` : ""),
      );
      lines.push(`**summary**: ${entry.summary}`);
      lines.push("");
    }
    return { summaries: lines.join("\n"), filenames };
  }

  /**
   * Update the scene navigation section at the end of persona.md.
   *
   * Reads the current scene index, generates the navigation block, then
   * strips any existing navigation from persona.md and appends the new one.
   *
   * IMPORTANT: If the persona body is empty (PersonaGenerator hasn't run yet),
   * we skip writing to avoid creating a persona.md that only contains the
   * scene navigation. PersonaGenerator.generate() will write the full
   * persona + navigation when it runs.
   */
  private async updateSceneNavigation(): Promise<void> {
    const index = await readSceneIndex(this.dataDir, this.storage);
    const nav = generateSceneNavigation(index);

    let existing = "";
    try {
      if (this.storage) {
        existing = (await this.storage.readFile(StoragePaths.persona)) ?? "";
      } else {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        existing = await fs.default.readFile(path.default.join(this.dataDir, "persona.md"), "utf-8");
      }
    } catch {
      // No persona file yet — PersonaGenerator will create it with navigation.
      // Don't write a navigation-only file.
      this.logger?.debug?.(`${this.tag} updateSceneNavigation() skipped: no persona file yet, waiting for PersonaGenerator`);
      return;
    }

    if (!existing.trim() && !nav) return;

    const stripped = stripSceneNavigation(existing).trimEnd();

    // If the persona body is empty (only navigation existed), don't overwrite
    // with a navigation-only file. Let PersonaGenerator handle full generation.
    if (!stripped) {
      this.logger?.debug?.(`${this.tag} updateSceneNavigation() skipped: persona body is empty, waiting for PersonaGenerator`);
      return;
    }

    const updated = nav ? `${stripped}\n\n${nav}\n` : `${stripped}\n`;

    if (this.storage) {
      await this.storage.writeFile(StoragePaths.persona, updated);
    } else {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      await fs.default.writeFile(path.default.join(this.dataDir, "persona.md"), updated, "utf-8");
    }
  }
}

function snapshotSceneFile(
  filename: string,
  raw: string,
  block: ReturnType<typeof parseSceneBlock>,
): SceneFileSnapshot {
  return {
    filename,
    sha256: createHash("sha256").update(raw).digest("hex"),
    chars: raw.length,
    parseable: block.meta.created.length > 0 || block.meta.updated.length > 0,
    created: block.meta.created,
    updated: block.meta.updated,
    summary: block.meta.summary,
    heat: block.meta.heat,
    content: block.content,
    raw,
  };
}

function formatTimestamp(d: Date): string {
  return d.toISOString();
}
