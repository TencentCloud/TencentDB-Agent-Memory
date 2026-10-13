/**
 * GitSourceFetcher - secure source retrieval via simple-git.
 *
 * Uses child_process.spawn to eliminate shell injection.
 * Implements strict HTTPS-only transport with optional SSRF mitigation (DNS pinning).
 *
 * Directory lifecycle:
 * - fetch: clones into isolated staging. Rejects existing destinations, checks incoming
 *   .codegraph conflicts, and extracts the commit hash before renaming to localPath.
 * - sync: clones into isolated staging. Checks incoming .codegraph conflicts, extracts
 *   the commit hash, validates existing localPath, backs up old checkout, and atomically
 *   replaces it with staging before restoring the old .codegraph overlay. Fails securely
 *   leaving backup in place if replacement fails.
 */

import { simpleGit } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType, GitCredential } from "./types.js";
import { resolveAndValidate, isNonPublicAddress } from "./git-address-policy.js";
import * as net from "node:net";
import { join } from "node:path";
import { lstatSync, renameSync, rmSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { GitRelay } from "./git-relay.js";
import { randomUUID } from "node:crypto";

export function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not read username") ||
    msg.includes("could not read password") ||
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("returned error: 401") ||
    msg.includes("returned error: 403") ||
    msg.includes("could not read from remote repository") ||
    msg.includes("unable to access") ||
    msg.includes("remote: you are not allowed")
  );
}

/** 把 git 认证错误转成面向用户的提示。needsCredential = clone 时是否已注入凭据。 */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = raw.split("\n").find((l) => l.trim())?.trim() ?? raw.trim();
  if (needsCredential) {
    return (
      `访问令牌无效或已过期，无法拉取仓库（git: ${brief}）。` +
      `请在仓库详情里重新填写访问令牌。`
    );
  }
  return (
    `该仓库需要身份认证，无法以「公开」方式克隆（git: ${brief}）。` +
    `请删除后重新注册，来源选择对应的代码平台并填写访问令牌。`
  );
}


