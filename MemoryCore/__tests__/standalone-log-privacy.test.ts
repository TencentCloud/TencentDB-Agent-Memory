import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
type ToolArgs = { path?: string; content?: string; edits?: Array<{ oldText: string; newText: string }> };
type CallParams = { tools: Record<string, { execute(args: ToolArgs): Promise<string> }> };
const fake = vi.hoisted(() => ({ execute: undefined as ((params: CallParams) => Promise<unknown>) | undefined, report: vi.fn() }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: vi.fn((params) => fake.execute!(params)) }));
vi.mock("../src/core/report/reporter.js", () => ({ report: fake.report }));
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.js";
import { StorageAdapter } from "../src/core/storage/adapter.js";
import { LocalStorageBackend } from "../src/core/storage/local-backend.js";
const marker = "synthetic-private-content";
const temporary: string[] = [];
afterEach(async () => { fake.report.mockClear(); await Promise.all(temporary.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
function logger() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }; }
function assertPrivate(log: ReturnType<typeof logger>) {
  expect(JSON.stringify(Object.values(log).map(fn => fn.mock.calls))).not.toContain(marker);
}
const config = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "synthetic", model: marker };
function result(toolName: string) { return { text: "result", totalUsage: undefined, steps: [{ stepNumber: 0, text: "", toolCalls: [{ toolName, input: { content: marker } }], finishReason: "stop" }] }; }

it("omits task/model/tool identity and tool arguments while preserving caller tool execution", async () => {
  const log = logger(); const execute = vi.fn().mockResolvedValue("tool result");
  fake.execute = async params => { await params.tools[marker].execute({ content: marker }); return result(marker); };
  const runner = new StandaloneLLMRunner({ config, logger: log, enableTools: true });
  expect(await runner.run({ taskId: marker, prompt: marker, tools: { [marker]: { execute } } })).toBe("result");
  expect(execute).toHaveBeenCalledExactlyOnceWith({ content: marker }); assertPrivate(log);
});

it("omits local file paths in success and failure diagnostics while preserving tool results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "log-privacy-")); temporary.push(root);
  const log = logger();
  fake.execute = async params => {
    expect(JSON.parse(await params.tools.write.execute({ path: marker + "/note.txt", content: "old" }))).toEqual({ success: true });
    expect(await params.tools.read.execute({ path: marker + "/note.txt" })).toBe("old");
    expect(JSON.parse(await params.tools.edit.execute({ path: marker + "/note.txt", edits: [{ oldText: "old", newText: "new" }] }))).toEqual({ success: true });
    for (const name of ["read", "edit"]) {
      const response = await params.tools[name].execute({ path: marker + "/missing.txt", edits: [{ oldText: "x", newText: "y" }] });
      expect(JSON.parse(response)).toHaveProperty("error");
    }
    // A directory cannot be overwritten as a file.
    expect(JSON.parse(await params.tools.write.execute({ path: marker, content: "x" }))).toHaveProperty("error");
    return result("write");
  };
  expect(await new StandaloneLLMRunner({ config, logger: log, enableTools: true }).run({ taskId: marker, prompt: marker, workspaceDir: root })).toBe("result");
  expect(await fs.readFile(path.join(root, marker, "note.txt"), "utf8")).toBe("new");assertPrivate(log);
});

it("omits storage prefix, paths and backend failures without changing storage operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-log-")); temporary.push(root);
  const storage = new StorageAdapter(new LocalStorageBackend(root));
  const log = logger();
  fake.execute = async params => {
    expect(JSON.parse(await params.tools.write.execute({ path: marker + "/note.txt", content: "old" }))).toEqual({ success: true });
    expect(await params.tools.read.execute({ path: marker + "/note.txt" })).toBe("old");
    expect(JSON.parse(await params.tools.edit.execute({ path: marker + "/note.txt", edits: [{ oldText: "old", newText: "new" }] }))).toEqual({ success: true });
    const read = vi.spyOn(storage, "readFile").mockRejectedValue(new Error(marker));
    for (const name of ["read", "edit"]) expect(JSON.parse(await params.tools[name].execute({ path: marker, edits: [{ oldText: "x", newText: "y" }] }))).toHaveProperty("error");
    read.mockRestore();
    const write = vi.spyOn(storage, "writeFile").mockRejectedValue(new Error(marker));
    expect(JSON.parse(await params.tools.write.execute({ path: marker, content: "x" }))).toHaveProperty("error");write.mockRestore();
    return result("read");
  };
  expect(await new StandaloneLLMRunner({ config, logger: log, enableTools: true }).run({ taskId: marker, prompt: marker, storage, storagePrefix: marker + "/" })).toBe("result");
  expect(await storage.readFile(marker + "/" + marker + "/note.txt")).toBe("new");assertPrivate(log);
});

it("keeps the original provider rejection but omits its payload from logs and error reporting", async () => {
  const log = logger(); const error = new Error(marker);
  fake.execute = async () => { throw error; };
  await expect(new StandaloneLLMRunner({ config, logger: log }).run({ taskId: "synthetic", prompt: marker, instanceId: "synthetic" })).rejects.toBe(error);
  assertPrivate(log);expect(fake.report).toHaveBeenCalledWith("llm_call", expect.objectContaining({ success: false, error: "Standalone LLM request failed" }));
});
