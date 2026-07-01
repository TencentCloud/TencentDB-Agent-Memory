import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { gatewayHeaders, gatewayUrl } from "./shared/gateway-client.js";

const root = process.cwd();

describe("Dify adapter assets", () => {
  it("maps Dify Custom Tool operations to the Gateway contract", async () => {
    const schema = JSON.parse(
      await readFile(join(root, "integrations/dify/openapi.json"), "utf-8"),
    );

    expect(Object.keys(schema.paths)).toEqual([
      "/recall",
      "/capture",
      "/search/memories",
      "/search/conversations",
      "/session/end",
    ]);
    expect(schema.paths["/recall"].post.operationId).toBe("memoryTencentdbRecall");
    expect(schema.paths["/capture"].post.operationId).toBe("memoryTencentdbCapture");
    expect(schema.paths["/search/memories"].post.operationId).toBe("memoryTencentdbSearchMemories");
    expect(schema.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(schema.components.schemas.CaptureRequest.required).toEqual([
      "user_content",
      "assistant_content",
      "session_key",
    ]);
  });

  it("keeps the HTTP workflow wired as recall, llm, capture", async () => {
    const workflow = JSON.parse(
      await readFile(join(root, "integrations/dify/workflow-http-request.json"), "utf-8"),
    );

    expect(workflow.steps.map((step: { id: string }) => step.id)).toEqual([
      "pre_recall",
      "llm",
      "post_capture",
    ]);
    expect(workflow.steps[0]).toMatchObject({
      method: "POST",
      url: "{{ MEMORY_TENCENTDB_GATEWAY_URL }}/recall",
      body: {
        query: "{{ sys.query }}",
        session_key: "{{ conversation_id }}",
        user_id: "{{ user }}",
      },
    });
    expect(workflow.steps[2].body).toMatchObject({
      user_content: "{{ sys.query }}",
      assistant_content: "{{ llm.text }}",
      session_key: "{{ conversation_id }}",
    });
  });

  it("resolves Gateway URL and auth headers for Dify HTTP requests", () => {
    const env = {
      MEMORY_TENCENTDB_GATEWAY_URL: "http://localhost:9527/",
      MEMORY_TENCENTDB_GATEWAY_API_KEY: "secret",
    };

    expect(gatewayUrl("/recall", { env })).toBe("http://localhost:9527/recall");
    expect(gatewayHeaders({ env })).toEqual({ Authorization: "Bearer secret" });
  });
});

