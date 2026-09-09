import { describe, it, expect, beforeEach } from "vitest";
import {
  createOrReusePendingToken,
  validateInitLinkToken,
  claimInitLinkToken,
  completeInitLinkToken,
  releaseInitLinkToken,
  markInitLinkNoticeDelivered,
  invalidateInitLinkTokens,
  invalidateInitLinkTokensForSession,
  buildInitLinkUrl,
  buildInitLinkNotice,
  appendInitNoticeToTerminalCompletion,
  __resetInitLinkStoreForTests,
  __initLinkStoreSizeForTests,
  DEFAULT_TTL_MINUTES,
} from "../init-link.js";

const baseParams = {
  compositeKey: "hermes:ses_123",
  sessionId: "ses_123",
  agentSource: "hermes",
  userId: "u1",
  userKey: "sk-test",
  spaceId: "sp1",
  purpose: "init" as const,
};

describe("init-link token store", () => {
  beforeEach(() => {
    __resetInitLinkStoreForTests();
  });

  it("creates a pending token", () => {
    const { record, created } = createOrReusePendingToken(baseParams);
    expect(created).toBe(true);
    expect(record.status).toBe("pending");
    expect(record.token).toHaveLength(32);
    expect(record.expiresAt).toBeGreaterThan(record.createdAt);
  });

  it("reuses existing pending token for same identity", () => {
    const first = createOrReusePendingToken(baseParams);
    const second = createOrReusePendingToken(baseParams);
    expect(second.created).toBe(false);
    expect(second.record.token).toBe(first.record.token);
  });

  it("validates a pending token", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const v = validateInitLinkToken(record.token);
    expect(v.ok).toBe(true);
  });

  it("rejects unknown token", () => {
    const v = validateInitLinkToken("nonexistent");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_found");
  });

  it("claim → complete lifecycle", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.record.status).toBe("processing");
      expect(claim.claimId).toBeDefined();
      const completed = completeInitLinkToken(record.token, claim.claimId);
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.record.status).toBe("consumed");
    }
  });

  it("complete with wrong claimId fails", () => {
    const { record } = createOrReusePendingToken(baseParams);
    claimInitLinkToken(record.token);
    const result = completeInitLinkToken(record.token, "wrong-claim");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("claim_mismatch");
  });

  it("release returns token to pending", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    if (!claim.ok) throw new Error("claim failed");
    const released = releaseInitLinkToken(record.token, claim.claimId);
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.record.status).toBe("pending");
  });

  it("consumed token rejects further validation", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    if (claim.ok) completeInitLinkToken(record.token, claim.claimId);
    const v = validateInitLinkToken(record.token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("consumed");
  });

  it("markInitLinkNoticeDelivered sets timestamp once", () => {
    const { record } = createOrReusePendingToken(baseParams);
    expect(markInitLinkNoticeDelivered(record.token)).toBe(true);
    expect(markInitLinkNoticeDelivered(record.token)).toBe(false);
  });

  it("invalidateInitLinkTokens removes by identity", () => {
    createOrReusePendingToken(baseParams);
    expect(__initLinkStoreSizeForTests()).toBe(1);
    invalidateInitLinkTokens(baseParams);
    expect(__initLinkStoreSizeForTests()).toBe(0);
  });

  it("invalidateInitLinkTokensForSession removes by compositeKey", () => {
    createOrReusePendingToken(baseParams);
    expect(__initLinkStoreSizeForTests()).toBe(1);
    const removed = invalidateInitLinkTokensForSession(baseParams.compositeKey);
    expect(removed).toBe(1);
    expect(__initLinkStoreSizeForTests()).toBe(0);
  });
});

describe("init-link URL and notice", () => {
  it("buildInitLinkUrl encodes proxy and token", () => {
    const url = buildInitLinkUrl("http://hub:8125", "http://proxy:8096", "abc123");
    expect(url).toContain("http://hub:8125/#/session-init");
    expect(url).toContain("proxy=http%3A%2F%2Fproxy%3A8096");
    expect(url).toContain("token=abc123");
  });

  it("buildInitLinkNotice init purpose", () => {
    const url = "http://hub:8125/#/session-init?token=abc";
    const notice = buildInitLinkNotice(url, "init", 10);
    expect(notice).toContain("TencentDB Agent Memory");
    expect(notice).toContain(url);
    expect(notice).toContain("10");
  });

  it("buildInitLinkNotice rebind purpose", () => {
    const url = "http://hub:8125/#/session-init?token=abc";
    const notice = buildInitLinkNotice(url, "rebind", 10);
    expect(notice).toContain("mem:session-reset");
    expect(notice).toContain(url);
  });
});

describe("appendInitNoticeToTerminalCompletion", () => {
  it("appends notice to stop completion with string content", () => {
    const json = {
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Hello" },
      }],
    };
    const result = appendInitNoticeToTerminalCompletion(json, () => "\n\n[init link]");
    expect(result).toBe(true);
    expect((json.choices[0].message as { content: string }).content).toBe("Hello\n\n[init link]");
  });

  it("does not append when finish_reason is tool_calls", () => {
    const json = {
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "Hello", tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] },
      }],
    };
    const result = appendInitNoticeToTerminalCompletion(json, () => "\n\n[init link]");
    expect(result).toBe(false);
  });

  it("does not append when noticeFactory returns null", () => {
    const json = {
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello" } }],
    };
    const result = appendInitNoticeToTerminalCompletion(json, () => null);
    expect(result).toBe(false);
  });

  it("returns false for empty choices", () => {
    const result = appendInitNoticeToTerminalCompletion({ choices: [] }, () => "x");
    expect(result).toBe(false);
  });
});
