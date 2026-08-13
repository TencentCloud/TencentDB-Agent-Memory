import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const installer = await import(pathToFileURL(join(process.cwd(), "bin", "tdai-opencode.mjs")).href);

describe("one-command installer", () => {
  it("publishes compiled JavaScript instead of TypeScript under node_modules", () => {
    const metadata = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(metadata.exports["."].import).toBe("./dist/index.js");
    expect(metadata.files).toContain("dist");
    expect(metadata.files).toContain("USER_GUIDE.md");
    expect(metadata.files).toContain("USER_GUIDE_CN.md");
    expect(metadata.files).not.toContain("src");
  });

  it("installs and uninstalls without disturbing existing dependencies", async () => {
    const project = mkdtempSync(join(tmpdir(), "tdai-opencode-install-"));
    const xdgConfig = mkdtempSync(join(tmpdir(), "tdai-opencode-xdg-"));
    const configRoot = join(project, ".opencode");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configRoot, { recursive: true }));
    writeFileSync(join(configRoot, "package.json"), JSON.stringify({ dependencies: { existing: "1.0.0" } }));
    const options = installer.parseArgs(["install", "--scope", "project", "--project", project, "--package", "file:C:/adapter.tgz", "--endpoint", "http://127.0.0.1:18420"]);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdgConfig;
      const paths = installer.pathsFor(options);
      await installer.install(options);

      const packageJson = JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8"));
      expect(packageJson.dependencies.existing).toBe("1.0.0");
      expect(packageJson.dependencies["@tencentdb-agent-memory/opencode-adapter"]).toBe("file:C:/adapter.tgz");
      expect(readFileSync(join(configRoot, "plugins", "tencentdb-agent-memory.ts"), "utf8")).toContain("TDAI_OPENCODE_CONFIG_FILE");
      expect(JSON.parse(readFileSync(paths.memoryConfig, "utf8")).endpoint).toBe("http://127.0.0.1:18420");
      expect(paths.memoryConfig.startsWith(configRoot)).toBe(false);

      await installer.install(options);
      expect(JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")).dependencies.existing).toBe("1.0.0");

      await installer.uninstall({ ...options, keepConfig: true });
      const remaining = JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8"));
      expect(remaining.dependencies).toEqual({ existing: "1.0.0" });
      expect(readFileSync(paths.memoryConfig, "utf8")).toContain("18420");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("refuses to overwrite an unrelated plugin file", async () => {
    const project = mkdtempSync(join(tmpdir(), "tdai-opencode-install-"));
    const pluginDir = join(project, ".opencode", "plugins");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(pluginDir, { recursive: true }));
    writeFileSync(join(pluginDir, "tencentdb-agent-memory.ts"), "export const someoneElsesPlugin = true\n");
    const options = installer.parseArgs(["install", "--scope", "project", "--project", project]);
    await expect(installer.install(options)).rejects.toThrow("Refusing to overwrite unrelated plugin");
  });

  it("restores a dependency that existed before the installer", async () => {
    const project = mkdtempSync(join(tmpdir(), "tdai-opencode-install-"));
    const xdgConfig = mkdtempSync(join(tmpdir(), "tdai-opencode-xdg-"));
    const configRoot = join(project, ".opencode");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configRoot, { recursive: true }));
    writeFileSync(join(configRoot, "package.json"), JSON.stringify({ dependencies: { "@tencentdb-agent-memory/opencode-adapter": "0.0.9" } }));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdgConfig;
      const options = installer.parseArgs(["install", "--scope", "project", "--project", project, "--package", "0.1.0"]);
      await installer.install(options);
      await installer.uninstall(options);
      expect(JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")).dependencies["@tencentdb-agent-memory/opencode-adapter"]).toBe("0.0.9");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("does not reuse local placeholder credentials when switching to remote", async () => {
    const project = mkdtempSync(join(tmpdir(), "tdai-opencode-install-"));
    const xdgConfig = mkdtempSync(join(tmpdir(), "tdai-opencode-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = xdgConfig;
      const local = installer.parseArgs(["install", "--scope", "project", "--project", project]);
      await installer.install(local);
      const remote = installer.parseArgs(["install", "--scope", "project", "--project", project, "--endpoint", "https://memory.example"]);
      await expect(installer.install(remote)).rejects.toThrow("Remote Gateway configuration is incomplete");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("does not send one remote Gateway's credentials to a different origin", async () => {
    const project = mkdtempSync(join(tmpdir(), "tdai-opencode-install-"));
    const xdgConfig = mkdtempSync(join(tmpdir(), "tdai-opencode-xdg-"));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousKey = process.env.TDAI_MEMORY_API_KEY;
    try {
      process.env.XDG_CONFIG_HOME = xdgConfig;
      process.env.TDAI_MEMORY_API_KEY = "gateway-a-secret";
      const gatewayA = installer.parseArgs([
        "install", "--scope", "project", "--project", project,
        "--endpoint", "https://gateway-a.example", "--service-id", "service-a",
        "--team-id", "team-a", "--user-id", "user-a",
      ]);
      await installer.install(gatewayA);
      delete process.env.TDAI_MEMORY_API_KEY;
      const gatewayB = installer.parseArgs([
        "install", "--scope", "project", "--project", project,
        "--endpoint", "https://gateway-b.example",
      ]);
      await expect(installer.install(gatewayB)).rejects.toThrow("Remote Gateway configuration is incomplete");
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousKey === undefined) delete process.env.TDAI_MEMORY_API_KEY;
      else process.env.TDAI_MEMORY_API_KEY = previousKey;
    }
  });
});
