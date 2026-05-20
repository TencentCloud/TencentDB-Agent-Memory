import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveSandboxedExistingPath,
  resolveSandboxedPath,
  resolveSandboxedWritablePath,
} from "./llm-runner.js";

describe("StandaloneLLMRunner file-tool sandbox", () => {
  it("rejects sibling-prefix traversal outside workspaceDir", () => {
    const root = path.resolve("/tmp/scene_blocks");

    expect(resolveSandboxedPath(root, "../scene_blocks_backup/file.md")).toBeNull();
    expect(resolveSandboxedPath(root, "../scene_blocks2/file.md")).toBeNull();
    expect(resolveSandboxedPath(root, "inside/file.md")).toBe(path.join(root, "inside/file.md"));
  });

  it("rejects symlink escapes for existing and writable paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-llm-sandbox-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-llm-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
      fs.symlinkSync(outside, path.join(root, "outside-link"), "dir");

      await expect(resolveSandboxedExistingPath(root, "outside-link/secret.txt")).resolves.toBeNull();
      await expect(resolveSandboxedWritablePath(root, "outside-link/new.txt")).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects existing file symlinks for writable paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-llm-sandbox-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-llm-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      fs.writeFileSync(outsideFile, "secret");
      fs.symlinkSync(outsideFile, path.join(root, "out.md"));

      await expect(resolveSandboxedExistingPath(root, "out.md")).resolves.toBeNull();
      await expect(resolveSandboxedWritablePath(root, "out.md")).resolves.toBeNull();
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("secret");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
