import type http from "node:http";
import { getEncoding } from "js-tiktoken";
import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../core/storage/adapter.js";
import { replaceWithSummary } from "./compact/helpers.js";
import { handleOffloadV2Route } from "./router.js";
import {
  handleReadRef,
  resolveOwnedResultRef,
  sliceRefContent,
} from "./read-ref-handler.js";

const requestId = "req-test";
const auth = { serviceId: "service-test" };

function envelopes() {
  return {
    successEnvelope: <T>(data: T, id: string) => ({ code: 0, message: "ok", request_id: id, data }),
    errorEnvelope: (code: number, message: string, id: string) => ({
      code,
      message,
      request_id: id,
    }),
  };
}

function storageWith(content: string | null) {
  const readFile = vi.fn(async () => content);
  return {
    storage: { readFile } as unknown as StorageAdapter,
    readFile,
  };
}

describe("resolveOwnedResultRef", () => {
  it("accepts only direct refs belonging to the requested session", () => {
    expect(resolveOwnedResultRef("session-1", "offload/session-1/refs/call-1.md"))
      .toBe("offload/session-1/refs/call-1.md");
    expect(resolveOwnedResultRef("session-1", "offload/session-2/refs/call-1.md")).toBeNull();
    expect(resolveOwnedResultRef("session-1", "offload/session-1/refs/../secret.md")).toBeNull();
    expect(resolveOwnedResultRef("session-1", "/offload/session-1/refs/call-1.md")).toBeNull();
    expect(resolveOwnedResultRef("session-1", "offload/session-1/refs/nested/call-1.md")).toBeNull();
    expect(resolveOwnedResultRef("session-1", "offload/session-1/refs/call-1.txt")).toBeNull();
  });

  it("uses the same sanitized session path as offload writes", () => {
    expect(resolveOwnedResultRef("agent:session", "offload/agent_session/refs/call-1.md"))
      .toBe("offload/agent_session/refs/call-1.md");
  });
});

describe("sliceRefContent", () => {
  it("reads an inclusive line range and reports partial content", () => {
    expect(sliceRefContent("one\ntwo\nthree\nfour", {
      start_line: 2,
      end_line: 3,
      max_tokens: 100,
    })).toEqual({
      content: "two\nthree",
      truncated: true,
    });
  });

  it("returns a bounded excerpt around a query", () => {
    const raw = `${"before ".repeat(200)}TARGET${" after".repeat(200)}`;
    const result = sliceRefContent(raw, {
      query: "target",
      max_tokens: 32,
    });

    expect(result.content).toContain("TARGET");
    expect(result.truncated).toBe(true);
    expect(result.match_found).toBe(true);
    expect(getEncoding("o200k_base").encode(result.content).length).toBeLessThanOrEqual(32);
  });

  it("bounds an unfiltered result by the requested token budget", () => {
    const result = sliceRefContent("token ".repeat(100), {
      max_tokens: 5,
    });

    expect(result.truncated).toBe(true);
    expect(getEncoding("o200k_base").encode(result.content).length).toBeLessThanOrEqual(5);
  });

  it("bounds a query that is itself larger than the token budget", () => {
    const query = "needle ".repeat(20);
    const result = sliceRefContent(`before ${query} after`, {
      query,
      max_tokens: 3,
    });

    expect(result.truncated).toBe(true);
    expect(result.match_found).toBe(true);
    expect(getEncoding("o200k_base").encode(result.content).length).toBeLessThanOrEqual(3);
  });

  it("returns an explicit no-match result", () => {
    expect(sliceRefContent("alpha\nbeta", {
      query: "missing",
      max_tokens: 100,
    })).toEqual({
      content: "",
      truncated: false,
      match_found: false,
    });
  });
});

