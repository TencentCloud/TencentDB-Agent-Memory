import { Tiktoken } from "tiktoken";
import { Message, MessageContent } from "./types";
import { invalidateTokenCache } from "./l3-helpers";

const cachedMessageTokens = new WeakMap<Message, Map<boolean, number>>();

export function buildTiktokenContextSnapshot(
  messages: Message[],
  encoding: Tiktoken,
  isOffloaded: boolean
): number {
  let total = 0;
  for (const msg of messages) {
    let tokens = cachedMessageTokens.get(msg)?.get(isOffloaded);
    if (tokens === undefined) {
      tokens = countMessageTokens(msg, encoding, isOffloaded);
      let msgCache = cachedMessageTokens.get(msg);
      if (!msgCache) {
        msgCache = new Map();
        cachedMessageTokens.set(msg, msgCache);
      }
      msgCache.set(isOffloaded, tokens);
    }
    total += tokens;
  }
  return total;
}

function countMessageTokens(msg: Message, encoding: Tiktoken, isOffloaded: boolean): number {
  // Mock implementation of token counting
  return 10; 
}
