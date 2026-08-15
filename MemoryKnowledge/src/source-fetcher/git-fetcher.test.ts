import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => ({
  clone: vi.fn(),
  fetch: vi.fn(),
  reset: vi.fn(),
  clean: vi.fn(),
  revparse: vi.fn().mockResolvedValue("abcdef1234567890\n"),
  raw: vi.fn(),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => gitMock),
  CleanOptions: { FORCE: "-f", RECURSIVE: "-d" },
  ResetMode: { HARD: "--hard" },
}));

import { GitSourceFetcher } from "./git-fetcher.js";

describe("GitSourceFetcher sparse checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMock.revparse.mockResolvedValue("abcdef1234567890\n");
  });

  it("keeps the existing shallow clone options when sparse paths are absent", async () => {
    await new GitSourceFetcher({ ssrfCheck: false }).fetch(
      "https://github.com/example/repo.git",
      "main",
      "/tmp/repo",
    );

    expect(gitMock.clone).toHaveBeenCalledWith(
      "https://github.com/example/repo.git",
      "/tmp/repo",
      { "--depth": 1, "--branch": "main" },
    );
    expect(gitMock.raw).not.toHaveBeenCalled();
  });

  it("uses a blobless sparse clone and selects the requested paths", async () => {
    await new GitSourceFetcher({ ssrfCheck: false }).fetch(
      "https://github.com/example/repo.git",
      "main",
      "/tmp/repo",
      ["src", "docs/api"],
    );

    expect(gitMock.clone).toHaveBeenCalledWith(
      "https://github.com/example/repo.git",
      "/tmp/repo",
      { "--depth": 1, "--branch": "main", "--filter": "blob:none", "--sparse": null },
    );
    expect(gitMock.raw).toHaveBeenCalledWith(["sparse-checkout", "set", "--cone", "src", "docs/api"]);
  });

  it("reapplies sparse paths after resetting an existing checkout", async () => {
    await new GitSourceFetcher({ ssrfCheck: false }).sync(
      "https://github.com/example/repo.git",
      "main",
      "/tmp/repo",
      ["packages/core"],
    );

    expect(gitMock.fetch).toHaveBeenCalledWith("origin", "main", { "--depth": 1 });
    expect(gitMock.reset).toHaveBeenCalledWith("--hard", ["origin/main"]);
    expect(gitMock.raw).toHaveBeenCalledWith(["sparse-checkout", "set", "--cone", "packages/core"]);
  });
});
