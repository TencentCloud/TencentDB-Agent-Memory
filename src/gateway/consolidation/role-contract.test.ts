/**
 * tz-01 Ф2 — the single role-contract resolver.
 *
 * Covers criteria 2 (prompt_file), 4 (caps/ops_subset/critic_role passed
 * through unchanged), the `fail-closed-role` invariant, the LegacyRoleAdapter
 * tiers, and the ≤5 ms resolve NFR with mtime invalidation.
 * Criteria 1/3 (model and tools reaching the actual spawn) are integration
 * level and live in characterization.test.ts / orchestrator.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRoleContract,
  listRoleContracts,
  clearRoleContractCache,
} from "./role-contract.js";
import type { RoleLegacyDefaults } from "./role-contract-types.js";

const LEGACY: RoleLegacyDefaults = {
  failOpenPromptRoles: ["memory-keeper"],
  model: "legacy/global-model",
  thinking: "legacy-thinking",
  timeoutMs: 600_000,
  diffCap: 20,
  diffByteCap: 8192,
  night: {
    diffCap: 200,
    diffByteCap: 32_768,
    deleteCapPerRun: 50,
    rewriteCapPerRun: 100,
    maxRunMs: 5_400_000,
  },
};

function fullContract(overrides: Record<string, unknown> = {}) {
  return {
    name: "role-a",
    model: "prov/model-a",
    prompt_file: "role-a.md",
    enabled: true,
    thinking: "high",
    timeout_min: 7,
    scope: "fresh_tail",
    trigger: "threshold",
    schedule: null,
    threshold: 42,
    idsOnly: false,
    diff_cap: 11,
    diff_byte_cap: 2048,
    ops_subset: ["deleteL1", "merge"],
    tools_subset: ["fetch_dups.py"],
    caps: { delete_per_run: 3, rewrite_per_run: 4 },
    max_run_ms: 111_000,
    fail_on_missing_prompt: true,
    critic_role: "role-a-critic",
    ...overrides,
  };
}

describe("role-contract resolver (tz-01 B1)", () => {
  let tmp: string;
  let roleDir: string;

  beforeEach(() => {
    clearRoleContractCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rc-"));
    roleDir = path.join(tmp, "roles");
    fs.mkdirSync(roleDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeRole(
    role: string,
    cfg: unknown | null,
    files: Record<string, string> = {},
  ): void {
    const dir = path.join(roleDir, role);
    fs.mkdirSync(dir, { recursive: true });
    if (cfg !== null) {
      fs.writeFileSync(
        path.join(dir, "role.json"),
        typeof cfg === "string" ? cfg : JSON.stringify(cfg),
      );
    }
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
  }

  it("a complete contract is used verbatim — nothing inferred (criterion 4)", () => {
    writeRole("role-a", fullContract(), { "role-a.md": "PROMPT-A" });
    const res = resolveRoleContract("role-a", roleDir, LEGACY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.contract;
    expect(c.source).toBe("contract");
    expect(c.warnings).toEqual([]);
    // Passed through untouched — this is what tz-09 will enforce later.
    expect([...c.policy.opsSubset].sort()).toEqual(["deleteL1", "merge"]);
    expect(c.policy.caps).toEqual({ deletePerRun: 3, rewritePerRun: 4 });
    expect(c.criticRole).toBe("role-a-critic");
    expect(c.policy.maxRunMs).toBe(111_000);
    // Binding: fixed launcher + provider derived from the model string.
    expect(c.binding).toEqual({
      launcherId: "pi",
      provider: "prov",
      model: "prov/model-a",
      thinking: "high",
      authProfileRef: null,
      isolationProfileRef: null,
    });
    expect(c.timeoutMs).toBe(7 * 60_000);
    expect(c.batching.diffCap).toBe(11);
    expect(c.prompt.text).toBe("PROMPT-A");
    // Nothing came from the global snapshot.
    expect(JSON.stringify(c)).not.toContain("legacy/global-model");
  });

  it("strategy comes from scope, never from the role name (B2)", () => {
    writeRole(
      "night-keeper",
      fullContract({ name: "night-keeper", scope: "fresh_tail" }),
      {
        "role-a.md": "P",
      },
    );
    writeRole(
      "brand-new-role",
      fullContract({ name: "brand-new-role", scope: "full_store" }),
      {
        "role-a.md": "P",
      },
    );
    const night = resolveRoleContract("night-keeper", roleDir, LEGACY);
    const other = resolveRoleContract("brand-new-role", roleDir, LEGACY);
    expect(night.ok && night.contract.batching.strategy).toBe(
      "fresh-tail-single-batch",
    );
    expect(other.ok && other.contract.batching.strategy).toBe(
      "bounded-full-store-chunked",
    );
  });

  it("fail-closed: broken JSON, unknown field and bad type disable WITH a reason", () => {
    writeRole("broken", "{not json");
    writeRole("unknown-field", fullContract({ surprise: 1 }));
    writeRole("bad-type", fullContract({ timeout_min: "seven" }));

    const broken = resolveRoleContract("broken", roleDir, LEGACY);
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.reason).toMatch(/not valid JSON/);

    const unknown = resolveRoleContract("unknown-field", roleDir, LEGACY);
    expect(!unknown.ok && unknown.reason).toMatch(/unknown field "surprise"/);

    const badType = resolveRoleContract("bad-type", roleDir, LEGACY);
    expect(!badType.ok && badType.reason).toMatch(/"timeout_min"/);
  });

  it("fail-closed: missing prompt under fail_on_missing_prompt (criterion 2)", () => {
    writeRole("no-prompt", fullContract({ fail_on_missing_prompt: true }));
    const res = resolveRoleContract("no-prompt", roleDir, LEGACY);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/prompt "role-a.md" not found/);
  });

  it("prompt_file wins; a fallback to prompt.md is reported, not silent", () => {
    writeRole("marked", fullContract({ prompt_file: "custom/../own.md" }), {
      "own.md": "MARKER-XYZ",
      "prompt.md": "CANONICAL",
    });
    const res = resolveRoleContract("marked", roleDir, LEGACY);
    expect(res.ok && res.contract.prompt.text).toBe("MARKER-XYZ");

    writeRole(
      "fallback",
      fullContract({ prompt_file: "absent.md", fail_on_missing_prompt: false }),
      { "prompt.md": "CANONICAL" },
    );
    const fb = resolveRoleContract("fallback", roleDir, LEGACY);
    expect(fb.ok && fb.contract.prompt.text).toBe("CANONICAL");
    expect(fb.ok && fb.contract.warnings.join(" ")).toMatch(
      /prompt_file "absent.md" not found/,
    );
  });

  it("legacy-partial: gaps filled from the global snapshot, each with a warning", () => {
    writeRole(
      "legacy-min",
      { name: "legacy-min", timeout_min: 45 },
      {
        "legacy-min.md": "P",
      },
    );
    const res = resolveRoleContract("legacy-min", roleDir, LEGACY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contract.source).toBe("legacy-partial");
    expect(res.contract.binding.model).toBe("legacy/global-model");
    expect(res.contract.timeoutMs).toBe(45 * 60_000);
    // No `scope` → single-batch default, and it is announced.
    expect(res.contract.batching.strategy).toBe("fresh-tail-single-batch");
    expect(res.contract.warnings.join("\n")).toMatch(/"scope" absent/);
    expect(res.contract.warnings.join("\n")).toMatch(/"model" taken from/);
  });

  it("legacy-absent: no role.json at all still resolves, marked as such", () => {
    writeRole("bare", null, { "bare.md": "P" });
    const res = resolveRoleContract("bare", roleDir, LEGACY);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contract.source).toBe("legacy-absent");
    expect(res.contract.binding.model).toBe("legacy/global-model");
    expect(res.contract.batching.strategy).toBe("fresh-tail-single-batch");
  });

  it("retry budget is finite: default when absent, contract value when set", () => {
    writeRole("no-budget", fullContract(), { "role-a.md": "P" });
    writeRole("budget", fullContract({ retry_budget: 5 }), {
      "role-a.md": "P",
    });
    const a = resolveRoleContract("no-budget", roleDir, LEGACY);
    const b = resolveRoleContract("budget", roleDir, LEGACY);
    expect(a.ok && a.contract.policy.retryBudget).toBe(2);
    expect(b.ok && b.contract.policy.retryBudget).toBe(5);
  });

  it("contractHash changes with the binding and is stable otherwise", () => {
    writeRole("h", fullContract(), { "role-a.md": "P" });
    const first = resolveRoleContract("h", roleDir, LEGACY);
    clearRoleContractCache();
    const again = resolveRoleContract("h", roleDir, LEGACY);
    expect(first.ok && again.ok && first.contract.contractHash).toBe(
      again.ok ? again.contract.contractHash : "",
    );
    writeRole("h2", fullContract({ model: "prov/other" }), {
      "role-a.md": "P",
    });
    const other = resolveRoleContract("h2", roleDir, LEGACY);
    expect(other.ok && other.contract.contractHash).not.toBe(
      first.ok ? first.contract.contractHash : "",
    );
  });

  it("listRoleContracts keeps disabled roles visible (S5 observability)", () => {
    writeRole("good", fullContract(), { "role-a.md": "P" });
    writeRole("bad", "{not json");
    const all = listRoleContracts(roleDir, LEGACY);
    expect(all.map((r) => (r.ok ? r.contract.role : r.role)).sort()).toEqual([
      "bad",
      "good",
    ]);
    const bad = all.find((r) => !r.ok);
    expect(bad && !bad.ok && bad.reason).toMatch(/not valid JSON/);
  });

  it("resolve cache: warm resolves are ≤5 ms and mtime invalidates them", () => {
    writeRole("cached", fullContract(), { "role-a.md": "P1" });
    resolveRoleContract("cached", roleDir, LEGACY); // cold
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      resolveRoleContract("cached", roleDir, LEGACY);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    expect(timings[Math.floor(timings.length / 2)]!).toBeLessThan(5);

    // Editing the prompt must be observed (mtime+size stamp).
    fs.writeFileSync(path.join(roleDir, "cached", "role-a.md"), "P2-longer");
    const after = resolveRoleContract("cached", roleDir, LEGACY);
    expect(after.ok && after.contract.prompt.text).toBe("P2-longer");
  });
});

describe("cache invalidation of a fail-closed role", () => {
  it("adding the missing prompt re-enables the role without a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-rc-reopen-"));
    fs.mkdirSync(path.join(dir, "role-a"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "role-a", "role.json"),
      JSON.stringify(fullContract({ fail_on_missing_prompt: true })),
      "utf-8",
    );
    // No prompt yet → fail-closed, and that verdict is cached.
    const first = resolveRoleContract("role-a", dir, LEGACY);
    expect(first.ok).toBe(false);
    expect(resolveRoleContract("role-a", dir, LEGACY).ok).toBe(false);

    // The operator adds the prompt the contract asked for.
    fs.writeFileSync(path.join(dir, "role-a", "role-a.md"), "PROMPT", "utf-8");
    const after = resolveRoleContract("role-a", dir, LEGACY);
    expect(after.ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
