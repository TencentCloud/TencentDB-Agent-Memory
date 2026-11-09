import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cosV5Sign,
  MemoryFileReader,
  StsCredential,
  StsCredentialManager,
} from "../src/cos.js";

function credential(index: number, prefix: string): StsCredential {
  return new StsCredential({
    CosUrl: `https://bucket-${index}.cos.ap-guangzhou.myqcloud.com`,
    TmpSecretId: `fake-id-${index}`,
    TmpSecretKey: `fake-secret-${index}`,
    TmpToken: `fake-token-${index}`,
    ExpirationTime: "",
    PathPrefix: prefix,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([false, true])("COS object paths (retry: %s)", (retry) => {
  it.each([
    "persona.md",
    "scene_blocks/notes with spaces.md",
    "scene_blocks/\u8bb0\u5fc6.md",
    "scene_blocks/notes#1.md",
    "scene_blocks/why?.md",
    "scene_blocks/100%.md",
    "scene_blocks/literal%2Fname.md",
  ])("preserves the object key for %s", async (path) => {
    const credentials = [
      credential(0, "memory/test"),
      credential(1, "memory/refreshed#prefix?literal%2F"),
    ];
    const manager = new StsCredentialManager({
      endpoint: "https://memory.example",
      apiKey: "fake-key",
      serviceId: "mem-test",
    });
    const getCredential = vi.spyOn(manager, "getCredential")
      .mockResolvedValueOnce(credentials[0]!)
      .mockResolvedValueOnce(credentials[1]!);
    const invalidate = vi.spyOn(manager, "invalidate");
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return retry && requests.length === 1
        ? new Response("Expired credentials", { status: 403 })
        : new Response("Memory content");
    }));

    const reader = new MemoryFileReader(manager);
    await expect(reader.read(path)).resolves.toBe("Memory content");

    expect(requests).toHaveLength(retry ? 2 : 1);
    expect(getCredential).toHaveBeenCalledTimes(requests.length);
    expect(invalidate).toHaveBeenCalledTimes(retry ? 1 : 0);
    requests.forEach((request, index) => {
      const cred = credentials[index]!;
      const cosPath = `/${cred.prefix}${path}`;
      const url = new URL(request.url);
      expect(decodeURIComponent(url.pathname)).toBe(cosPath);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.host).toBe(cred.cosHost);
      expect(request.headers.get("host")).toBe(cred.cosHost);
      expect(request.headers.get("x-cos-security-token")).toBe(cred.token);
      expect(request.headers.get("authorization")).toBe(cosV5Sign(
        cred.tmpSecretId, cred.tmpSecretKey, "GET", cosPath, cred.cosHost,
      ));
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([403, 404, 500])("preserves error handling for HTTP %s", async (status) => {
  const manager = new StsCredentialManager({
    endpoint: "https://memory.example",
    apiKey: "fake-key",
    serviceId: "mem-test",
  });
  vi.spyOn(manager, "getCredential").mockResolvedValue(credential(0, "memory/test"));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
    new Response("COS error", { status }));
  vi.stubGlobal("fetch", fetchMock);

  const message = status === 404
    ? "File not found: notes#1.md"
    : `COS GET failed: HTTP ${status} \u2014 COS error`;
  await expect(new MemoryFileReader(manager).read("notes#1.md")).rejects.toMatchObject({
    code: status,
    message: `[${status}] ${message} (request_id=)`,
  });
  expect(fetchMock).toHaveBeenCalledTimes(status === 403 ? 2 : 1);
  expect(vi.getTimerCount()).toBe(0);
});
