import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gitCredential, gitTrustedHost, knowledgeCodeGraph } from "../db/schema.js";
import { parseGitSource, parseGitHostname, httpsHostnameForSource } from "../source-fetcher/git-source.js";
import { hostKeyEntries } from "../source-fetcher/git-host-key.js";

export type GitSecret =
  | { kind: "https"; username: string; token: string }
  | { kind: "ssh"; private_key: string; known_hosts?: string };

export interface GitCredentialInfo {
  credential_id: string;
  name: string;
  hostname: string | null;
  kind: GitSecret["kind"];
  username: string | null;
  updated_at: string;
}

export class GitCredentialError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503 = 400) { super(message); }
}

export function validateGitSecret(secret: GitSecret): void {
  if (!secret || !["https", "ssh"].includes(secret.kind)) throw new GitCredentialError("Select HTTPS Token or SSH private key authentication");
  if (secret.kind === "https") {
    if (typeof secret.username !== "string" || !secret.username || secret.username.length > 256 || /[\r\n\x00]/.test(secret.username) ||
        typeof secret.token !== "string" || !secret.token || secret.token.length > 16384 || /[\r\n\x00]/.test(secret.token)) {
      throw new GitCredentialError("HTTPS credentials require a username and token");
    }
  } else {
    if (typeof secret.private_key !== "string" || secret.private_key.length > 65536 ||
        !/^-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----\r?\n/.test(secret.private_key) || secret.private_key.includes("\x00")) {
      throw new GitCredentialError("An unencrypted SSH private key is required");
    }
    if (secret.known_hosts !== undefined) {
      try { hostKeyEntries(secret.known_hosts); }
      catch { throw new GitCredentialError("Invalid known_hosts entries"); }
    }
  }
}

/** Owner-only credentials. SSH keys are reusable across servers; HTTPS tokens are host-scoped.
 * Secrets use authenticated encryption; the encryption key is never stored in SQLite.
 */
export class GitCredentialStore {
  constructor(private readonly db: Db, private readonly encryptionKey = process.env.KNOWLEDGE_GIT_CREDENTIAL_KEY ?? "") {}

  private key(): Buffer {
    if (!/^[a-fA-F0-9]{64}$/.test(this.encryptionKey)) {
      throw new GitCredentialError("Configure KNOWLEDGE_GIT_CREDENTIAL_KEY with 32 random bytes encoded as 64 hex characters", 503);
    }
    return Buffer.from(this.encryptionKey, "hex");
  }

  private scope(serviceId: string, teamId: string, userId: string) {
    return and(eq(gitCredential.serviceId, serviceId), eq(gitCredential.teamId, teamId), eq(gitCredential.ownerUserId, userId));
  }

  private row(serviceId: string, teamId: string, userId: string, id: string) {
    const row = this.db.select().from(gitCredential).where(and(this.scope(serviceId, teamId, userId), eq(gitCredential.credentialId, id))).get();
    if (!row) throw new GitCredentialError("Git credential not found", 404);
    return row;
  }

  list(serviceId: string, teamId: string, userId: string): GitCredentialInfo[] {
    return this.db.select().from(gitCredential).where(this.scope(serviceId, teamId, userId)).all().map(toInfo);
  }

  put(serviceId: string, teamId: string, userId: string, input: { credential_id?: string; name: string; hostname?: string | null; secret: GitSecret }): GitCredentialInfo {
    const key = this.key();
    const old = input.credential_id ? this.row(serviceId, teamId, userId, input.credential_id) : null;
    validateGitSecret(input.secret);
    if (input.secret.kind === "ssh" && input.secret.known_hosts !== undefined) throw new GitCredentialError("Confirm SSH server fingerprints separately from saving a private key");
    // SSH identity and server trust are separate. Preserve legacy AAD on rotation.
    const hostname = input.secret.kind === "ssh" ? null : parseGitHostname(input.hostname ?? "");
    const repoUrl = input.secret.kind === "ssh" ? (old?.repoUrl ?? "") : `https://${hostname}`;
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128) throw new GitCredentialError("Credential name is required (maximum 128 characters)");
    if (old && (old.kind !== input.secret.kind || (old.kind === "https" && httpsHostnameForSource(old.repoUrl) !== hostname))) throw new GitCredentialError("Git hostname and transport cannot change when rotating a credential");
    let secret: GitSecret = input.secret.kind === "https"
      ? { kind: "https", username: input.secret.username, token: input.secret.token }
      : { kind: "ssh", private_key: input.secret.private_key };
    if (old?.kind === "ssh" && secret.kind === "ssh") {
      const previous = this.decrypt(old);
      if (previous.kind === "ssh" && previous.known_hosts) secret = { ...secret, known_hosts: previous.known_hosts };
    }
    const id = old?.credentialId ?? `gitcred-${randomUUID()}`;
    const aad = JSON.stringify([serviceId, teamId, userId, id, repoUrl]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
    const encrypted = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
    const values = {
      credentialId: id, serviceId, teamId, ownerUserId: userId, repoUrl,
      name: input.name.trim(), kind: input.secret.kind,
      username: input.secret.kind === "https" ? input.secret.username : null,
      encryptedSecret: encrypted, updatedAt: new Date().toISOString(),
    };
    if (old) this.db.update(gitCredential).set(values).where(and(this.scope(serviceId, teamId, userId), eq(gitCredential.credentialId, id))).run();
    else this.db.insert(gitCredential).values(values).run();
    return toInfo(values);
  }

