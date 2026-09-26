/** Git transport with per-operation credentials and strict SSH server verification. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";
import type { GitSecret } from "../store/git-credential-store.js";
import { validateGitSecret } from "../store/git-credential-store.js";
import { parseGitSource, validateGitBranch } from "./git-source.js";
import { withGitAuth, GitTransportError } from "./git-auth.js";
import { scanGitHostKeys } from "./git-host-key.js";

function privateAddress(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // Reject mapped IPv4 and non-global IPv6 ranges, including link-local/ULA.
  return isIP(h) === 6 && (h.startsWith("::") || /^(f[cd]|fe[89ab]|ff)/.test(h));
}

export interface GitSourceFetcherOptions {
  /** For trusted self-hosted Git on a private network only. */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? !/^(off|false|0|no)$/i.test(process.env.KNOWLEDGE_SSRF_CHECK?.trim() ?? "");
  }

  validate(sourceUrl: string): void {
    const { host } = parseGitSource(sourceUrl);
    if (this.ssrfCheck && privateAddress(host)) throw new Error("Repository URL must not point to a private/loopback address");
  }

  private async prepare(sourceUrl: string, secret?: GitSecret): Promise<string> {
    const source = parseGitSource(sourceUrl);
    if (secret) {
      validateGitSecret(secret);
      if (source.kind !== secret.kind) throw new GitTransportError("Credential transport does not match repository URL");
    }
    if (source.kind === "ssh" && !secret) throw new GitTransportError("SSH repositories require a selected SSH credential");
    await this.validateRemote(source.url);
    return source.url;
  }

  private async validateRemote(sourceUrl: string): Promise<void> {
    this.validate(sourceUrl);
    const source = parseGitSource(sourceUrl);
    if (this.ssrfCheck) {
      let addresses;
      try { addresses = await lookup(source.host, { all: true }); }
      catch { throw new GitTransportError("Cannot resolve Git repository host"); }
      if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
        throw new GitTransportError("Repository host resolves to a private/loopback address");
      }
    }
  }

  async hostKeys(sourceUrl: string): Promise<string> {
    if (parseGitSource(sourceUrl).kind !== "ssh") throw new GitTransportError("SSH repository URL required");
    await this.validateRemote(sourceUrl);
    try { return await scanGitHostKeys(sourceUrl); }
    catch (error) { throw new GitTransportError((error as Error).message); }
  }

  async test(sourceUrl: string, secret: GitSecret): Promise<void> {
    const url = await this.prepare(sourceUrl, secret);
    // Return an actionable result within Panel's service-request timeout.
    await withGitAuth(undefined, secret, async (git) => { await git.listRemote(["--", url, "HEAD"]); }, 10_000);
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, secret?: GitSecret): Promise<FetchResult> {
    validateGitBranch(branch);
    const url = await this.prepare(sourceUrl, secret);
    return withGitAuth(undefined, secret, async (git) => {
      await git.clone(url, localPath, { "--depth": 1, "--single-branch": null, "--branch": branch });
      const version = (await git.cwd(localPath).revparse(["HEAD"])).trim().slice(0, 12);
      return { localPath, version, sourceType: "git" };
    });
  }

  async sync(sourceUrl: string, branch: string, localPath: string, secret?: GitSecret): Promise<FetchResult> {
    validateGitBranch(branch);
    const url = await this.prepare(sourceUrl, secret);
    return withGitAuth(localPath, secret, async (git) => {
      // Use the validated URL, not a potentially stale origin from an older checkout.
      await git.fetch(url, branch, { "--depth": 1 });
      await git.reset(ResetMode.HARD, ["FETCH_HEAD"]);
      await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
      const version = (await git.revparse(["HEAD"])).trim().slice(0, 12);
      return { localPath, version, sourceType: "git" };
    });
  }
}
