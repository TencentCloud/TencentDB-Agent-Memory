import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURSOR_ADAPTER_MARKER,
  installCursorAdapter,
  uninstallCursorAdapter,
} from "../src/installer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-installer-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(projectRoot)]);
  return { home, projectRoot };
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("Cursor Adapter installer", () => {
  // 用户级与项目级 Hook 都会运行，必须阻止跨作用域重复安装。
  it("rejects install when the other scope already has the marker", async () => {
    const { home, projectRoot } = await workspace();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(path.join(home, ".cursor", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        stop: [{
          command: `/bin/memory-tencentdb-cursor hook ${CURSOR_ADAPTER_MARKER}`,
        }],
      },
    }));

    await expect(installCursorAdapter({
      scope: "project",
      home,
      projectRoot,
      executablePath: "/bin/memory-tencentdb-cursor",
    })).rejects.toThrow(new RegExp(CURSOR_ADAPTER_MARKER));
  });

  // 同名但非本适配器所有的 MCP 不得覆盖或删除。
  it("refuses to overwrite same-named non-adapter MCP", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const cursorDir = path.join(options.projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const original = {
      mcpServers: {
        "tencentdb-memory": { command: "user-owned-mcp", args: ["serve"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(original));

    await expect(installCursorAdapter(options)).rejects.toThrow(/MCP.*conflict/i);
    await uninstallCursorAdapter(options);

    expect(await readJson(mcpPath)).toEqual(original);
  });

  // 没有 marker 的同名 Rule 属于用户，不得覆盖。
  it("refuses to overwrite same-named non-adapter Rule", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const rulePath = path.join(
      options.projectRoot,
      ".cursor",
      "rules",
      "tencentdb-memory.mdc",
    );
    await mkdir(path.dirname(rulePath), { recursive: true });
    await writeFile(rulePath, "user rule");

    await expect(installCursorAdapter(options)).rejects.toThrow(/Rule.*conflict/i);

    expect(await readFile(rulePath, "utf8")).toBe("user rule");
  });

  // 非数组事件字段必须拒绝，不能静默丢弃未知配置。
  it("refuses to overwrite non-array Hook event config", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const hooksPath = path.join(options.projectRoot, ".cursor", "hooks.json");
    await mkdir(path.dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { stop: { command: "custom-shape" } },
    }));

    await expect(installCursorAdapter(options)).rejects.toThrow(/Hook.*stop.*array/i);

    expect(await readJson(hooksPath)).toMatchObject({
      hooks: { stop: { command: "custom-shape" } },
    });
  });

  // 非法顶层 hooks 或 mcpServers 不得被静默重置。
  it("refuses to overwrite malformed top-level config", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const cursorDir = path.join(options.projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, "hooks.json");
    const mcpPath = path.join(cursorDir, "mcp.json");
    await writeFile(hooksPath, JSON.stringify({ version: 1, hooks: "custom" }));
    await writeFile(mcpPath, JSON.stringify({ mcpServers: [] }));

    await expect(installCursorAdapter(options)).rejects.toThrow(/hooks.*object/i);

    expect(await readJson(hooksPath)).toEqual({ version: 1, hooks: "custom" });
    expect(await readJson(mcpPath)).toEqual({ mcpServers: [] });

    await writeFile(hooksPath, JSON.stringify({ version: 1, hooks: {} }));
    await expect(installCursorAdapter(options)).rejects.toThrow(/mcpServers.*object/i);
    expect(await readJson(mcpPath)).toEqual({ mcpServers: [] });
  });

  // 安装只添加自身 Hook、MCP、Rule，其他配置保持不变。
  it("safely merges project-scope config", async () => {
    const { home, projectRoot } = await workspace();
    const cursorDir = path.join(projectRoot, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(path.join(cursorDir, "hooks.json"), JSON.stringify({
      version: 1,
      custom: true,
      hooks: { stop: [{ command: "other-hook" }] },
    }));
    await writeFile(path.join(cursorDir, "mcp.json"), JSON.stringify({
      custom: true,
      mcpServers: { other: { command: "other-mcp" } },
    }));

    await installCursorAdapter({
      scope: "project",
      home,
      projectRoot,
      executablePath: "/bin/memory-tencentdb-cursor",
    });

    const hooks = await readJson(path.join(cursorDir, "hooks.json"));
    const mcp = await readJson(path.join(cursorDir, "mcp.json"));
    expect(hooks.custom).toBe(true);
    expect(hooks.hooks.stop).toContainEqual({ command: "other-hook" });
    expect(JSON.stringify(hooks)).toContain(CURSOR_ADAPTER_MARKER);
    expect(mcp).toMatchObject({
      custom: true,
      mcpServers: {
        other: { command: "other-mcp" },
        "tencentdb-memory": {
          command: "/bin/memory-tencentdb-cursor",
          args: ["mcp"],
        },
      },
    });
    const rule = await readFile(
      path.join(cursorDir, "rules", "tencentdb-memory.mdc"),
      "utf8",
    );
    expect(rule).toContain(CURSOR_ADAPTER_MARKER);
    expect(rule).toContain("tdai_read_cos");
    expect(rule).toContain("相对 path");
    expect(rule).not.toContain("绝对路径");
    expect(rule).not.toContain("tdai_capture");
    expect(rule).not.toContain("tdai_session_end");
  });

  // 同一作用域重装时 Hook 数量必须保持不变。
  it("is idempotent for reinstall in the same scope", async () => {
    const options = {
      scope: "user" as const,
      ...await workspace(),
      executablePath: "/path with space/memory-tencentdb-cursor",
    };

    await installCursorAdapter(options);
    const first = await readFile(path.join(options.home, ".cursor", "hooks.json"), "utf8");
    await installCursorAdapter(options);
    const second = await readFile(path.join(options.home, ".cursor", "hooks.json"), "utf8");

    expect(second).toBe(first);
    expect(first).toContain("'/path with space/memory-tencentdb-cursor'");
  });

  // 升级后的 executable path 仍属于同一 Adapter, 同 scope 只能保留一个 Hook.
  it("reinstall replaces an owned Hook from an old executable path", async () => {
    const workspacePaths = await workspace();
    await installCursorAdapter({
      scope: "project",
      ...workspacePaths,
      executablePath: "/old/memory-tencentdb-cursor",
    });

    await installCursorAdapter({
      scope: "project",
      ...workspacePaths,
      executablePath: "/new/memory-tencentdb-cursor",
    });

    const hooks = await readJson(path.join(
      workspacePaths.projectRoot,
      ".cursor",
      "hooks.json",
    ));
    expect(hooks.hooks.stop).toEqual([{
      command: `/new/memory-tencentdb-cursor hook ${CURSOR_ADAPTER_MARKER}`,
    }]);
  });

  // 正式 bin 的旧路径可包含空格，升级时仍只能保留一个 Hook。
  it("reinstall replaces an owned Hook from a quoted old path", async () => {
    const workspacePaths = await workspace();
    await installCursorAdapter({
      scope: "project",
      ...workspacePaths,
      executablePath: "/old path/memory-tencentdb-cursor",
    });

    await installCursorAdapter({
      scope: "project",
      ...workspacePaths,
      executablePath: "/new/memory-tencentdb-cursor",
    });

    const hooks = await readJson(path.join(
      workspacePaths.projectRoot,
      ".cursor",
      "hooks.json",
    ));
    expect(hooks.hooks.stop).toEqual([{
      command: `/new/memory-tencentdb-cursor hook ${CURSOR_ADAPTER_MARKER}`,
    }]);
  });

  // 不同 executable path 也必须触发跨 scope duplicate gate.
  it("rejects cross-scope ownership from an old executable path", async () => {
    const workspacePaths = await workspace();
    await installCursorAdapter({
      scope: "user",
      ...workspacePaths,
      executablePath: "/old/memory-tencentdb-cursor",
    });

    await expect(installCursorAdapter({
      scope: "project",
      ...workspacePaths,
      executablePath: "/new/memory-tencentdb-cursor",
    })).rejects.toThrow(new RegExp(CURSOR_ADAPTER_MARKER));
  });

  // 通用 entry.js 即使复用了 marker 文本，也不能据此取得适配器所有权。
  it("keeps a foreign entry.js Hook", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const hooksPath = path.join(options.projectRoot, ".cursor", "hooks.json");
    await mkdir(path.dirname(hooksPath), { recursive: true });
    const foreign = {
      command: `/other/tool/entry.js hook ${CURSOR_ADAPTER_MARKER}`,
    };
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { stop: [foreign] },
    }));

    await installCursorAdapter(options);
    await uninstallCursorAdapter(options);

    const hooks = await readJson(hooksPath);
    expect(hooks.hooks.stop).toContainEqual(foreign);
  });

  // Transcript 方案的生产 Hook 只保留 sessionStart、stop、sessionEnd。
  it("removes old before/after adapter Hooks and keeps other commands", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const hooksPath = path.join(options.projectRoot, ".cursor", "hooks.json");
    await mkdir(path.dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          { command: `/bin/memory-tencentdb-cursor hook ${CURSOR_ADAPTER_MARKER}` },
          { command: "other-before" },
          { command: `echo ${CURSOR_ADAPTER_MARKER}-not-owned` },
          { command: `echo hook ${CURSOR_ADAPTER_MARKER}` },
        ],
        afterAgentResponse: [{
          command: `/bin/memory-tencentdb-cursor hook ${CURSOR_ADAPTER_MARKER}`,
        }],
      },
    }));

    await installCursorAdapter(options);

    const hooks = await readJson(hooksPath);
    expect(hooks.hooks.beforeSubmitPrompt).toEqual([
      { command: "other-before" },
      { command: `echo ${CURSOR_ADAPTER_MARKER}-not-owned` },
      { command: `echo hook ${CURSOR_ADAPTER_MARKER}` },
    ]);
    expect(hooks.hooks.afterAgentResponse).toEqual([]);
    expect(JSON.stringify(hooks.hooks.stop)).toContain(CURSOR_ADAPTER_MARKER);
  });

  // 即使 executable/args 相同，没有所有权 marker 仍属于用户。
  it("refuses to overwrite same-path MCP without marker", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    const mcpPath = path.join(options.projectRoot, ".cursor", "mcp.json");
    await mkdir(path.dirname(mcpPath), { recursive: true });
    const original = {
      mcpServers: {
        "tencentdb-memory": {
          command: options.executablePath,
          args: ["mcp"],
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(original));

    await expect(installCursorAdapter(options)).rejects.toThrow(/MCP.*conflict/i);
    await uninstallCursorAdapter(options);

    expect(await readJson(mcpPath)).toEqual(original);
  });

  // 卸载只删除适配器自身条目和 Rule。
  it("uninstall keeps other tool config", async () => {
    const options = {
      scope: "project" as const,
      ...await workspace(),
      executablePath: "/bin/memory-tencentdb-cursor",
    };
    await installCursorAdapter(options);
    const cursorDir = path.join(options.projectRoot, ".cursor");
    const hooks = await readJson(path.join(cursorDir, "hooks.json"));
    hooks.hooks.stop.push({ command: "other-hook" });
    await writeFile(path.join(cursorDir, "hooks.json"), JSON.stringify(hooks));
    const mcp = await readJson(path.join(cursorDir, "mcp.json"));
    mcp.mcpServers.other = { command: "other-mcp" };
    await writeFile(path.join(cursorDir, "mcp.json"), JSON.stringify(mcp));

    await uninstallCursorAdapter(options);

    const afterHooks = await readJson(path.join(cursorDir, "hooks.json"));
    const afterMcp = await readJson(path.join(cursorDir, "mcp.json"));
    expect(JSON.stringify(afterHooks)).not.toContain(CURSOR_ADAPTER_MARKER);
    expect(afterHooks.hooks.stop).toEqual([{ command: "other-hook" }]);
    expect(afterMcp.mcpServers).toEqual({ other: { command: "other-mcp" } });
    await expect(readFile(
      path.join(cursorDir, "rules", "tencentdb-memory.mdc"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });
});
