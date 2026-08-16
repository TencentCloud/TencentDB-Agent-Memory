/**
 * An apply may not erase content — and refusing the op that would erase it
 * may not cost the diff its valid work.
 *
 * Regression for a live data loss (run b9bd7db4, 2026-08-15): memory-keeper
 * returned `"rewritePersona": ""`, apply wrote it through, and the user's
 * persona.md became a 0-byte file. The floor therefore lives in validation,
 * which runs in every gate mode.
 *
 * The floor is PER-OPERATION (tz-#5). Its first shape refused the whole
 * request, which meant a night batch that emitted one blank persona also lost
 * its valid deleteL1/merge ops — the same blast radius as the `rewritePersona:
 * null` defect it was meant to fix. So each case here asserts both halves: the
 * blank op is refused with a reason, and the good op next to it survives.
 *
 * `merge` is the worst case and is covered too: blank content overwrites the
 * target and then deletes the rest of the cluster, so one empty string turns a
 * de-duplication into a net loss. dedup-daily's ops_subset is exactly
 * ["deleteL1", "merge"], i.e. the role most likely to reach it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { screenDiff } from "./validate.js";
import type {
  ApplyExecutorDeps,
  ParsedApplyRequest,
  RejectedOp,
} from "./types.js";

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";
const SCENE = "scene_blocks/x/y.md";
const BLOCK_BODY = `${META_START}\ncreated: 1\n${META_END}\ntext`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-blank-"));
const deps = { dataDir } as ApplyExecutorDeps;

/** One request with everything the screen needs to reach the rewrite checks. */
function request(diff: ParsedApplyRequest["diff"]): ParsedApplyRequest {
  return {
    diff,
    context: { presentedRecordIds: ["m_1", "m_2"] },
    manifest: { baseline: { "persona.md": "d1", [SCENE]: "d2" } },
  } as ParsedApplyRequest;
}

/** The surviving diff plus the refusals it produced. */
async function screen(diff: ParsedApplyRequest["diff"]): Promise<{
  kept: Awaited<ReturnType<typeof screenDiff>>;
  rejected: RejectedOp[];
}> {
  const rejected: RejectedOp[] = [];
  const kept = await screenDiff(deps, request(diff), rejected);
  return { kept, rejected };
}

describe("an apply may not erase content", () => {
  it("refuses a blank merge — it would wipe the target and delete the cluster", async () => {
    const { kept, rejected } = await screen({
      merge: [{ cluster: ["m_1", "m_2"], target: "m_1", content: "   " }],
    });
    expect(kept.merge).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.section).toBe("merge");
    expect(rejected[0]!.ref).toBe("m_1");
    expect(rejected[0]!.reason).toMatch(/content is blank/);
  });

  it("refuses an empty persona", async () => {
    const { kept, rejected } = await screen({ rewritePersona: "" });
    expect(kept.rewritePersona).toBeUndefined();
    expect(rejected[0]!.section).toBe("rewritePersona");
  });

  it("refuses a whitespace-only persona (blank is not content)", async () => {
    const { kept, rejected } = await screen({ rewritePersona: "  \n\t " });
    expect(kept.rewritePersona).toBeUndefined();
    expect(rejected[0]!.reason).toMatch(/content is blank/);
  });

  it("refuses a blank scene block", async () => {
    const { kept, rejected } = await screen({
      rewriteBlock: [{ path: SCENE, content: "" }],
    });
    expect(kept.rewriteBlock).toBeUndefined();
    expect(rejected[0]!.reason).toMatch(/content is blank/);
  });

  it("refuses a blank record", async () => {
    const { kept, rejected } = await screen({
      rewriteRecord: [{ id: "m_1", updatedAt: "2026-08-15", content: "" }],
    });
    expect(kept.rewriteRecord).toBeUndefined();
    expect(rejected[0]!.reason).toMatch(/content is blank/);
  });

  it("still accepts real content", async () => {
    const { kept, rejected } = await screen({
      rewritePersona: "# Persona\nreal body",
      rewriteBlock: [{ path: SCENE, content: BLOCK_BODY }],
    });
    expect(rejected).toEqual([]);
    expect(kept.rewritePersona).toBe("# Persona\nreal body");
    expect(kept.rewriteBlock).toHaveLength(1);
  });

  // The point of the per-op shape: b9bd7db4's blank persona rode along with a
  // batch of real work, and that work must survive its refusal.
  it("keeps the valid ops standing next to the blank one", async () => {
    const { kept, rejected } = await screen({
      rewritePersona: "",
      deleteL1: [{ id: "m_1", updatedAt: "2026-08-15" }],
      rewriteBlock: [{ path: SCENE, content: BLOCK_BODY }],
    });
    expect(kept.rewritePersona).toBeUndefined();
    expect(kept.deleteL1).toHaveLength(1);
    expect(kept.rewriteBlock).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.section).toBe("rewritePersona");
  });

  // A blank merge is refused, so its members are never folded into the target —
  // and a delete of one of them would then drop content that went nowhere.
  it("takes the delete of a member down with a refused merge", async () => {
    const { kept, rejected } = await screen({
      merge: [{ cluster: ["m_1", "m_2"], target: "m_1", content: "" }],
      deleteL1: [{ id: "m_2", updatedAt: "2026-08-15" }],
    });
    expect(kept.merge).toBeUndefined();
    expect(kept.deleteL1).toBeUndefined();
    expect(rejected.map((r) => r.section).sort()).toEqual([
      "deleteL1",
      "merge",
    ]);
  });
});