describe("compaction recovery hint", () => {
  it("keeps the existing Chinese wording while pointing to the V2 route", () => {
    const message: any = { role: "tool", content: "raw result" };

    replaceWithSummary(message, {
      tool_call_id: "call-1",
      tool_call: "search",
      summary: "result summary",
      timestamp: "2026-07-24T00:00:00Z",
      score: 2,
      node_id: "node-1",
      result_ref: "offload/session-1/refs/call-1.md",
    });

    expect(message.content).toContain("原始工具结果已存档，如需查看完整内容请调用");
    expect(message.content).toContain("POST /v2/offload/read-ref");
    expect(message.content).not.toContain("tdai_read_cos");
  });
});

describe("handleReadRef", () => {
  it("reads an owned reference and wraps the response", async () => {
    const { storage, readFile } = storageWith("archived result");
    let sent: { status: number; body: any } | undefined;
    const { successEnvelope, errorEnvelope } = envelopes();

    await handleReadRef(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      auth,
      storage,
      requestId,
      async () => ({
        session_id: "session-1",
        result_ref: "offload/session-1/refs/call-1.md",
      }),
      (_res, status, body) => { sent = { status, body }; },
      successEnvelope,
      errorEnvelope,
    );

    expect(readFile).toHaveBeenCalledWith("offload/session-1/refs/call-1.md");
    expect(sent).toEqual({
      status: 200,
      body: {
        code: 0,
        message: "ok",
        request_id: requestId,
        data: {
          result_ref: "offload/session-1/refs/call-1.md",
          content: "archived result",
          truncated: false,
        },
      },
    });
  });

  it("hides invalid, cross-session, and missing references behind 404", async () => {
    const { successEnvelope, errorEnvelope } = envelopes();
    for (const testCase of [
      {
        resultRef: "offload/other-session/refs/call-1.md",
        stored: "must not be read",
        expectedReads: 0,
      },
      {
        resultRef: "offload/session-1/refs/missing.md",
        stored: null,
        expectedReads: 1,
      },
    ]) {
      const { storage, readFile } = storageWith(testCase.stored);
      let sent: { status: number; body: any } | undefined;

      await handleReadRef(
        {} as http.IncomingMessage,
        {} as http.ServerResponse,
        auth,
        storage,
        requestId,
        async () => ({
          session_id: "session-1",
          result_ref: testCase.resultRef,
        }),
        (_res, status, body) => { sent = { status, body }; },
        successEnvelope,
        errorEnvelope,
      );

      expect(readFile).toHaveBeenCalledTimes(testCase.expectedReads);
      expect(sent?.status).toBe(404);
      expect(sent?.body.message).toBe("result_ref not found");
    }
  });

  it("rejects requests above the server token cap", async () => {
    const { storage, readFile } = storageWith("must not be read");
    let sent: { status: number; body: any } | undefined;
    const { successEnvelope, errorEnvelope } = envelopes();

    await handleReadRef(
      {} as http.IncomingMessage,
      {} as http.ServerResponse,
      auth,
      storage,
      requestId,
      async () => ({
        session_id: "session-1",
        result_ref: "offload/session-1/refs/call-1.md",
        max_tokens: 4097,
      }),
      (_res, status, body) => { sent = { status, body }; },
      successEnvelope,
      errorEnvelope,
    );

    expect(readFile).not.toHaveBeenCalled();
    expect(sent?.status).toBe(400);
  });

  it("is dispatched by the authenticated Offload V2 router", async () => {
    const { storage } = storageWith("routed content");
    const req = {
      headers: {
        authorization: "Bearer test-key",
        "x-tdai-service-id": "service-test",
      },
    } as http.IncomingMessage;
    let sent: { status: number; body: any } | undefined;

    const handled = await handleOffloadV2Route(
      req,
      {} as http.ServerResponse,
      "/v2/offload/read-ref/",
      "POST",
      async () => ({
        session_id: "session-1",
        result_ref: "offload/session-1/refs/call-1.md",
      }),
      (_res, status, body) => { sent = { status, body }; },
      {
        getStorage: () => storage,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );

    expect(handled).toBe(true);
    expect(sent?.status).toBe(200);
    expect(sent?.body.data.content).toBe("routed content");
  });
});
