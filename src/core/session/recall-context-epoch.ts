import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateSceneNavigation, stripSceneNavigation } from "../scene/scene-navigation.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [recall-context]";

const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

当上方注入的记忆片段不足以回答用户问题时，可主动调用以下工具获取更多信息：

- **tdai_memory_search**：搜索结构化记忆（L1），适用于回忆用户偏好、历史事件节点、规则等关键信息。
- **tdai_conversation_search**：搜索原始对话（L0），适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（Scene Navigation 中的路径）：当已定位到相关情境，且需要该场景的完整画像、事件经过或阶段结论时使用。

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_search 和 tdai_conversation_search **合计最多调用 3 次**。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 3 次。
- 若 3 次搜索后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`;

const MEMORY_EPOCH_PROTOCOL = `<memory-epoch-protocol>
User turns may begin with a tdai-memory-epoch HTML comment. Treat it as an append-only memory registry update: register adds immutable memory content, focus lists the IDs relevant to this turn, and checkpoint replaces the registry after compaction. Use focused memories for the current answer. Registered but unfocused entries remain in history so later focus changes can refer to their IDs without repeating their content. A sealed event clears focus when the epoch reaches its token budget. If the current turn also contains a relevant-memories XML block, those ephemeral memories replace registry focus for that turn only.
</memory-epoch-protocol>`;

export interface StableRecallSnapshot {
  text: string;
  hash: string;
  persona: string | null;
}

export interface RecallContextEpochBinding {
  epoch: number;
  snapshot: StableRecallSnapshot;
}

/**
 * Owns the stable prompt bytes for the current cache epoch.
 *
 * The snapshot is rebuilt only after the memory pipeline explicitly publishes
 * a persona or scene-index change. Per-turn L1 recall is intentionally absent:
 * it remains a fresh delta at the tail of each request.
 */
export class RecallContextEpoch {
  private epoch = 1;
  private pending?: { epoch: number; snapshot: Promise<StableRecallSnapshot> };

  constructor(
    private readonly dataDir: string,
    private readonly logger?: Logger,
  ) {}

  async resolve(): Promise<RecallContextEpochBinding> {
    while (true) {
      const epoch = this.epoch;
      if (!this.pending || this.pending.epoch !== epoch) {
        this.pending = { epoch, snapshot: this.loadSnapshot(epoch) };
      }
      const snapshot = await this.pending.snapshot;
      if (epoch === this.epoch) return { epoch, snapshot };
    }
  }

  publishStableContextChange(source: "persona" | "scene-navigation"): void {
    this.epoch += 1;
    this.pending = undefined;
    this.logger?.info(`${TAG} cache epoch advanced to ${this.epoch}: ${source} updated`);
  }

  protected async loadSnapshot(epoch: number): Promise<StableRecallSnapshot> {
    let persona: string | null = null;
    try {
      const raw = await fs.readFile(path.join(this.dataDir, "persona.md"), "utf-8");
      persona = stripSceneNavigation(raw).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const sceneIndex = await readSceneIndex(this.dataDir);
    const sceneNavigation = generateSceneNavigation(sceneIndex, this.dataDir);
    const sections: string[] = [];
    if (persona) sections.push(`<user-persona>\n${persona}\n</user-persona>`);
    if (sceneNavigation) {
      sections.push(`<scene-navigation>\n${sceneNavigation}\n</scene-navigation>`);
    }
    sections.push(MEMORY_EPOCH_PROTOCOL);
    sections.push(MEMORY_TOOLS_GUIDE);

    const text = sections.join("\n\n");
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    this.logger?.debug?.(
      `${TAG} built epoch ${epoch} snapshot: hash=${hash}, chars=${text.length}`,
    );
    return { text, hash, persona };
  }
}
