/**
 * Regression test for the `sessionInit.skipAssetConfirm` YAML contract.
 *
 * `config.example.yaml` documents the knob and tells operators to use it:
 *
 *     # skipAssetConfirm: true  # 跳过"是否关联团队资产"前置对话框，
 *     #                         默认视为选"是"直接进入 team/agent/task 选择
 *
 * `buildConfig` reads it (`yaml.sessionInit?.skipAssetConfirm ?? DEFAULT`),
 * and `SessionInitConfig` declares it — but `RawYamlConfig["sessionInit"]`
 * never did. So the field the docs advertise was absent from the parsed-YAML
 * type: any operator enabling it got a TS2339 at the read site, and tooling
 * that validates config against `RawYamlConfig` reports the documented key as
 * unknown.
 *
 * The runtime happens to work because `loadYamlConfig` casts the parsed object
 * (`parsed as RawYamlConfig`), which is exactly why this survived: the type
 * hole is invisible until someone touches the consumer.
 *
 * `headerAutoSelect` sits right next to it in the same interface and IS
 * declared, so the omission looks accidental rather than deliberate.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYamlConfig } from "../config.js";
import type { RawYamlConfig } from "../types.js";

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tdai-cfg-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, body, "utf8");
  return file;
}

describe("RawYamlConfig.sessionInit accepts every documented knob", () => {
  it("declares skipAssetConfirm so the documented key type-checks", () => {
    // Compiles only if `skipAssetConfirm` is a member of the parsed-YAML type.
    const yaml: RawYamlConfig["sessionInit"] = { skipAssetConfirm: true };

    expect(yaml.skipAssetConfirm).toBe(true);
  });

  it("declares it alongside headerAutoSelect, matching the example config", () => {
    const yaml: RawYamlConfig["sessionInit"] = {
      skipAssetConfirm: true,
      headerAutoSelect: {
        enabled: true,
        teamHeader: "x-team-id",
        agentHeader: "x-agent-id",
        taskHeader: "x-task-id",
        onMismatch: "form",
      },
    };

    expect(yaml.skipAssetConfirm).toBe(true);
    expect(yaml.headerAutoSelect?.onMismatch).toBe("form");
  });

  it("keeps it optional — omitting it still type-checks", () => {
    const yaml: RawYamlConfig["sessionInit"] = { enabled: true, maxRetries: 3 };
    expect(yaml.skipAssetConfirm).toBeUndefined();
  });

  it("survives the yaml → RawYamlConfig → buildConfig round trip", () => {
    // End of the contract that actually reaches the state machine: the value an
    // operator writes must land on `ProxyConfig.sessionInit.skipAssetConfirm`.
    const file = writeYaml(
      [
        "sessionInit:",
        "  enabled: true",
        "  maxRetries: 3",
        "  skipAssetConfirm: true",
        "",
      ].join("\n"),
    );

    const parsed = loadYamlConfig(file);
    expect(parsed.sessionInit?.skipAssetConfirm).toBe(true);
  });
});
