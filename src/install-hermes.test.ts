import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe("install_hermes_memory_tencentdb.sh", () => {
  it("links memory_tencentdb into checkout and durable user plugin directories", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-tencentdb-install-"));

    try {
      const fakeBin = join(root, "bin");
      const installDir = join(root, "tdai-memory-openclaw-plugin");
      const dataDir = join(root, "memory-tdai");
      const hermesHome = join(root, ".hermes");
      const hermesAgentDir = join(hermesHome, "hermes-agent");
      const sudoSink = join(root, "sudo-tee-output");

      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(hermesAgentDir, { recursive: true });

      writeExecutable(
        join(fakeBin, "npm"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"@tencentdb-agent-memory/memory-tencentdb@latest"* ]]; then
  pkg="node_modules/@tencentdb-agent-memory/memory-tencentdb"
  mkdir -p "$pkg/hermes-plugin/memory/memory_tencentdb" "$pkg/src/gateway"
  touch "$pkg/hermes-plugin/memory/memory_tencentdb/__init__.py"
  touch "$pkg/hermes-plugin/memory/memory_tencentdb/client.py"
  touch "$pkg/hermes-plugin/memory/memory_tencentdb/supervisor.py"
  printf 'name: memory_tencentdb\\n' > "$pkg/hermes-plugin/memory/memory_tencentdb/plugin.yaml"
  touch "$pkg/src/gateway/server.ts"
fi
exit 0
`,
      );
      writeExecutable(join(fakeBin, "npx"), "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(
        join(fakeBin, "sed"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "-i" ]]; then
  echo "sed -i is not portable in this installer test" >&2
  exit 64
fi
exec /usr/bin/sed "$@"
`,
      );
      writeExecutable(
        join(fakeBin, "sudo"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "tee" ]]; then
  cat > "${sudoSink}"
  exit 0
fi
exit 1
`,
      );

      const script = resolve("scripts/install_hermes_memory_tencentdb.sh");
      const result = spawnSync("bash", [script], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          INSTALL_AS_USER: "memory_tencentdb_test_user",
          MEMORY_TENCENTDB_ROOT: root,
          TDAI_INSTALL_DIR: installDir,
          TDAI_DATA_DIR: dataDir,
          HERMES_HOME: hermesHome,
          HERMES_AGENT_DIR: hermesAgentDir,
        },
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const pluginSource = join(installDir, "hermes-plugin/memory/memory_tencentdb");
      const checkoutLink = join(hermesAgentDir, "plugins/memory/memory_tencentdb");
      const userLink = join(hermesHome, "plugins/memory_tencentdb");

      expect(lstatSync(checkoutLink).isSymbolicLink()).toBe(true);
      expect(lstatSync(userLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(checkoutLink)).toBe(pluginSource);
      expect(readlinkSync(userLink)).toBe(pluginSource);
      expect(statSync(join(hermesHome, ".env")).isFile()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
