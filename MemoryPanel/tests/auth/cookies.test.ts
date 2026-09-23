/**
 * Cookie handling — the auth session surface.
 *
 * `readCookie` parses the inbound `Cookie` header for the session token
 * (see `routes/auth.ts`), and the three `build*Cookie` helpers emit the
 * outbound `Set-Cookie` headers that set, downgrade and clear it. These are
 * the only places the panel touches session credentials on the wire, so the
 * security attributes and the encode/read symmetry are the contract worth
 * pinning:
 *
 *   - `HttpOnly` keeps the session token out of reach of page script;
 *   - `SameSite=Lax` is what stops a cross-site POST from carrying it;
 *   - `Secure` is conditional and must follow `config.auth.sessionSecure`;
 *   - `Max-Age` must never be negative or fractional, and `0` is how a cookie
 *     is expired;
 *   - the value is `encodeURIComponent`-encoded on write, so the reader must
 *     tolerate the encoded form for the round-trip to hold.
 *
 * `MemoryPanel` declares a `test` script and a vitest config that both point
 * at a `tests/` directory that did not exist, so `npm test` exited 1 with
 * "No test files found". This is the first file in that directory.
 */

import { describe, expect, it } from "vitest";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  buildTransientCookie,
  readCookie,
} from "../../src/panel/auth/cookies.js";

describe("readCookie", () => {
  it("returns the value for a single cookie", () => {
    expect(readCookie("session=abc123", "session")).toBe("abc123");
  });

  it("finds the target among several cookies", () => {
    expect(readCookie("a=1; session=abc; b=2", "session")).toBe("abc");
  });

  it("keeps '=' inside the value (padded base64 / signed tokens)", () => {
    // Splitting on the FIRST '=' only: the rest of the value is rejoined.
    expect(readCookie("session=abc==", "session")).toBe("abc==");
    expect(readCookie("sig=aaa=bbb", "sig")).toBe("aaa=bbb");
  });

  it("tolerates leading whitespace and tabs around separators", () => {
    expect(readCookie("  session=abc", "session")).toBe("abc");
    expect(readCookie("a=1;\tsession=abc", "session")).toBe("abc");
    expect(readCookie("a=1 ;  session=abc", "session")).toBe("abc");
  });

  it("tolerates a leading semicolon", () => {
    expect(readCookie("; session=abc", "session")).toBe("abc");
  });

  it("returns undefined when the cookie is absent", () => {
    expect(readCookie("a=1; b=2", "session")).toBeUndefined();
  });

  it("returns undefined for an empty or missing header", () => {
    expect(readCookie("", "session")).toBeUndefined();
    expect(readCookie(undefined, "session")).toBeUndefined();
  });

  it("treats an empty value as absent rather than an empty string", () => {
    // `value.join('=') || undefined` — an empty value is falsy, so it is
    // reported as "not present". Callers therefore cannot mistake
    // `session=` for a valid (empty) token.
    expect(readCookie("session=", "session")).toBeUndefined();
    expect(readCookie("session", "session")).toBeUndefined();
  });

  it("is case-sensitive on the cookie name, per RFC 6265", () => {
    expect(readCookie("Session=abc", "session")).toBeUndefined();
  });

  it("does not confuse a name that is a prefix of another", () => {
    expect(readCookie("session_extra=nope; session=abc", "session")).toBe("abc");
  });

  it("round-trips the value buildSessionCookie writes", () => {
    // buildSessionCookie encodeURIComponent-encodes the token; the reader must
    // hand back exactly what was written so the lookup key matches the store.
    // randomUUID() output is hex + hyphens, which encodeURIComponent leaves
    // alone — that is why this round-trip holds for real session tokens.
    const token = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const header = buildSessionCookie("tdai_session", token, 3600, false);
    expect(readCookie(header, "tdai_session")).toBe(token);
  });
});

