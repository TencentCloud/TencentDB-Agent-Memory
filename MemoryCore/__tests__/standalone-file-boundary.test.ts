import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FileArguments = { path: string; content?: string; edits?: Array<{ oldText: string; newText: string }> };
type FileTools = Record<string, { execute(args: FileArguments): Promise<string> }>;
const capture = vi.hoisted(() => ({ tools: undefined as FileTools | undefined }));
vi.mock("ai", async (original) => ({
  ...await original<typeof import("ai")>(),
  generateText: vi.fn(async (params: { tools: FileTools }) => {
    capture.tools = params.tools;
    return { text: "synthetic result", totalUsage: undefined, steps: [] };
  }),
}));
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "core-boundary-"));
  temporary.push(base);
  const root = path.join(base, "workspace");
  const outside = path.join(base, "workspace-private");
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "synthetic private content");
  const runner = new StandaloneLLMRunner({ config: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic", model: "synthetic" }, enableTools: true });
  await runner.run({ taskId: "synthetic", prompt: "synthetic", workspaceDir: root });
  return { root, outside, tools: capture.tools! };
}

for (const operation of ["read", "write", "edit"] as const) {
  for (const escape of ["sibling", "directory-link", "file-link"] as const) {
    it(`rejects ${escape} escape for ${operation} without touching the outside file`, async () => {
      const { root, outside, tools } = await fixture();
      let target = "../workspace-private/secret.txt";
      if (escape === "directory-link") {
        await fs.symlink(outside, path.join(root, "link")); target = "link/secret.txt";
      } else if (escape === "file-link") {
        await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link")); target = "link";
      }
      const result = await tools[operation].execute({ path: target, content: "replacement", edits: [{ oldText: "synthetic", newText: "replacement" }] });
      expect(JSON.parse(result)).toHaveProperty("error");
      expect(result).not.toContain("synthetic private content");
      expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("synthetic private content");
    });
  }
}
it("retains nested write/read/edit operations within the workspace", async () => {
  const { root, tools } = await fixture();
  expect(JSON.parse(await tools.write.execute({ path: "nested/note.txt", content: "old value" }))).toEqual({ success: true });
  expect(await tools.read.execute({ path: "nested/note.txt" })).toBe("old value");
  expect(JSON.parse(await tools.edit.execute({ path: "nested/note.txt", edits: [{ oldText: "old", newText: "$& new" }] }))).toEqual({ success: true });
  expect(await fs.readFile(path.join(root, "nested/note.txt"), "utf8")).toBe("$& new value");
});
