/**
 * Security #672 Regression-Tests: SSRF + Argument Injection (MemoryKnowledge)
 *
 * Verifiziert die Schwachstellen 3+4 aus dem Advisory:
 * 3. SSRF: Hostname-Regex allein reicht nicht — DNS-Auflösung wird mitgeprüft
 * 4. Argument Injection: Git-Options-/Shell-Metazeichen in repo_url → abgelehnt
 */
import { describe, expect, it } from "vitest";
import { GitSourceFetcher } from "../git-fetcher.js";

describe("Security #672: Argument Injection", () => {
  it("Git-Options-Separator (--) in repo_url → Error", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    await expect(
      fetcher.validate("https://github.com/x/y --upload-pack=touch /tmp/pwn"),
    ).rejects.toThrow(/forbidden characters/);
  });

  it("Shell-Metazeichen (;&) in repo_url → Error", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    await expect(
      fetcher.validate("https://github.com/x/y;rm -rf /"),
    ).rejects.toThrow(/forbidden characters/);
  });

  it("normale HTTPS-URL ohne SSRF-Check → kein Error", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    await expect(
      fetcher.validate("https://github.com/TencentCloud/TencentDB-Agent-Memory"),
    ).resolves.toBeUndefined();
  });
});

describe("Security #672: SSRF via DNS-Auflösung", () => {
  it("localhost → Error", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });
    await expect(fetcher.validate("https://localhost/repo")).rejects.toThrow(/private/);
  });

  it("öffentliche IP 8.8.8.8 → kein SSRF-Error (öffentlich)", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });
    // 8.8.8.8 ist öffentlich (Google DNS), kein privates Netz
    await expect(fetcher.validate("https://8.8.8.8/repo")).resolves.toBeUndefined();
  });

  it("privater Host, der auf RFC1918 auflöst → Error", async () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });
    // "localtest.me" ist eine Wildcard-Domain, die auf 127.0.0.1 auflöst
    await expect(fetcher.validate("https://localtest.me/repo")).rejects.toThrow(/private/);
  });
});
