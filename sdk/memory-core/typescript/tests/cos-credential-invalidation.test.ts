/**
 * Invalidation-generation semantics for `StsCredentialManager`.
 *
 * Four races are covered:
 *   1. many readers rejected on the same cached credential must share a single
 *      replacement STS request;
 *   2. a refresh that completes after a newer one must not overwrite the cache;
 *   3. a rejected refresh must not detach a newer in-flight refresh;
 *   4. a late rejection for a superseded credential must not discard the
 *      replacement that already superseded it.
 *
 * All HTTP is mocked — no live STS or COS request is made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CosSecretResponse,
  MemoryFileReader,
  StsCredentialManager,
} from "../src/cos.js";

const CONFIG = {
  endpoint: "https://memory.example.com",
  apiKey: "fake-api-key",
  serviceId: "fake-service-id",
};

/** A credential valid for `ttlMs` from now (used to drive `isValid`). */
function secret(index: number, ttlMs: number): CosSecretResponse {
  return {
    CosUrl: `https://bucket-${index}.cos.ap-guangzhou.myqcloud.com`,
    TmpSecretId: `fake-id-${index}`,
    TmpSecretKey: `fake-secret-${index}`,
    TmpToken: `fake-token-${index}`,
    ExpirationTime: new Date(Date.now() + ttlMs).toISOString(),
    PathPrefix: `space-${index}`,
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface Deferred {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HOUR = 60 * 60 * 1000;

/** Every intercepted call, in arrival order. */
let calls: { method: string; url: string; settle: Deferred }[] = [];

function stubFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: { method?: string }) => {
      const settle = deferred();
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input),
        settle,
      });
      return settle.promise;
    }),
  );
}

const stsCalls = () => calls.filter((c) => c.method === "POST");
const cosCalls = () => calls.filter((c) => c.method === "GET");

