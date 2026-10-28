import { describe, it, expect, vi, afterEach } from "vitest";

const calls = vi.hoisted(() => [] as unknown[][]);

vi.mock("simple-git", () => ({
  default: vi.fn((...args: unknown[]) => {
    calls.push(args);
    const git = { env: (e: unknown) => ({ ...git, envArgs: e }), revparse: vi.fn(async () => "abc1234567890") };
    return git;
  }),
}));

import { GitSourceFetcher } from "./git-fetcher.js";

type FetcherPriv = { gitFor(u: string, p?: string, o?: unknown): unknown };

describe("GitSourceFetcher git timeout", () => {
  afterEach(() => {
    calls.length = 0;
    delete process.env.KNOWLEDGE_GIT_TIMEOUT_MS;
  });

  it("passes timeout.block to simpleGit on every construction", () => {
    const f = new GitSourceFetcher({ timeoutMs: 1234 }) as unknown as FetcherPriv;
    f.gitFor("https://example.com/r.git", "/tmp/x");
    expect(calls[0]).toEqual(["/tmp/x", { timeout: { block: 1234 } }]);
    f.gitFor("https://example.com/r.git");
    expect(calls[1]).toEqual([{ timeout: { block: 1234 } }]);
  });

  it("keeps unsafe merged on the ssh path", () => {
    const f = new GitSourceFetcher({ timeoutMs: 7 }) as unknown as FetcherPriv;
    f.gitFor("git@github.com:o/r.git", "/tmp/x", { ssh: { privateKey: "k" } });
    const opts = calls[0][1] as Record<string, unknown>;
    expect(opts.unsafe).toBeTruthy();
    expect(opts.timeout).toEqual({ block: 7 });
  });

  it("defaults to 10min, honors env override and explicit option wins", () => {
    process.env.KNOWLEDGE_GIT_TIMEOUT_MS = "500";
    const f1 = new GitSourceFetcher() as unknown as FetcherPriv;
    f1.gitFor("https://x");
    expect((calls[0][0] as { timeout: { block: number } }).timeout.block).toBe(500);
    const f2 = new GitSourceFetcher({ timeoutMs: 9 }) as unknown as FetcherPriv;
    f2.gitFor("https://x");
    expect((calls[1][0] as { timeout: { block: number } }).timeout.block).toBe(9);
    process.env.KNOWLEDGE_GIT_TIMEOUT_MS = "garbage";
    const f3 = new GitSourceFetcher() as unknown as FetcherPriv;
    f3.gitFor("https://x");
    expect((calls[2][0] as { timeout: { block: number } }).timeout.block).toBe(600_000);
  });
});
