import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoleDir } from "../role-files.js";

const MANAGED_MARKER = "managed:l1-agent-v1";
const ROLE_NAMES = ["l1-extractor"] as const;

export function installL1RolePackages(input: {
  dataDir: string;
  sourceRoot?: string;
}): string[] {
  const sourceRoot = input.sourceRoot ?? packageRoleRoot();
  const targetRoot = resolveRoleDir(input.dataDir);
  const installed: string[] = [];
  for (const role of ROLE_NAMES) {
    const sourceDir = path.join(sourceRoot, role);
    const targetDir = path.join(targetRoot, role);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of ["role.json", "prompt.md"]) {
      const source = path.join(sourceDir, name);
      const target = path.join(targetDir, name);
      if (fs.existsSync(target)) {
        const current = fs.readFileSync(target, "utf-8");
        if (!current.includes(MANAGED_MARKER)) {
          throw new Error(
            `refusing to overwrite unmanaged role file ${target}`,
          );
        }
        if (current === fs.readFileSync(source, "utf-8")) continue;
      }
      fs.copyFileSync(source, target);
      installed.push(target);
    }
  }
  return installed;
}

function packageRoleRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(current, "roles");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error("package roles directory not found");
    current = parent;
  }
}
