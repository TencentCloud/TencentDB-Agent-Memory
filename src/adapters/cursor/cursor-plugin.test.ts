import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureResponse, config, enrichFromTranscript, gatewayRequest, parseWindowsHookInput, pruneState, recoverWindowsHookText, rememberPrompt, sessionRecall } from "../../../adapters/cursor/scripts/core.mjs";

function testConfig(stateDir: string) {
  return config({ TDAI_CURSOR_STATE_DIR: stateDir, TDAI_CURSOR_AGENT_ID: "project-a", TDAI_GATEWAY_URL: "http://gateway.test" });
}

describe("Cursor adapter", () => {
  it("recovers UTF-8 text decoded as GBK by the Windows hook runner", () => {
    expect(recoverWindowsHookText("楠岃瘉鐮佹槸鈥滈潚楦?8420")).toContain("验证码是“青");
    expect(recoverWindowsHookText("already correct ASCII")).toBe("already correct ASCII");
    expect(recoverWindowsHookText("正确中文")).toBe("正确中文");
  });

  it("salvages a response whose mojibake punctuation broke JSON", () => {
    const raw = '{"conversation_id":"conv-1","generation_id":"gen-1","text":"宸叉洿鏂帮細**鏈€缁堥獙璇佺爜鏄?`闈掗笩8421`**銆俓n\n涔嬪墠鐨?`闈掗笩-8420` 浣滃簾銆?,"input_tokens":47335,"session_id":"conv-1","hook_event_name":"afterAgentResponse"}';
    expect(parseWindowsHookInput(raw)).toMatchObject({
      conversation_id: "conv-1",
      generation_id: "gen-1",
      hook_event_name: "afterAgentResponse",
      text: expect.stringContaining("8421"),
    });
  });

  it("continues to parse valid prompt hook JSON", () => {
    expect(parseWindowsHookInput(JSON.stringify({
      conversation_id: "conv-1", generation_id: "gen-1", prompt: "最终验证码是青鸟8421",
      attachments: [], hook_event_name: "beforeSubmitPrompt",
    }))).toMatchObject({ prompt: "最终验证码是青鸟8421" });
  });

  it("replaces lossy hook text with canonical UTF-8 transcript content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-cursor-transcript-"));
    const transcript = path.join(dir, "turn.jsonl");
    await writeFile(transcript, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\n最终验证码是青鸟8421\n</user_query>" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "已更新：青鸟8421" }] } }),
    ].join("\n"), "utf8");
    expect(await enrichFromTranscript({ hook_event_name: "afterAgentResponse", transcript_path: transcript, text: "乱码?8421" }))
      .toMatchObject({ prompt: "最终验证码是青鸟8421", text: "已更新：青鸟8421" });
    expect(await enrichFromTranscript({ hook_event_name: "beforeSubmitPrompt", transcript_path: transcript, prompt: "当前问题" }))
      .toMatchObject({ prompt: "当前问题" });
  });

  it("treats unresolved Cursor variable placeholders as defaults", () => {
    expect(config({
      TDAI_GATEWAY_URL: "${TDAI_GATEWAY_URL}",
      TDAI_GATEWAY_API_KEY: "${TDAI_GATEWAY_API_KEY}",
      TDAI_CURSOR_AGENT_ID: "${TDAI_CURSOR_AGENT_ID}",
    })).toMatchObject({
      gatewayUrl: "http://127.0.0.1:8420",
      apiKey: "",
      agentId: "cursor",
    });
  });

  it("prunes abandoned pending turns and expired idempotency markers", () => {
    const now = Date.now();
    const state = { version: 1, conversations: {
      stale: { pending: { old: { prompt: "old", createdAt: now - 8 * 86400000 } }, captured: {} },
      active: { pending: { current: { prompt: "current", createdAt: now } }, captured: {
        expired: { fingerprint: "x", capturedAt: now - 31 * 86400000 },
      } },
    } };
    expect(pruneState(state, now)).toEqual({ version: 1, conversations: {
      active: { pending: { current: { prompt: "current", createdAt: now } }, captured: {} },
    } });
  });

  it("keeps the agent scope stable and preserves the Cursor conversation ID", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tdai-cursor-"));
    const cfg = testConfig(stateDir);
    const request = vi.fn().mockResolvedValue({ l0_recorded: 2 });
    const turn = { conversation_id: "conv-1", generation_id: "gen-1" };
    await rememberPrompt({ ...turn, prompt: "release codename?" }, cfg);
    await captureResponse({ ...turn, text: "North Star" }, cfg, request);
    expect(request).toHaveBeenCalledWith("/capture", expect.objectContaining({
      session_key: "agent:project-a:cursor", session_id: "conv-1",
    }), { config: cfg });
  });

  it("captures each generation at most once", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tdai-cursor-"));
    const cfg = testConfig(stateDir);
    const request = vi.fn().mockResolvedValue({ l0_recorded: 2 });
    const turn = { conversation_id: "conv-1", generation_id: "gen-1" };
    await rememberPrompt({ ...turn, prompt: "hello" }, cfg);
    await captureResponse({ ...turn, text: "world" }, cfg, request);
    expect(await captureResponse({ ...turn, text: "world" }, cfg, request)).toEqual({ duplicate: true });
    expect(request).toHaveBeenCalledTimes(1);
    const state = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    expect(state.conversations["conv-1"].captured["gen-1"]).toBeTruthy();
  });

  it("retains a pending turn when the Gateway is unavailable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tdai-cursor-"));
    const cfg = testConfig(stateDir);
    const turn = { conversation_id: "conv-1", generation_id: "gen-1" };
    await rememberPrompt({ ...turn, prompt: "hello" }, cfg);
    await expect(captureResponse({ ...turn, text: "world" }, cfg,
      vi.fn().mockRejectedValue(new Error("offline")))).rejects.toThrow("offline");
    const state = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    expect(state.conversations["conv-1"].pending["gen-1"].prompt).toBe("hello");
  });

  it("recalls initial context from the same agent scope", async () => {
    const cfg = testConfig("unused");
    const request = vi.fn().mockResolvedValue({ context: "remembered" });
    expect(await sessionRecall({ user_email: "user@example.com" }, cfg, request)).toEqual({ context: "remembered" });
    expect(request).toHaveBeenCalledWith("/recall", expect.objectContaining({
      session_key: "agent:project-a:cursor", user_id: "user@example.com",
    }), { config: cfg });
  });

  it("surfaces Gateway business errors returned with HTTP 200", async () => {
    const cfg = testConfig("unused");
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ code: 10001, message: "EmbeddingService is unavailable" }),
    });
    await expect(gatewayRequest("/recall", { query: "q", session_key: cfg.sessionKey }, {
      config: cfg, fetch: fakeFetch,
    })).rejects.toThrow("EmbeddingService is unavailable");
  });
});
