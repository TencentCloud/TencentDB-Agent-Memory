import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type { GitSecret } from "../store/git-credential-store.js";

/** This error is safe for logs, audit records and API responses. */
export class GitTransportError extends Error {}

function safeGitError(error: unknown): GitTransportError {
  const message = error instanceof Error ? error.message : "";
  if (/Authentication failed|could not read Username|Permission denied|terminal prompts disabled|HTTP.*40[13]|repository.*not found/i.test(message)) {
    return new GitTransportError("Git authentication failed or repository is inaccessible; check the selected credential and repository permissions");
  }
  if (/Host key verification|REMOTE HOST IDENTIFICATION/i.test(message)) {
    return new GitTransportError("SSH host key verification failed; use Test connection to inspect and confirm the server fingerprint again");
  }
  if (/timed? out|timeout/i.test(message)) return new GitTransportError("Git operation timed out");
  // Never return raw Git stderr: it may contain credentials, headers or key material.
  return new GitTransportError("Git operation failed; check repository URL, branch, credentials and network access");
}

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Each operation gets its own environment and temporary HOME. No global Git/SSH
 * configuration, credential helpers or ssh-agent; nothing secret enters Git argv
 * or the checkout. Always clean up, including on authentication failure.
 */
export async function withGitAuth<T>(localPath: string | undefined, secret: GitSecret | undefined, run: (git: SimpleGit) => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-git-"));
  try {
    const templates = join(dir, "empty-templates");
    await mkdir(templates);
    const env: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    Object.assign(env, {
      HOME: dir, XDG_CONFIG_HOME: dir, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: secret?.kind === "ssh" ? "ssh" : "https",
      GIT_TEMPLATE_DIR: templates,
    });
    if (secret?.kind === "https") {
      const helper = join(dir, "askpass");
      await writeFile(helper, '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "$MEMORY_GIT_USERNAME";;\n*Password*) printf "%s\\n" "$MEMORY_GIT_TOKEN";;\n*) exit 1;;\nesac\n', { mode: 0o700 });
      env.GIT_ASKPASS = helper;
      env.MEMORY_GIT_USERNAME = secret.username;
      env.MEMORY_GIT_TOKEN = secret.token;
    }
    if (secret?.kind === "ssh") {
      if (!secret.known_hosts) throw new GitTransportError("SSH server is not trusted; confirm its fingerprint before connecting");
      const keyFile = join(dir, "identity");
      const hostsFile = join(dir, "known_hosts");
      const helper = join(dir, "ssh");
      await writeFile(keyFile, secret.private_key.trim() + "\n", { mode: 0o600 });
      await writeFile(hostsFile, secret.known_hosts.trim() + "\n", { mode: 0o600 });
      await writeFile(helper, `#!/bin/sh\nexec ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=${quote(hostsFile)} -o ConnectTimeout=20 -i ${quote(keyFile)} "$@"\n`, { mode: 0o700 });
      env.GIT_SSH = helper;
      env.GIT_SSH_VARIANT = "ssh";
    }
    const git = simpleGit({
      ...(localPath ? { baseDir: localPath } : {}),
      // simple-git gates even our fixed, locally generated configuration.
      // These options permit ONLY the helper/config paths assembled above;
      // no caller-supplied commands or configuration are accepted.
      unsafe: {
        allowUnsafeCredentialHelper: true,
        allowUnsafeConfigPaths: true,
        allowUnsafeTemplateDir: true,
        allowUnsafeAskPass: secret?.kind === "https",
        allowUnsafeSshCommand: secret?.kind === "ssh",
      },
      // Preserve Git's public-repository redirect behavior. Authenticated
      // operations never forward the selected credential through a redirect.
      config: ["credential.helper=", `http.followRedirects=${secret ? "false" : "initial"}`, "http.sslVerify=true"],
      timeout: { block: timeoutMs },
    }).env(env);
    try { return await run(git); }
    catch (error) { throw safeGitError(error); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
