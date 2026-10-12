/**
 * Security tests for #672 — GitSourceFetcher:
 *   - CWE-88 argument injection: sourceUrl must be a plain https URL
 *   - CWE-918 SSRF: private / loopback / link-local hosts rejected
 */

import { describe, expect, it } from "vitest";
import { GitSourceFetcher } from "../../src/source-fetcher/git-fetcher.js";

describe("GitSourceFetcher security (#672)", () => {
  it("rejects non-https URLs", async () => {
    const f = new GitSourceFetcher({ ssrfCheck: false });
    await expect(f.validate("ssh://git@github.com/x/y.git")).rejects.toThrow(/HTTPS/);
    await expect(f.validate("http://github.com/x/y.git")).rejects.toThrow(/HTTPS/);
  });

  it("rejects URLs carrying CLI args (argument injection, CWE-88)", async () => {
    const f = new GitSourceFetcher({ ssrfCheck: false });
    // Spaces / git options appended to the URL would be parsed by git.
    await expect(f.validate("https://github.com/x/y.git --upload-pack=echo")).rejects.toThrow(/plain https URL/);
    await expect(f.validate("https://github.com/x/y.git -c core.pager=cat")).rejects.toThrow(/plain https URL/);
    await expect(f.validate("https://github.com/x/y.git --depth 1")).rejects.toThrow(/plain https URL/);
  });

  it("rejects literal private / loopback IP hosts (SSRF, CWE-918)", async () => {
    const f = new GitSourceFetcher({ ssrfCheck: true });
    await expect(f.validate("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private\/loopback/);
    await expect(f.validate("https://10.0.0.1/repo.git")).rejects.toThrow(/private\/loopback/);
    await expect(f.validate("https://127.0.0.1/repo.git")).rejects.toThrow(/private\/loopback/);
  });

  it("accepts a plain public https URL", async () => {
    const f = new GitSourceFetcher({ ssrfCheck: false });
    await expect(f.validate("https://github.com/user/repo.git")).resolves.toBeUndefined();
  });
});
