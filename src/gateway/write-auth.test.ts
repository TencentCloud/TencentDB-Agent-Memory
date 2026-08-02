/**
 * P2 — write-gate: EITHER `Authorization: Bearer <apiKey>` (when configured)
 * OR `x-memory-token` — alternative credentials, NOT stacked on checkAuth.
 */
import { describe, it, expect } from "vitest";
import { checkWriteAuth } from "./write-auth.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const API_KEY = "sk-secret-api-key";

describe("checkWriteAuth (P2)", () => {
  it("rejects when no credential is present (token required even in open mode)", () => {
    expect(checkWriteAuth({}, API_KEY, TOKEN)).toBe(false);
    expect(checkWriteAuth({}, undefined, TOKEN)).toBe(false);
  });

  it("accepts a valid x-memory-token (trimmed)", () => {
    expect(checkWriteAuth({ "x-memory-token": TOKEN }, API_KEY, TOKEN)).toBe(true);
    expect(checkWriteAuth({ "x-memory-token": `  ${TOKEN}  ` }, API_KEY, TOKEN)).toBe(true);
  });

  it("rejects a wrong or empty x-memory-token", () => {
    expect(checkWriteAuth({ "x-memory-token": "wrong-token" }, API_KEY, TOKEN)).toBe(false);
    expect(checkWriteAuth({ "x-memory-token": "   " }, API_KEY, TOKEN)).toBe(false);
  });

  it("accepts a valid Bearer apiKey when an apiKey is configured", () => {
    expect(checkWriteAuth({ authorization: `Bearer ${API_KEY}` }, API_KEY, TOKEN)).toBe(true);
  });

  it("rejects Bearer when NO apiKey is configured (unconfigured secret cannot validate)", () => {
    expect(checkWriteAuth({ authorization: `Bearer anything` }, undefined, TOKEN)).toBe(false);
  });

  it("rejects malformed or wrong Bearer when an apiKey is configured", () => {
    expect(checkWriteAuth({ authorization: "Basic abc" }, API_KEY, TOKEN)).toBe(false);
    expect(checkWriteAuth({ authorization: `Bearer wrong` }, API_KEY, TOKEN)).toBe(false);
    expect(checkWriteAuth({ authorization: `Bearer ${API_KEY} ` }, API_KEY, TOKEN)).toBe(true); // trailing space trimmed
  });

  it("OR-composition: a valid token still passes with a wrong Bearer and vice versa", () => {
    expect(checkWriteAuth({ authorization: "Bearer wrong", "x-memory-token": TOKEN }, API_KEY, TOKEN)).toBe(true);
    expect(checkWriteAuth({ authorization: `Bearer ${API_KEY}`, "x-memory-token": "wrong" }, API_KEY, TOKEN)).toBe(true);
  });
});
