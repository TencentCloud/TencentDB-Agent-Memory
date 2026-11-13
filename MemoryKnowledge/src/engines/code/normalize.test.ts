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

  it("pins current behaviour for SSH ports, embedded credentials and trailing slashes", () => {
    // These are quirks of the default-branch normalizer, not changes from this PR.
    // Asserting them makes any future fix (and its effect on source keys) visible.
    expect(normalizeRepoUrl("ssh://git@host:2222/ns/repo.git")).toBe("host/2222/ns/repo");
    expect(normalizeRepoUrl("https://user:pass@host/ns/repo.git")).toBe("user:pass@host/ns/repo");
    expect(normalizeRepoUrl("git@host:ns/repo/")).toBe("host/ns/repo/");
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
