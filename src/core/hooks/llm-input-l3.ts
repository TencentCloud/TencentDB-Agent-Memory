import { invalidateTokenCache } from "./context-token-tracker";

export function llmInputL3(msg: any) {
  // Hook logic...
  msg.content.splice(0, 1);
  invalidateTokenCache(msg);
}