  assertUsable(serviceId: string, teamId: string, userId: string, id: string, repoUrl: string): void {
    this.key();
    const row = this.row(serviceId, teamId, userId, id);
    const source = parseGitSource(repoUrl);
    if (row.kind !== source.kind || (row.kind === "https" && httpsHostnameForSource(row.repoUrl) !== httpsHostnameForSource(repoUrl))) throw new GitCredentialError("Credential is scoped to a different Git hostname or authentication type", 403);
  }

  resolve(serviceId: string, teamId: string, userId: string, id: string, repoUrl: string): GitSecret {
    this.assertUsable(serviceId, teamId, userId, id, repoUrl);
    const row = this.row(serviceId, teamId, userId, id);
    const secret = this.decrypt(row);
    if (secret.kind === "ssh") {
      const source = parseGitSource(repoUrl);
      const trusted = this.db.select().from(gitTrustedHost).where(this.hostScope(serviceId, teamId, userId, source.serverUrl)).get();
      // Legacy verified entries remain valid for their exact host/port only.
      const legacy = secret.known_hosts?.split(/\r?\n/).filter(line => line.trim().split(/\s+/)[0] === source.knownHost).join("\n");
      const knownHosts = trusted?.knownHosts || legacy;
      return { kind: "ssh", private_key: secret.private_key, ...(knownHosts ? { known_hosts: knownHosts } : {}) };
    }
    return secret;
  }

  private decrypt(row: typeof gitCredential.$inferSelect): GitSecret {
    try {
      const [iv, tag, data] = row.encryptedSecret.split(".").map(part => Buffer.from(part, "base64"));
      const cipher = createDecipheriv("aes-256-gcm", this.key(), iv);
      cipher.setAAD(Buffer.from(JSON.stringify([row.serviceId, row.teamId, row.ownerUserId, row.credentialId, row.repoUrl])));
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8")) as GitSecret;
    } catch { throw new GitCredentialError("Cannot decrypt Git credential; restore the original encryption key", 503); }
  }

  private hostScope(serviceId: string, teamId: string, userId: string, serverUrl: string) {
    return and(eq(gitTrustedHost.serviceId, serviceId), eq(gitTrustedHost.teamId, teamId), eq(gitTrustedHost.ownerUserId, userId), eq(gitTrustedHost.serverUrl, serverUrl));
  }

  /** Explicit fingerprint confirmation only. Compare-and-swap prevents stale confirmations replacing newer trust. */
  trustHost(serviceId: string, teamId: string, userId: string, id: string, repoUrl: string, knownHosts: string, previous: string | null): void {
    const secret = this.resolve(serviceId, teamId, userId, id, repoUrl);
    if (secret.kind !== "ssh") throw new GitCredentialError("SSH credential required");
    const source = parseGitSource(repoUrl);
    const canonical = hostKeyEntries(knownHosts, source.knownHost).join("\n");
    const current = secret.known_hosts ? hostKeyEntries(secret.known_hosts, source.knownHost).join("\n") : null;
    if (current === canonical) return;
    if (current !== previous) throw new GitCredentialError("SSH server trust changed; inspect the fingerprint again", 409);
    const scope = this.hostScope(serviceId, teamId, userId, source.serverUrl);
    const values = { serviceId, teamId, ownerUserId: userId, serverUrl: source.serverUrl, knownHosts: canonical, updatedAt: new Date().toISOString() };
    // Synchronous SQLite transaction protects confirmations across worker processes.
    this.db.transaction(tx => {
      const row = tx.select().from(gitTrustedHost).where(scope).get();
      if (row && row.knownHosts !== current) throw new GitCredentialError("SSH server trust changed; inspect the fingerprint again", 409);
      if (row) tx.update(gitTrustedHost).set(values).where(scope).run();
      else tx.insert(gitTrustedHost).values(values).run();
    }, { behavior: "immediate" });
  }

  delete(serviceId: string, teamId: string, userId: string, id: string): void {
    this.row(serviceId, teamId, userId, id);
    const used = this.db.select({ id: knowledgeCodeGraph.codeGraphId }).from(knowledgeCodeGraph)
      .where(and(eq(knowledgeCodeGraph.serviceId, serviceId), eq(knowledgeCodeGraph.credentialId, id), isNull(knowledgeCodeGraph.deletedAt))).get();
    if (used) throw new GitCredentialError("Credential is in use; change or remove its CodeGraph bindings first", 409);
    this.db.delete(gitCredential).where(and(this.scope(serviceId, teamId, userId), eq(gitCredential.credentialId, id))).run();
  }
}

function toInfo(row: typeof gitCredential.$inferSelect): GitCredentialInfo {
  const hostname = row.kind === "ssh" ? null : httpsHostnameForSource(row.repoUrl);
  return { credential_id: row.credentialId, name: row.name, hostname,
    kind: row.kind as GitSecret["kind"], username: row.username, updated_at: row.updatedAt };
}