describe("buildSessionCookie", () => {
  it("sets the security attributes the session token depends on", () => {
    const cookie = buildSessionCookie("tdai_session", "tok", 3600, false);
    expect(cookie).toContain("tdai_session=tok");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=3600");
  });

  it("omits Secure when the deployment is not TLS", () => {
    expect(buildSessionCookie("s", "t", 60, false)).not.toContain("Secure");
  });

  it("adds Secure when the deployment is TLS", () => {
    expect(buildSessionCookie("s", "t", 60, true)).toContain("Secure");
  });

  it("percent-encodes the value so it cannot break out of the header", () => {
    // A raw ';' or CR/LF in the value would split the header or inject one.
    const cookie = buildSessionCookie("s", "a;b\r\nX-Evil: 1", 60, false);
    expect(cookie).not.toContain("\r");
    expect(cookie).not.toContain("\n");
    expect(cookie).toContain("s=a%3Bb%0D%0AX-Evil%3A%201");
  });

  it("clamps a negative max-age to 0 instead of emitting a negative Max-Age", () => {
    expect(buildSessionCookie("s", "t", -5, false)).toContain("Max-Age=0");
  });

  it("floors a fractional max-age — Max-Age is an integer field", () => {
    expect(buildSessionCookie("s", "t", 90.9, false)).toContain("Max-Age=90");
  });

  it("treats max-age 0 as an expiry, which is what logout relies on", () => {
    expect(buildSessionCookie("s", "t", 0, false)).toContain("Max-Age=0");
  });
});

describe("buildTransientCookie", () => {
  it("carries the same security attributes but no Max-Age", () => {
    const cookie = buildTransientCookie("tdai_woa_dismissed", "1", false);
    expect(cookie).toContain("tdai_woa_dismissed=1");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Max-Age");
    expect(cookie).not.toContain("Expires");
  });

  it("omits Secure on plain HTTP and adds it on TLS", () => {
    expect(buildTransientCookie("c", "v", false)).not.toContain("Secure");
    expect(buildTransientCookie("c", "v", true)).toContain("Secure");
  });

  it("percent-encodes the value", () => {
    expect(buildTransientCookie("c", "a b", false)).toContain("c=a%20b");
  });

  it("differs from buildSessionCookie precisely by the absence of Max-Age", () => {
    const transient = buildTransientCookie("c", "v", true);
    const session = buildSessionCookie("c", "v", 60, true);
    // Drop the Max-Age segment from the session cookie (it sits before Secure,
    // so it is not anchored to the end of the string).
    expect(transient).toBe(session.replace(/; Max-Age=\d+/, ""));
  });
});

describe("buildExpiredSessionCookie", () => {
  it("is a session cookie with an empty value and Max-Age=0", () => {
    const cookie = buildExpiredSessionCookie("tdai_session", false);
    expect(cookie).toContain("tdai_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });

  it("keeps the same attributes as the live cookie so the browser matches it", () => {
    // A Set-Cookie that differs in Path/HttpOnly/SameSite/Secure will not
    // overwrite the cookie being cleared, which is how "logout did not work"
    // bugs start. Max-Age is deliberately excluded: 0 vs the live value IS the
    // clearing mechanism, so it is expected to differ.
    const live = buildSessionCookie("tdai_session", "tok", 3600, true);
    const expired = buildExpiredSessionCookie("tdai_session", true);
    const attrs = (s: string) =>
      s.split("; ").slice(1).filter((a) => !a.startsWith("Max-Age=")).sort();
    expect(attrs(expired)).toEqual(attrs(live));
    // And the difference really is only Max-Age.
    expect(expired).toContain("Max-Age=0");
    expect(live).toContain("Max-Age=3600");
  });

  it("preserves the Secure flag from the caller", () => {
    expect(buildExpiredSessionCookie("s", true)).toContain("Secure");
    expect(buildExpiredSessionCookie("s", false)).not.toContain("Secure");
  });

  it("reads back as absent, so a cleared session cannot authenticate", () => {
    const cookie = buildExpiredSessionCookie("tdai_session", false);
    expect(readCookie(cookie, "tdai_session")).toBeUndefined();
  });
});
