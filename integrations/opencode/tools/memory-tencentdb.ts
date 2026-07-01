import { gatewayPost, type GatewayClientOptions } from "../../../src/integrations/shared/gateway-client.js";

export interface OpenCodeMemoryArgs {
  query?: string;
  user_content?: string;
  assistant_content?: string;
  session_key?: string;
  session_id?: string;
  user_id?: string;
  limit?: number;
  type?: string;
  scene?: string;
}

function requireString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing required parameter: ${name}`);
}

export async function recallMemory(args: OpenCodeMemoryArgs, gateway: GatewayClientOptions = {}) {
  return gatewayPost("/recall", {
    query: requireString(args.query, "query"),
    session_key: requireString(args.session_key, "session_key"),
    user_id: args.user_id,
  }, gateway);
}

export async function captureMemory(args: OpenCodeMemoryArgs, gateway: GatewayClientOptions = {}) {
  return gatewayPost("/capture", {
    user_content: requireString(args.user_content, "user_content"),
    assistant_content: requireString(args.assistant_content, "assistant_content"),
    session_key: requireString(args.session_key, "session_key"),
    session_id: args.session_id,
    user_id: args.user_id,
    messages: [
      { role: "user", content: args.user_content },
      { role: "assistant", content: args.assistant_content },
    ],
  }, gateway);
}

export async function searchMemories(args: OpenCodeMemoryArgs, gateway: GatewayClientOptions = {}) {
  return gatewayPost("/search/memories", {
    query: requireString(args.query, "query"),
    limit: args.limit,
    type: args.type,
    scene: args.scene,
  }, gateway);
}

export async function searchConversations(args: OpenCodeMemoryArgs, gateway: GatewayClientOptions = {}) {
  return gatewayPost("/search/conversations", {
    query: requireString(args.query, "query"),
    limit: args.limit,
    session_key: args.session_key,
  }, gateway);
}

export async function endSession(args: OpenCodeMemoryArgs, gateway: GatewayClientOptions = {}) {
  return gatewayPost("/session/end", {
    session_key: requireString(args.session_key, "session_key"),
    user_id: args.user_id,
  }, gateway);
}

export const memoryTencentDbTools = {
  recallMemory,
  captureMemory,
  searchMemories,
  searchConversations,
  endSession,
};

