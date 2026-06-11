import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TdaiGateway } from "./server.js";

function jsonRequest(body: unknown): Readable {
  const req = new Readable({
    read() {
      this.push(JSON.stringify(body));
      this.push(null);
    },
  });
  return req;
}

function jsonResponse() {
  let status = 0;
  let payload = "";

  return {
    response: {
      writeHead(nextStatus: number) {
        status = nextStatus;
      },
      end(chunk: string) {
        payload = chunk;
      },
    },
    get status() {
      return status;
    },
    get body() {
      return JSON.parse(payload) as Record<string, unknown>;
    },
  };
}

describe("TdaiGateway recall", () => {
  it("returns split system and prepend contexts with a backward-compatible context", async () => {
    const gateway = new TdaiGateway();
    (gateway as unknown as { core: unknown }).core = {
      handleBeforeRecall: async () => ({
        appendSystemContext: "<user-persona>stable persona</user-persona>",
        prependContext: "<relevant-memories>L1 fact</relevant-memories>",
        recallStrategy: "hybrid",
        recalledL1Memories: [{ id: "m1" }, { id: "m2" }],
      }),
    };

    const res = jsonResponse();

    await (
      gateway as unknown as {
        handleRecall(req: Readable, res: typeof res.response): Promise<void>;
      }
    ).handleRecall(
      jsonRequest({ query: "hello", session_key: "test-session" }),
      res.response,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      context:
        "<user-persona>stable persona</user-persona>\n\n" +
        "<relevant-memories>L1 fact</relevant-memories>",
      system_context: "<user-persona>stable persona</user-persona>",
      prepend_context: "<relevant-memories>L1 fact</relevant-memories>",
      strategy: "hybrid",
      memory_count: 2,
    });
  });
});