/** Let queued microtasks and one timer turn drain without resolving any call. */
async function settleTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Prime the manager with `ttlMs` of credential lifetime; returns that credential. */
async function prime(
  mgr: StsCredentialManager,
  index: number,
  ttlMs: number,
): Promise<Awaited<ReturnType<typeof mgr.getCredential>>> {
  const pending = mgr.getCredential();
  expect(stsCalls()).toHaveLength(1);
  stsCalls()[0]!.settle.resolve(jsonOk(secret(index, ttlMs)));
  return pending;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StsCredentialManager invalidation generations", () => {
  it("shares one replacement STS request across readers rejected on the same credential", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    const cached = await prime(mgr, 1, HOUR);

    // Six readers each hold this credential, each receives 403, each
    // invalidates it and retries.
    const retries = Array.from({ length: 6 }, () => {
      mgr.invalidate(cached);
      return mgr.getCredential();
    });

    await settleTasks();
    // One priming request plus exactly one replacement — not six.
    expect(stsCalls()).toHaveLength(2);

    stsCalls()[1]!.settle.resolve(jsonOk(secret(2, HOUR)));
    const issued = await Promise.all(retries);

    expect(issued.map((c) => c.tmpSecretId)).toEqual(Array(6).fill("fake-id-2"));
    expect(stsCalls()).toHaveLength(2);
  });

  it("does not let an older refresh overwrite the cache when it completes last", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    // Primed credential is inside the refresh buffer, so it stays cached while a
    // refresh runs — an ordinary expiry path, not an injected state.
    const stale = await prime(mgr, 1, 30_000);

    // Refresh A starts against the current generation.
    const refreshA = mgr.getCredential();
    expect(stsCalls()).toHaveLength(2);

    // A rejection for that same credential invalidates it and opens a new
    // generation, so refresh B starts.
    mgr.invalidate(stale);
    const refreshB = mgr.getCredential();
    expect(stsCalls()).toHaveLength(3);
    const [, callA, callB] = stsCalls();

    // B (the newer generation) completes first and takes the cache.
    callB!.settle.resolve(jsonOk(secret(3, HOUR)));
    expect((await refreshB).tmpSecretId).toBe("fake-id-3");

    // A completes afterwards. Its caller still gets a usable credential, but
    // the cache must keep B's.
    callA!.settle.resolve(jsonOk(secret(2, HOUR)));
    expect((await refreshA).tmpSecretId).toBe("fake-id-2");

    expect((await mgr.getCredential()).tmpSecretId).toBe("fake-id-3");
    expect(stsCalls()).toHaveLength(3);
  });

  it("keeps a newer in-flight refresh joinable when an older one rejects", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    const stale = await prime(mgr, 1, 30_000);

    const refreshA = mgr.getCredential();
    mgr.invalidate(stale);
    const refreshB = mgr.getCredential();
    expect(stsCalls()).toHaveLength(3);

    // A fails while B is still pending.
    stsCalls()[1]!.settle.reject(new Error("STS endpoint unavailable"));
    await expect(refreshA).rejects.toThrow("STS endpoint unavailable");

    // A's cleanup must not detach B: this caller joins B rather than issuing a
    // third request.
    const joined = mgr.getCredential();
    await settleTasks();
    expect(stsCalls()).toHaveLength(3);

    stsCalls()[2]!.settle.resolve(jsonOk(secret(4, HOUR)));
    expect((await joined).tmpSecretId).toBe("fake-id-4");
    expect((await refreshB).tmpSecretId).toBe("fake-id-4");
    expect(stsCalls()).toHaveLength(3);
  });

  it("ignores a late rejection for a credential that has already been replaced", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    const stale = await prime(mgr, 1, HOUR);

    mgr.invalidate(stale);
    const replacement = mgr.getCredential();
    stsCalls()[1]!.settle.resolve(jsonOk(secret(5, HOUR)));
    expect((await replacement).tmpSecretId).toBe("fake-id-5");

    // A read issued with the superseded credential fails after the replacement
    // landed. It must not discard the replacement.
    mgr.invalidate(stale);

    // The late 403 must not send the manager back to the platform.
    await settleTasks();
    expect(stsCalls()).toHaveLength(2);

    const after = mgr.getCredential();
    await settleTasks();
    // Release a replacement request if one was wrongly started, so the failure
    // is the assertion below rather than a dangling await.
    if (stsCalls().length > 2) {
      stsCalls()[2]!.settle.resolve(jsonOk(secret(5, HOUR)));
    }
    expect((await after).tmpSecretId).toBe("fake-id-5");
    expect(stsCalls()).toHaveLength(2);
  });

  it("still invalidates unconditionally when no credential is named", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    await prime(mgr, 1, HOUR);

    mgr.invalidate();
    const refreshed = mgr.getCredential();

    await settleTasks();
    expect(stsCalls()).toHaveLength(2);
    stsCalls()[1]!.settle.resolve(jsonOk(secret(6, HOUR)));
    expect((await refreshed).tmpSecretId).toBe("fake-id-6");
  });

  it("recovers from a 403 by refreshing and retrying once", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    const reader = new MemoryFileReader(mgr);

    const pending = reader.read("persona.md");
    await settleTasks();
    expect(stsCalls()).toHaveLength(1);
    stsCalls()[0]!.settle.resolve(jsonOk(secret(7, HOUR)));

    // The read fails on the stale credential and is retried with a fresh one.
    await settleTasks();
    expect(cosCalls()).toHaveLength(1);
    cosCalls()[0]!.settle.resolve(new Response("denied", { status: 403 }));

    await settleTasks();
    expect(stsCalls()).toHaveLength(2);
    stsCalls()[1]!.settle.resolve(jsonOk(secret(8, HOUR)));

    await settleTasks();
    expect(cosCalls()).toHaveLength(2);
    cosCalls()[1]!.settle.resolve(new Response("persona body", { status: 200 }));

    await expect(pending).resolves.toBe("persona body");
  });
});

describe("MemoryFileReader concurrent recovery", () => {
  it("collapses six rejected reads into one replacement credential", async () => {
    const mgr = new StsCredentialManager(CONFIG);
    const reader = new MemoryFileReader(mgr);
    let authorized = false;

    stubFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: { method?: string }) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const settle = deferred();
        calls.push({ method, url: String(input), settle });
        if (method === "GET") {
          settle.resolve(
            authorized
              ? new Response("file body", { status: 200 })
              : new Response("denied", { status: 403 }),
          );
        }
        return settle.promise;
      }),
    );

    const reads = Array.from({ length: 6 }, (_, i) =>
      reader.read(`scene_blocks/note-${i}.md`),
    );

    // All six readers share the initial acquisition, then all six are rejected.
    await settleTasks();
    expect(stsCalls()).toHaveLength(1);
    stsCalls()[0]!.settle.resolve(jsonOk(secret(7, HOUR)));

    await settleTasks();
    expect(cosCalls()).toHaveLength(6);
    // Priming plus one shared replacement.
    expect(stsCalls()).toHaveLength(2);

    // Release any extra replacement requests an implementation wrongly started,
    // so an over-fetch fails on the assertion rather than hanging.
    for (const extra of stsCalls().slice(2)) {
      extra.settle.resolve(jsonOk(secret(8, HOUR)));
    }

    authorized = true;
    stsCalls()[1]!.settle.resolve(jsonOk(secret(9, HOUR)));

    await expect(Promise.all(reads)).resolves.toEqual(Array(6).fill("file body"));
    expect(stsCalls()).toHaveLength(2);
    expect(cosCalls()).toHaveLength(12);
  });
});