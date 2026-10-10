import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseGitSource } from "./git-source.js";

const exec = promisify(execFile);

/** Only exact host entries, never wildcard trust or caller-supplied SSH options. */
export function hostKeyEntries(value: string, expectedHost?: string): string[] {
  if (typeof value !== "string" || !value.trim() || value.length > 65536) throw new Error("Invalid SSH host keys");
  const lines = value.trim().split(/\r?\n/).map(line => line.trim());
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const [host, algorithm, key] = parts;
    if (parts.length !== 3 || !/^(?:[a-zA-Z0-9.:-]+|\[[a-zA-Z0-9.:-]+\]:[0-9]+)$/.test(host) ||
        (expectedHost && host !== expectedHost) ||
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
      throw new Error("Invalid SSH host keys: exact host and port required");
    }
    const blob = Buffer.from(key, "base64");
    if (blob.length < 4 || blob.readUInt32BE(0) !== algorithm.length || blob.subarray(4, 4 + algorithm.length).toString() !== algorithm) {
      throw new Error("Invalid SSH public key encoding");
    }
  }
  return [...new Set(lines)].sort();
}

export function hostFingerprints(knownHosts: string): string[] {
  return hostKeyEntries(knownHosts).map(line => {
    const [, algorithm, key] = line.split(/\s+/);
    return `${algorithm} SHA256:${createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/, "")}`;
  });
}

/** Caller must validate SSRF/DNS restrictions before scanning. No private key is used. */
export async function scanGitHostKeys(repoUrl: string): Promise<string> {
  const source = parseGitSource(repoUrl);
  const port = new URL(source.serverUrl).port || "22";
  try {
    const { stdout } = await exec("ssh-keyscan", ["-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", port, "--", source.host], { timeout: 8000, maxBuffer: 65536 });
    const lines = stdout.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
    // ssh-keyscan may print an address or brackets for port 22. Pin to the
    // canonical destination name that OpenSSH will verify during authentication.
    return hostKeyEntries(lines.map(line => [source.knownHost, ...line.trim().split(/\s+/).slice(1)].join(" ")).join("\n"), source.knownHost).join("\n");
  } catch { throw new Error("Cannot read SSH server fingerprint; check repository URL and network access"); }
}
