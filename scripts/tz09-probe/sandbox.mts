/**
 * Sandbox for tz-09 live probes.
 *
 * A gateway booted with only its dataDir overridden still resolves roles from
 * os.homedir() and still honours the live roles' absolute scratch_root — it
 * then dispatches them and spawns REAL sub-sessions against the live memory
 * tree. Every probe therefore runs with HOME pointed at a scratch dir, the
 * roles copied in, scratch_root rewritten inside the sandbox, and the trigger
 * forced to manual_only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Sandbox {
  home: string;
  dataDir: string;
  roleDir: string;
  cleanup: () => void;
}

/** Copy one live role into the sandbox, neutered: manual trigger, local scratch. */
function copyRole(
  srcRoleDir: string,
  dstRoleDir: string,
  sandboxRoot: string,
): void {
  fs.mkdirSync(dstRoleDir, { recursive: true });
  for (const entry of fs.readdirSync(srcRoleDir)) {
    fs.copyFileSync(path.join(srcRoleDir, entry), path.join(dstRoleDir, entry));
  }
  const roleFile = path.join(dstRoleDir, "role.json");
  if (!fs.existsSync(roleFile)) return;
  const role = JSON.parse(fs.readFileSync(roleFile, "utf-8")) as Record<
    string,
    unknown
  >;
  // Flat schema (see a live role.json): trigger/schedule/threshold are
  // top-level keys, runtime is the only nested object.
  role.trigger = "manual_only";
  role.schedule = null;
  role.threshold = null;
  const runtime = (role.runtime ?? {}) as Record<string, unknown>;
  runtime.scratch_root = path.join(
    sandboxRoot,
    "scratch",
    path.basename(dstRoleDir),
  );
  role.runtime = runtime;
  fs.writeFileSync(roleFile, JSON.stringify(role, null, 2), "utf-8");
}

export function makeSandbox(roles: string[] = ["memory-keeper"]): Sandbox {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tz09-home-"));
  const dataDir = path.join(home, ".pi", "agent-memory", "tdai");
  const roleDir = path.join(dataDir, "roles");
  fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
    recursive: true,
  });
  fs.mkdirSync(roleDir, { recursive: true });

  const liveRoles = path.join(
    os.homedir(),
    ".pi",
    "agent-memory",
    "tdai",
    "roles",
  );
  for (const role of roles) {
    const src = path.join(liveRoles, role);
    if (fs.existsSync(src)) copyRole(src, path.join(roleDir, role), home);
  }

  return {
    home,
    dataDir,
    roleDir,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
