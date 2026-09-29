import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitSourceFetcher } from "./index.js";

const roots: string[] = [];
const savedGitEnv = new Map<string, string | undefined>();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setGitEnv(key: string, value: string): void {
  if (!savedGitEnv.has(key)) savedGitEnv.set(key, process.env[key]);
  process.env[key] = value;
}

function createBareRemote() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-git-probe-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", source]);
  git(source, ["config", "user.email", "probe@example.invalid"]);
  git(source, ["config", "user.name", "Probe Test"]);
  git(source, ["checkout", "-b", "main"]);
  writeFileSync(join(source, "file.txt"), "first\n");
  git(source, ["add", "file.txt"]);
  git(source, ["commit", "-m", "first"]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "-u", "origin", "main"]);

  setGitEnv("GIT_CONFIG_COUNT", "1");
  setGitEnv("GIT_CONFIG_KEY_0", "url.file://.insteadOf");
  setGitEnv("GIT_CONFIG_VALUE_0", "https://probe.invalid");
  setGitEnv("GIT_ALLOW_PROTOCOL", "file:https");

  return { root, remote, source, checkout, url: `https://probe.invalid${remote}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of savedGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedGitEnv.clear();
});

describe("GitSourceFetcher version probing", () => {
  it("returns full local and exact remote branch SHAs across updates and force-pushes", async () => {
    const f = createBareRemote();
    const fetcher = new GitSourceFetcher({ ssrfCheck: false, probeTimeoutMs: 5_000 });

    const fetched = await fetcher.fetch(f.url, "main", f.checkout);
    const first = git(f.source, ["rev-parse", "HEAD"]);
    expect(fetched.version).toBe(first);
    expect(fetched.version).toMatch(/^[0-9a-f]{40}$/);
    await expect(fetcher.probeVersion(f.url, "main", f.checkout)).resolves.toEqual({
      localVersion: first, remoteVersion: first,
    });

    git(f.source, ["checkout", "-b", "main-old"]);
    writeFileSync(join(f.source, "side.txt"), "side branch\n");
    git(f.source, ["add", "side.txt"]);
    git(f.source, ["commit", "-m", "side"]);
    git(f.source, ["push", "origin", "main-old"]);
    await expect(fetcher.probeVersion(f.url, "main", f.checkout)).resolves.toEqual({
      localVersion: first, remoteVersion: first,
    });

    git(f.source, ["checkout", "main"]);
    writeFileSync(join(f.source, "file.txt"), "second\n");
    git(f.source, ["commit", "-am", "second"]);
    git(f.source, ["push", "origin", "main"]);
    const second = git(f.source, ["rev-parse", "HEAD"]);
    await expect(fetcher.probeVersion(f.url, "main", f.checkout)).resolves.toEqual({
      localVersion: first, remoteVersion: second,
    });

    git(f.source, ["reset", "--hard", `${first}`]);
    writeFileSync(join(f.source, "file.txt"), "replacement\n");
    git(f.source, ["commit", "-am", "replacement"]);
    git(f.source, ["push", "--force", "origin", "main"]);
    const replacement = git(f.source, ["rev-parse", "HEAD"]);
    await expect(fetcher.probeVersion(f.url, "main", f.checkout)).resolves.toEqual({
      localVersion: first, remoteVersion: replacement,
    });
  });

  it("reports a missing exact remote branch instead of treating it as unchanged", async () => {
    const f = createBareRemote();
    const fetcher = new GitSourceFetcher({ ssrfCheck: false, probeTimeoutMs: 5_000 });
    await fetcher.fetch(f.url, "main", f.checkout);

    await expect(fetcher.probeVersion(f.url, "missing", f.checkout)).rejects.toMatchObject({
      name: "SourceVersionProbeError", code: "ref_not_found", retryable: true,
    });
  });
});