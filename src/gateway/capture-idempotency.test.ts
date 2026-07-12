import { describe, expect, it, vi } from "vitest";
import type { CaptureRequest, CaptureResponse } from "./types.js";
import {
  CaptureIdempotencyCapacityError,
  CaptureIdempotencyConflictError,
  CaptureIdempotencyStore,
  fingerprintCaptureRequest,
  isValidCaptureIdempotencyKey,
} from "./capture-idempotency.js";

const RESPONSE: CaptureResponse = { l0_recorded: 2, scheduler_notified: true };

function run(
  store: CaptureIdempotencyStore<CaptureResponse>,
  overrides: Partial<Parameters<typeof store.run>[0]> = {},
) {
  return store.run({
    sessionKey: "session-1",
    idempotencyKey: "turn-1",
    fingerprint: "payload-1",
    execute: async () => RESPONSE,
    ...overrides,
  });
}

function request(overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    user_content: "hello",
    assistant_content: "hi",
    session_key: "session-1",
    idempotency_key: "turn-1",
    ...overrides,
  };
}

describe("CaptureIdempotencyStore", () => {
  it("coalesces in-flight and completed retries", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await gate; return RESPONSE; });
    const store = new CaptureIdempotencyStore<CaptureResponse>();

    const first = run(store, { execute });
    const concurrentRetry = run(store, { execute });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    release();

    await expect(first).resolves.toEqual({ value: RESPONSE, replayed: false });
    await expect(concurrentRetry).resolves.toEqual({ value: RESPONSE, replayed: true });
    await expect(run(store, { execute })).resolves.toEqual({ value: RESPONSE, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a key with a different payload", async () => {
    const store = new CaptureIdempotencyStore<CaptureResponse>();
    await run(store);
    await expect(run(store, { fingerprint: "payload-2" }))
      .rejects.toBeInstanceOf(CaptureIdempotencyConflictError);
  });

  it("removes failures so the same key can retry", async () => {
    const store = new CaptureIdempotencyStore<CaptureResponse>();
    await expect(run(store, {
      execute: async () => { throw new Error("temporary failure"); },
    })).rejects.toThrow("temporary failure");
    await expect(run(store)).resolves.toEqual({ value: RESPONSE, replayed: false });
  });

  it("scopes keys by session and expires completed entries", async () => {
    let now = 1_000;
    const execute = vi.fn(async () => RESPONSE);
    const store = new CaptureIdempotencyStore<CaptureResponse>({ ttlMs: 100, now: () => now });

    await run(store, { execute });
    await expect(run(store, { sessionKey: "session-2", execute }))
      .resolves.toEqual({ value: RESPONSE, replayed: false });
    now += 100;
    await expect(run(store, { execute })).resolves.toEqual({ value: RESPONSE, replayed: false });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("keeps in-flight entries when capacity is exhausted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = new CaptureIdempotencyStore<CaptureResponse>({ maxEntries: 1 });
    const first = run(store, { execute: async () => { await gate; return RESPONSE; } });

    await expect(run(store, { idempotencyKey: "turn-2" }))
      .rejects.toBeInstanceOf(CaptureIdempotencyCapacityError);
    release();
    await first;
    await expect(run(store, { idempotencyKey: "turn-2" }))
      .resolves.toEqual({ value: RESPONSE, replayed: false });
  });
});

describe("capture request identity", () => {
  it("uses canonical payload fingerprints and excludes the client key", () => {
    const first = request({ messages: [{ role: "user", content: "hello" }] });
    const reordered = request({
      idempotency_key: "another-key",
      messages: [{ content: "hello", role: "user" }],
    });

    expect(fingerprintCaptureRequest(first)).toBe(fingerprintCaptureRequest(reordered));
    expect(fingerprintCaptureRequest(first)).not.toBe(
      fingerprintCaptureRequest(request({ assistant_content: "different" })),
    );
  });

  it("accepts only bounded, control-free keys", () => {
    expect(isValidCaptureIdempotencyKey("turn_01HZX8Q2Y7G9")).toBe(true);
    expect(isValidCaptureIdempotencyKey(123)).toBe(false);
    expect(isValidCaptureIdempotencyKey("   ")).toBe(false);
    expect(isValidCaptureIdempotencyKey("turn\n2")).toBe(false);
    expect(isValidCaptureIdempotencyKey("界".repeat(43))).toBe(false);
  });
});
