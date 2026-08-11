/**
 * tz-07 criterion 1 as a GUARD, not as a one-off grep.
 *
 * The script is the single source of the regexp; this test and the CI job both
 * call it. The last case is the one that matters: the script's exit code
 * proves the regexp, it does NOT prove that CI ever runs it — so the workflow
 * is asserted too. Remove the step from pr-ci.yml and this goes red.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const script = path.join(repo, "scripts", "check-no-pi-hardcode.sh");

describe("no-pi-path-hardcode", () => {
  it("the tree holds no hardcoded host paths", () => {
    // Falsification: write `~/.pi/agent` into any src/*.ts and this fails with
    // the offending line printed.
    const out = execFileSync("bash", [script], { encoding: "utf-8" });
    expect(out).toContain("ok:");
  });

  it("the allowlist has exactly one entry", () => {
    // An allowlist is a hole; a hole with one auditable entry is the price of
    // building the fallback at all. Two entries means the next site slipped in.
    const body = fs.readFileSync(script, "utf-8");
    const line = body
      .split("\n")
      .find((l) => l.startsWith("ALLOWLIST="))
      ?.replace(/^ALLOWLIST=/, "")
      .replace(/"/g, "");
    expect(line?.split(/\s+/).filter(Boolean)).toEqual([
      "src/gateway/tdai-root.ts",
    ]);
  });

  it("CI actually runs the check", () => {
    const wf = fs.readFileSync(
      path.join(repo, ".github", "workflows", "pr-ci.yml"),
      "utf-8",
    );
    expect(wf).toContain("scripts/check-no-pi-hardcode.sh");
    expect(wf).toMatch(/^\s{2}guards:$/m);
  });
});
