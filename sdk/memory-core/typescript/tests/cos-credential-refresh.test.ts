import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFileReader, StsCredentialManager, type StsCredential } from "../src/cos.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function response(id: string) {
  return Response.json({ CosUrl: "https://test.cos.ap-guangzhou.myqcloud.com",
    TmpSecretId: id, TmpSecretKey: "fake-secret", TmpToken: "fake-token",
    ExpirationTime: "", PathPrefix: "memory" });
}
function manager() {
  return new StsCredentialManager({ endpoint: "https://sts.example", apiKey: "fake-key", serviceId: "test" });
}
function rejectCredential(m: StsCredentialManager, cred: StsCredential) {
  // Keep the regression executable against the previous no-argument API too.
  (m.invalidate as (credential?: StsCredential) => void)(cred);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("STS refresh ownership", () => {
  it("shares concurrent acquisition and reuses the cached object", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", fetch);
    const m = manager(); const reads = Array.from({ length: 6 }, () => m.getCredential());
    expect(fetch).toHaveBeenCalledTimes(1); pending.resolve(response("A"));
    const creds = await Promise.all(reads);
    expect(creds.every(c => c === creds[0])).toBe(true);
    expect(await m.getCredential()).toBe(creds[0]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not let detached refresh A overwrite replacement B", async () => {
    const a = deferred<Response>(); const b = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise); vi.stubGlobal("fetch", fetch);
    const m = manager(); const first = m.getCredential(); m.invalidate(); const second = m.getCredential();
    b.resolve(response("B")); const replacement = await second;
    a.resolve(response("A")); expect((await first).tmpSecretId).toBe("A");
    expect(await m.getCredential()).toBe(replacement); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "failure"])("detached A %s cannot clear pending B", async outcome => {
    const a = deferred<Response>(); const b = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(a.promise).mockReturnValue(b.promise); vi.stubGlobal("fetch", fetch);
    const m = manager(); const first = m.getCredential().catch(e => e); m.invalidate(); const second = m.getCredential();
    if (outcome === "success") a.resolve(response("A")); else a.reject(new Error("network"));
    await first; const third = m.getCredential(); expect(fetch).toHaveBeenCalledTimes(2);
    b.resolve(response("B")); const replacement = await second;
    expect(await third).toBe(replacement);
  });
  it("keeps a replacement already cached when an old credential is rejected", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response("A")).mockImplementation(async () => response("B")); vi.stubGlobal("fetch", fetch);
    const m = manager(); const old = await m.getCredential(); m.invalidate(); const replacement = await m.getCredential();
    rejectCredential(m, old); expect(await m.getCredential()).toBe(replacement); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps an expiry refresh in flight when its old cached credential is rejected", async () => {
    vi.useFakeTimers(); const b = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response("A")).mockReturnValue(b.promise); vi.stubGlobal("fetch", fetch);
    const m = manager(); const old = await m.getCredential(); vi.setSystemTime(Date.now() + 31 * 60_000);
    const second = m.getCredential(); rejectCredential(m, old); const third = m.getCredential();
    expect(fetch).toHaveBeenCalledTimes(2); b.resolve(response("B")); expect(await third).toBe(await second);
  });
  it("allows retry after a shared refresh fails", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response("B")); vi.stubGlobal("fetch", fetch);
    const m = manager(); const results = await Promise.allSettled([m.getCredential(), m.getCredential()]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect((await m.getCredential()).tmpSecretId).toBe("B"); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("file reads with rejected credentials", () => {
  it("coalesces six concurrent 403 replacements into one STS request", async () => {
    let sts = 0; const replacement = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://sts.example")) return ++sts === 1 ? response("A") : (await replacement.promise).clone();
      return new Response("content", { status: new Headers(init?.headers).get("authorization")!.includes("q-ak=A&") ? 403 : 200 });
    }));
    const m = manager(); await m.getCredential();
    const reads = Array.from({ length: 6 }, () => new MemoryFileReader(m).read("persona.md"));
    await vi.waitFor(() => expect(sts).toBeGreaterThan(1));
    replacement.resolve(response("B")); expect(await Promise.all(reads)).toEqual(Array(6).fill("content")); expect(sts).toBe(2);
  });
  it("late read A 403 reuses completed replacement B", async () => {
    let sts = 0; const late = deferred<Response>(); const started = deferred<void>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://sts.example")) return response(++sts === 1 ? "A" : "B");
      if (new Headers(init?.headers).get("authorization")!.includes("q-ak=A&")) { started.resolve(); return late.promise; }
      return new Response("content");
    }));
    const m = manager(); const read = new MemoryFileReader(m).read("persona.md"); await started.promise;
    m.invalidate(); const replacement = await m.getCredential(); late.resolve(new Response("expired", { status: 403 }));
    expect(await read).toBe("content"); expect(await m.getCredential()).toBe(replacement); expect(sts).toBe(2);
  });
  it("invalidates a rejected retry credential without adding another file retry", async () => {
    let sts = 0; let gets = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("https://sts.example")) return response(String(++sts));
      gets++; return new Response("denied", { status: 403 });
    }));
    const m = manager(); await expect(new MemoryFileReader(m).read("persona.md")).rejects.toThrow("HTTP 403");
    expect(gets).toBe(2); expect((await m.getCredential()).tmpSecretId).toBe("3");
  });
});

describe("native HTTP STS transport", () => {
  it("shares one HTTP request and retains the response credential", async () => {
    const { createServer } = await import("node:http");
    let requests = 0;
    const server = createServer(async (req, res) => {
      requests++;
      expect(req.url).toBe("/v2/cos/secret");
      expect(req.headers["x-tdai-service-id"]).toBe("test");
      res.setHeader("content-type", "application/json");
      res.end(await response("http").text());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const m = new StsCredentialManager({ endpoint: `http://127.0.0.1:${address.port}`, apiKey: "fake", serviceId: "test" });
      const credentials = await Promise.all(Array.from({ length: 6 }, () => m.getCredential()));
      expect(credentials.every(c => c === credentials[0])).toBe(true);
      expect(await m.getCredential()).toBe(credentials[0]);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
  it("releases the refresh after an HTTP timeout so the next request can recover", async () => {
    const { createServer } = await import("node:http");
    let ready = false;
    const server = createServer(async (_req, res) => {
      if (!ready) return; // Leave the first response pending until the client aborts.
      res.end(await response("recovered").text());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const m = new StsCredentialManager({ endpoint: `http://127.0.0.1:${address.port}`, apiKey: "fake", serviceId: "test", timeout: 200 });
      await expect(m.getCredential()).rejects.toMatchObject({ name: "AbortError" });
      ready = true;
      expect((await m.getCredential()).tmpSecretId).toBe("recovered");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
});
