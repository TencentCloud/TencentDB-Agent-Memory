import { describe, expect, it } from "vitest";
import {
  createPendingSubscriptionOAuth,
  parseSubscriptionOAuthCode,
  subscriptionAuthorizeUrl,
} from "./authorize-url.js";

describe("subscription authorize url", () => {
  it("builds the Claude Code login URL and keeps the verifier off it", () => {
    const pending = createPendingSubscriptionOAuth("claude", 1_800_000_000_000);
    const url = new URL(subscriptionAuthorizeUrl(pending));
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("scope")).toContain("user:inference");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.toString()).not.toContain(pending.codeVerifier);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(pending.redirectUri).toBe("https://platform.claude.com/oauth/code/callback");
  });

  it("keeps the Codex login URL on the Codex host with its extra parameters", () => {
    const pending = createPendingSubscriptionOAuth("codex", 1_800_000_000_000);
    const url = new URL(subscriptionAuthorizeUrl(pending));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.toString()).not.toContain(pending.codeVerifier);
  });
});

describe("parseSubscriptionOAuthCode", () => {
  it("splits a Claude code#state paste", () => {
    expect(parseSubscriptionOAuthCode("pasted-code#pasted-state", undefined)).toEqual({
      code: "pasted-code",
      pastedState: "pasted-state",
    });
  });

  it("reads code and state from a Codex redirect URL", () => {
    expect(parseSubscriptionOAuthCode(undefined, "http://localhost:1455/auth/callback?code=code-1&state=state-1")).toEqual({
      code: "code-1",
      pastedState: "state-1",
    });
  });

  it("accepts a bare code", () => {
    expect(parseSubscriptionOAuthCode("bare-code", undefined)).toEqual({ code: "bare-code" });
  });

  it("rejects a malformed URL", () => {
    expect(parseSubscriptionOAuthCode("http://", undefined)).toEqual({ code: "" });
  });
});
