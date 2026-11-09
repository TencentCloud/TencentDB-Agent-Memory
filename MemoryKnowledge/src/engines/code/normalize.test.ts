import { describe, expect, it } from "vitest";

import { normalizeRepoUrl, parseSourceKey, sourceKey } from "./normalize.js";

describe("normalizeRepoUrl", () => {
  it("normalizes SCP-style SSH urls", () => {
    expect(normalizeRepoUrl("git@gitlab.example.com:namespace/project/repo.git"))
      .toBe("gitlab.example.com/namespace/project/repo");
  });

  it("normalizes HTTPS urls", () => {
    expect(normalizeRepoUrl("https://gitlab.example.com/namespace/project/repo.git"))
      .toBe("gitlab.example.com/namespace/project/repo");
  });

  it("passes through already normalized paths and strips a trailing .git", () => {
    expect(normalizeRepoUrl("gitlab.example.com/ns/repo"))
      .toBe("gitlab.example.com/ns/repo");
    expect(normalizeRepoUrl("gitlab.example.com/ns/repo.git"))
      .toBe("gitlab.example.com/ns/repo");
  });
});

describe("sourceKey / parseSourceKey", () => {
  it("uses main when the branch is empty", () => {
    expect(sourceKey("https://host/ns/repo.git", "")).toBe("host/ns/repo:main");
  });

  it("round-trips a normalized repo and branch", () => {
    const key = sourceKey("git@host:ns/repo.git", "develop");
    expect(key).toBe("host/ns/repo:develop");
    expect(parseSourceKey(key)).toEqual({ repo: "host/ns/repo", branch: "develop" });
  });

  it("splits on the last colon", () => {
    expect(parseSourceKey("host/ns/repo:feature/x")).toEqual({
      repo: "host/ns/repo",
      branch: "feature/x",
    });
  });
});