function copyCodegraphSafely(srcDir: string, destDir: string) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const stats = lstatSync(srcPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new Error(`Invalid entry in .codegraph: ${entry.name}`);
    }
    if (stats.isDirectory()) {
      copyCodegraphSafely(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  ssrfCheck?: boolean;
  dnsResolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  trustedCA?: string; // Narrowly trusted CA option for synthetic TLS tests
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  private readonly ssrfCheck: boolean;
  private readonly dnsResolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  private readonly trustedCA?: string;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
    this.dnsResolver = opts?.dnsResolver;
    this.trustedCA = opts?.trustedCA;
  }

  validate(sourceUrl: string): void {
    if (!sourceUrl.startsWith("https://")) {
      throw new Error("first version only supports public HTTPS repos");
    }

    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new Error("invalid repo_url: cannot parse URL");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("invalid repo_url: only HTTPS is allowed");
    }

    if (parsed.username || parsed.password) {
      throw new Error("invalid repo_url: credentials in URL are not allowed");
    }

    if (parsed.hash) {
      throw new Error("invalid repo_url: fragments are not allowed");
    }

    if (/[\x00-\x1F\x7F]/.test(sourceUrl)) {
      throw new Error("invalid repo_url: control characters are not allowed");
    }

    if (sourceUrl.includes("\\") || sourceUrl.includes("@")) {
      throw new Error("invalid repo_url: backslash and @ are not allowed");
    }

    const rawHost = sourceUrl.substring(sourceUrl.indexOf("://") + 3).split("/")[0].split("?")[0].split("#")[0];
    if (!rawHost) {
      throw new Error("invalid repo_url: missing host");
    }

    let expectedHost = parsed.host;
    if (net.isIPv6(parsed.hostname)) {
      expectedHost = `[${parsed.hostname}]${parsed.port ? ":" + parsed.port : ""}`;
    }

    if (rawHost !== expectedHost) {
      throw new Error("invalid repo_url: alternate numeric IPv4 URL forms or ambiguity detected");
    }

    const hostForIpCheck = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;

    if (this.ssrfCheck && net.isIP(hostForIpCheck) && isNonPublicAddress(hostForIpCheck)) {
      throw new Error(`SSRF Address Policy Violation: repo_url must not point to a non-public literal IP: ${parsed.hostname}`);
    }
  }

  validateBranch(branch: string): void {
    if (!branch || typeof branch !== "string") {
      throw new Error("invalid branch");
    }
    if (branch.startsWith("-")) {
      throw new Error("invalid branch: cannot start with dash");
    }
    if (
      branch.includes("..") ||
      branch.includes("//") ||
      branch.startsWith(".") ||
      branch.endsWith(".") ||
      branch.includes("/.") ||
      branch.endsWith(".lock") ||
      branch.includes(".lock/") ||
      branch.endsWith("/") ||
      branch.includes("@{") ||
      branch.includes("\\") ||
      branch.includes(":") ||
      branch.includes(" ") ||
      branch.includes("~") ||
      branch.includes("^") ||
      branch.includes("*") ||
      branch.includes("?") ||
      branch.includes("[") ||
      branch === "@" ||
      /[\x00-\x20\x7F]/.test(branch)
    ) {
      throw new Error("invalid branch: contains invalid characters or refs");
    }
  }

  private async secureGit(
    baseDir: string,
    parsedUrl: URL | null, // If null, no proxy (for local ops like rev-parse)
    validatedIps?: string[],
    credential?: GitCredential,
  ): Promise<{ git: ReturnType<typeof simpleGit>; cleanup: () => Promise<void> }> {
    let proxyPort = 0;
    let relay: GitRelay | undefined;

    if (parsedUrl && validatedIps && validatedIps.length > 0) {
      const targetIp = validatedIps[0];
      const expectedPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
      relay = new GitRelay({ targetIp, expectedHost: parsedUrl.hostname, expectedPort });
      proxyPort = await relay.start();
    }

    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      XDG_DATA_HOME: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      no_proxy: "",
    };

    if (this.trustedCA) {
      env.GIT_SSL_CAINFO = this.trustedCA;
    }

    if (credential) {
      if (!parsedUrl || !credential.username || !credential.password || /[\x00-\x1f\x7f:]/.test(credential.username) || /[\x00-\x1f\x7f]/.test(credential.password)) {
        if (relay) await relay.stop();
        throw new Error("Invalid Git credential");
      }
      // Git's scoped config environment carries exactly one generated header.
      // It is neither an argument nor persisted in the clone's .git/config.
      // Other same-user/root processes may still inspect child environments.
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = `http.${parsedUrl.toString()}.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = "Authorization: Basic " + Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64");
    }

    const config = [
      `http.followRedirects=false`,
      `core.hooksPath=/dev/null`,
      `init.templateDir=/dev/null`,
      `credential.helper=`,
      `protocol.allow=never`,
      `protocol.https.allow=always`
    ];

    if (proxyPort > 0) {
      config.push(`http.proxy=http://127.0.0.1:${proxyPort}`);
    }

    const allowEnvironment = [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_TERMINAL_PROMPT",
    ];

    if (this.trustedCA) {
      allowEnvironment.push("GIT_SSL_CAINFO");
    }
    if (credential) allowEnvironment.push("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0");

    let git: ReturnType<typeof simpleGit>;
    try {
      git = simpleGit(baseDir, {
      config,
      allowEnvironment,
      unsafe: {
        allowUnsafeHooksPath: true,
        allowUnsafeTemplateDir: true,
        allowUnsafeCredentialHelper: true,
        allowUnsafeProtocolOverride: true,
        allowUnsafeConfigPaths: true,
        allowUnsafeConfigEnvCount: credential !== undefined,
      },
      timeout: { block: 60000, stdOut: false, stdErr: false } // 1 min true process deadline
      }).env(env);
    } catch (error) {
      if (relay) await relay.stop();
      throw error;
    }

    return {
      git,
      cleanup: async () => {
        if (relay) await relay.stop();
      }
    };
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, credential?: GitCredential): Promise<FetchResult> {
    this.validate(sourceUrl);
    this.validateBranch(branch);

    const parsed = new URL(sourceUrl);
    const validatedIps = await resolveAndValidate(parsed.hostname, { ssrfCheck: this.ssrfCheck, dnsResolver: this.dnsResolver });

    const uid = randomUUID();
    const stagingPath = `${localPath}.staging.${uid}`;
    mkdirSync(stagingPath);

    let transport: Awaited<ReturnType<GitSourceFetcher["secureGit"]>>;
    try { transport = await this.secureGit(stagingPath, parsed, validatedIps, credential); }
    catch (error) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw error;
    }
    const { git, cleanup } = transport;
    try {
      await git.clone(sourceUrl, ".", {
        "--depth": 1,
        "--branch": branch,
        "--no-tags": null,
        "--single-branch": null,
        "--config": "core.hooksPath=/dev/null"
      });
    } catch (err) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      if (credential) throw new Error("Authenticated Git retrieval failed; check the resource credentials and repository access");
      throw err;
    } finally {
      await cleanup();
    }

    const incomingCodegraphDir = join(stagingPath, ".codegraph");
    let hasIncomingCodegraph = false;
    try {
      lstatSync(incomingCodegraphDir);
      hasIncomingCodegraph = true;
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
        throw e;
      }
    }

    if (hasIncomingCodegraph) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw new Error("Rejecting hostile incoming .codegraph conflict");
    }

    let version: string;
    try {
      version = await this.headCommit(stagingPath);
    } catch (e) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw new Error(`Failed to read commit hash: ${e}`);
    }

    let hasLocalPath = false;
    try {
      lstatSync(localPath);
      hasLocalPath = true;
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
        throw e;
      }
    }

    if (hasLocalPath) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw new Error(`fetch destination already exists: ${localPath}`);
    }

    renameSync(stagingPath, localPath);

    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string, credential?: GitCredential): Promise<FetchResult> {
    this.validate(sourceUrl);
    this.validateBranch(branch);

    const parsed = new URL(sourceUrl);
    const validatedIps = await resolveAndValidate(parsed.hostname, { ssrfCheck: this.ssrfCheck, dnsResolver: this.dnsResolver });

    const uid = randomUUID();
    const stagingPath = `${localPath}.staging.${uid}`;
    const backupPath = `${localPath}.backup.${uid}`;

    mkdirSync(stagingPath);

    let transport: Awaited<ReturnType<GitSourceFetcher["secureGit"]>>;
    try { transport = await this.secureGit(stagingPath, parsed, validatedIps, credential); }
    catch (error) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw error;
    }
    const { git, cleanup } = transport;
    try {
      await git.clone(sourceUrl, ".", {
        "--depth": 1,
        "--branch": branch,
        "--no-tags": null,
        "--single-branch": null,
        "--config": "core.hooksPath=/dev/null"
      });
    } catch (err) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      if (credential) throw new Error("Authenticated Git retrieval failed; check the resource credentials and repository access");
      throw err;
    } finally {
      await cleanup();
    }

    const incomingCodegraphDir = join(stagingPath, ".codegraph");
    let hasIncomingCodegraph = false;
    try {
      lstatSync(incomingCodegraphDir);
      hasIncomingCodegraph = true;
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
        throw e;
      }
    }

    if (hasIncomingCodegraph) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw new Error("Rejecting hostile incoming .codegraph conflict");
    }

    let version: string;
    try {
      version = await this.headCommit(stagingPath);
    } catch (e) {
      try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
      throw new Error(`Failed to read commit hash: ${e}`);
    }

    let hasLocalPath = false;
    let localPathStats: import("node:fs").Stats | undefined;
    try {
      localPathStats = lstatSync(localPath);
      hasLocalPath = true;
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
        throw e;
      }
    }

    if (hasLocalPath) {
      if (!localPathStats!.isDirectory() || localPathStats!.isSymbolicLink()) {
         try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
         throw new Error("Rejecting existing sync root that is not a directory");
      }

      const codegraphDir = join(localPath, ".codegraph");
      let hasLocalCodegraph = false;
      let localCodegraphStats: import("node:fs").Stats | undefined;
      try {
        localCodegraphStats = lstatSync(codegraphDir);
        hasLocalCodegraph = true;
      } catch (e: any) {
        if (e.code !== "ENOENT") {
          try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
          throw e;
        }
      }

      if (hasLocalCodegraph) {
        if (localCodegraphStats!.isSymbolicLink() || !localCodegraphStats!.isDirectory()) {
          try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
          throw new Error("Rejecting conflicting/symlink .codegraph state");
        }
        try {
          copyCodegraphSafely(codegraphDir, incomingCodegraphDir);
        } catch (e) {
          try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
          throw new Error(`Rejecting conflicting/symlink .codegraph state: ${e}`);
        }
      }

      try {
        renameSync(localPath, backupPath);
      } catch (e) {
        try { rmSync(stagingPath, { recursive: true, force: true }); } catch {}
        throw new Error(`Failed to backup old checkout: ${e}`);
      }

      try {
        renameSync(stagingPath, localPath);
      } catch (e) {
        try { renameSync(backupPath, localPath); } catch (e2) {
          throw new Error(`Directory replacement failed and rollback failed. Recovery location: ${backupPath}`);
        }
        throw new Error(`Directory replacement failed: ${e}`);
      }

      try { rmSync(backupPath, { recursive: true, force: true }); } catch (e) {
        // Log or ignore cleanup failure
      }
    } else {
      renameSync(stagingPath, localPath);
    }

    return { localPath, version, sourceType: "git" };
  }

  private async headCommit(targetPath: string): Promise<string> {
    const { git, cleanup } = await this.secureGit(targetPath, null);
    try {
      const output = await git.revparse(["HEAD"]);
      if (!output) throw new Error("rev-parse returned empty string");
      return output.trim().slice(0, 12);
    } finally {
      await cleanup();
    }
  }
}
