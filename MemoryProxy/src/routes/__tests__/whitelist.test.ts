/**
 * Whitelist 路径规范化单测 —— hermes 前缀注册（#1195 pi 模式）+ 既有前缀回归。
 *
 * 覆盖：
 *   - `/hermes/v1/...` 与 `/hermes/{spaceId}/v1/...` 前缀剥离
 *   - `/hermes` 路径上的 cost-guard / analyse marker
 *   - `/hermes` 路径白名单端点匹配（openai 协议主端点 / 辅助端点）
 *   - 既有 agent 前缀（claude-code / codebuddy）回归
 */
import { describe, expect, it } from "vitest";
import {
  hasAnalyseMarker,
  hasCostGuardMarker,
  matchWhitelistEndpoint,
  normalizeWhitelistRequestPath,
} from "../whitelist.js";

describe("normalizeWhitelistRequestPath — hermes", () => {
  it("strips /hermes prefix (no spaceId)", () => {
    expect(normalizeWhitelistRequestPath("/hermes/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("strips /hermes/{spaceId} prefix", () => {
    expect(normalizeWhitelistRequestPath("/hermes/default/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeWhitelistRequestPath("/hermes/d03qdb2oty/v1/completions")).toBe("/v1/completions");
  });

  it("strips query string", () => {
    expect(normalizeWhitelistRequestPath("/hermes/default/v1/chat/completions?x=1")).toBe("/v1/chat/completions");
  });

  it("does not strip non-hermes first segments", () => {
    expect(normalizeWhitelistRequestPath("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeWhitelistRequestPath("/hermesized/v1/chat/completions")).toBe("/hermesized/v1/chat/completions");
  });
});

describe("cost-guard / analyse markers on /hermes paths", () => {
  it("recognizes /cost-guard marker after agent+spaceId", () => {
    expect(hasCostGuardMarker("/hermes/default/cost-guard/v1/chat/completions")).toBe(true);
    expect(hasCostGuardMarker("/hermes/default/v1/chat/completions")).toBe(false);
  });

  it("normalization strips the marker so whitelist matching still works", () => {
    expect(normalizeWhitelistRequestPath("/hermes/default/cost-guard/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("recognizes /analyse marker", () => {
    expect(hasAnalyseMarker("/hermes/default/analyse/v1/chat/completions")).toBe(true);
    expect(hasAnalyseMarker("/hermes/default/v1/chat/completions")).toBe(false);
  });
});

describe("matchWhitelistEndpoint — hermes paths", () => {
  it("matches primary openai endpoint", () => {
    const hit = matchWhitelistEndpoint("/hermes/default/v1/chat/completions");
    expect(hit?.pathSuffix).toBe("/v1/chat/completions");
    expect(hit?.protocol).toBe("openai");
    expect(hit?.isPrimary).toBe(true);
  });

  it("matches auxiliary endpoints", () => {
    expect(matchWhitelistEndpoint("/hermes/default/v1/embeddings")?.pathSuffix).toBe("/v1/embeddings");
    expect(matchWhitelistEndpoint("/hermes/v1/completions")?.isPrimary).toBe(false);
  });
});

describe("regression — existing agent prefixes still work", () => {
  it("claude-code (anthropic)", () => {
    expect(normalizeWhitelistRequestPath("/claude-code/v1/messages")).toBe("/v1/messages");
    expect(normalizeWhitelistRequestPath("/claude-code/{spaceId}/v1/messages")).toBe("/v1/messages");
    expect(matchWhitelistEndpoint("/claude-code/v1/messages")?.protocol).toBe("anthropic");
  });

  it("codebuddy (openai)", () => {
    expect(normalizeWhitelistRequestPath("/codebuddy/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(matchWhitelistEndpoint("/codebuddy/v1/chat/completions")?.isPrimary).toBe(true);
  });

  it("codex (responses, bare tail without /v1)", () => {
    expect(normalizeWhitelistRequestPath("/codex/space1/responses")).toBe("/responses");
  });

  it("whitelist entries themselves are not stripped", () => {
    expect(matchWhitelistEndpoint("/v1/chat/completions")?.pathSuffix).toBe("/v1/chat/completions");
  });
});
