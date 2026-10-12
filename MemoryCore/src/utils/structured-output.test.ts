import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractOpenAiFinalAnswer,
  extractStructuredJson,
  StructuredOutputParseError,
} from "./structured-output.js";
import { parseL1Response as parseLocalL1 } from "../offload/local-llm/parsers/l1-parser.js";
import { parseL1Response as parseStandaloneL1 } from "../offload_server/parsers/l1-parser.js";
import { OffloadTaskExecutor } from "../offload_server/offload-task-executor.js";
import { buildOffloadBasePath } from "../offload_server/session-utils.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import type { IStateBackend, TaskPayload } from "../core/state/types.js";

const VALID_L1 = JSON.stringify([{
  tool_call_id: "call-1",
  tool_call: "read_file",
  summary: "Read the requested file",
  timestamp: "2026-08-23T00:00:00.000Z",
  score: 5,
}]);

describe("structured LLM output normalization", () => {
  it.each([
    ["already-clean JSON", VALID_L1],
    ["a JSON fence", `\`\`\`json\n${VALID_L1}\n\`\`\``],
    ["a Qwen think wrapper", `<think>private reasoning with {\"wrong\":true}</think>\n${VALID_L1}`],
    ["a think wrapper around a fence", `<think>private reasoning</think>\n\`\`\`json\n${VALID_L1}\n\`\`\``],
  ])("parses %s consistently in local and standalone callers", (_label, raw) => {
    expect(parseLocalL1(raw)).toHaveLength(1);
    expect(parseStandaloneL1(raw)).toHaveLength(1);
    expect(parseLocalL1(raw)[0].tool_call_id).toBe("call-1");
    expect(parseStandaloneL1(raw)[0].tool_call_id).toBe("call-1");
  });

  it("uses visible content and ignores a separate reasoning_content field", () => {
    const raw = extractOpenAiFinalAnswer({
      choices: [{
        message: {
          content: VALID_L1,
          reasoning_content: "private chain of thought containing different JSON",
        },
      }],
    });

    expect(raw).toBe(VALID_L1);
    expect(parseStandaloneL1(raw)[0].tool_call_id).toBe("call-1");
  });

  it("does not promote hidden reasoning when visible content is absent", () => {
    expect(extractOpenAiFinalAnswer({
      choices: [{ message: { content: null, reasoning_content: VALID_L1 } }],
    })).toBe("");
  });

  it.each([
    ["reasoning only", "<think>private reasoning</think>"],
    ["unclosed reasoning", "<think>private reasoning"],
    ["malformed JSON", "{not-json}"],
    ["arbitrary prose around JSON", `Here is the answer: ${VALID_L1}`],
  ])("rejects %s instead of recovering arbitrary content", (_label, raw) => {
    expect(extractStructuredJson(raw)).toBeNull();
    expect(parseLocalL1(raw)).toEqual([]);
    expect(parseStandaloneL1(raw)).toEqual([]);
  });

  it("produces a bounded diagnostic without response content", () => {
    const secret = "private-reasoning-secret";
    const error = new StructuredOutputParseError("L1", `<think>${secret}</think>`);

    expect(error.message).toContain("kind=reasoning-only");
    expect(error.message).not.toContain(secret);
    expect(error.message.length).toBeLessThan(120);
  });
});

describe("standalone L1 write safety", () => {
  let rootDir: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "memorycore-structured-output-"));
    storage = new StorageAdapter(new LocalStorageBackend(rootDir));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("retains the claimed L0 input for retry and does not write L1 on reasoning-only output", async () => {
    const sessionId = "session-reasoning-only";
    const taskId = "task-reasoning-only";
    const basePath = buildOffloadBasePath(sessionId);
    const pendingPath = `${basePath}/pending.jsonl`;
    const processingPath = `${basePath}/pending-processing-${taskId}.jsonl`;
    const entriesPath = `${basePath}/entries.jsonl`;
    const pending = JSON.stringify({
      toolCallId: "call-1",
      toolName: "read_file",
      params: {},
      result: "a result long enough to have been persisted as a reference",
      timestamp: "2026-08-23T00:00:00.000Z",
    }) + "\n";
    await storage.writeFile(pendingPath, pending);

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const executor = new OffloadTaskExecutor({
      resolveStorage: async () => storage,
      llmClient: { chat: async () => "<think>private reasoning only</think>" },
      stateBackend: {} as IStateBackend,
      logger,
    });
    const task: TaskPayload = {
      id: taskId,
      type: "offload-l1",
      instanceId: "instance-1",
      sessionId,
      priority: 1,
      createdAt: Date.now(),
    };

    await expect(executor.executeOffloadL1(task)).rejects.toBeInstanceOf(StructuredOutputParseError);
    expect(await storage.readFile(pendingPath)).toBeNull();
    expect(await storage.readFile(processingPath)).toBe(pending);
    expect(await storage.readFile(entriesPath)).toBeNull();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private reasoning only");
  });
});
