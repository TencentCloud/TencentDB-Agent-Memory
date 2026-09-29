import { describe, expect, it } from "vitest";
import { GitSourceFetcher } from "./git-fetcher.js";

describe("GitSourceFetcher URL validation", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: true });

  it.each([
    "https://[::1]/repo.git",
    "https://[::ffff:127.0.0.1]/repo.git",
    "https://[::ffff:192.168.1.1]/repo.git",
    "https://[fc00::1]/repo.git",
    "https://localhost./repo.git",
    "https://sub.localhost/repo.git",
  ])("rejects a non-public HTTPS destination: %s", (url) => {
    expect(() => fetcher.validate(url)).toThrow("private/loopback");
  });

  it("still accepts an ordinary public HTTPS repository", () => {
    expect(() => fetcher.validate("https://github.com/example/repo.git")).not.toThrow();
    expect(() => fetcher.validate("https://[2606:4700:4700::1111]/repo.git")).not.toThrow();
  });
});
