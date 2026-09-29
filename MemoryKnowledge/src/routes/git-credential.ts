import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { GitCredentialStore, GitCredentialError, type GitSecret } from "../store/git-credential-store.js";
import { GitSourceFetcher } from "../source-fetcher/git-fetcher.js";
import { GitTransportError } from "../source-fetcher/git-auth.js";
import { hostKeyEntries, hostFingerprints } from "../source-fetcher/git-host-key.js";
import { parseGitSource } from "../source-fetcher/git-source.js";
import { isValidIdSegment, wrapOk, wrapError } from "../api-helpers.js";
import { verifyBearer } from "../middleware/auth.js";

/** S2S only: Panel supplies the authenticated user's identity after team gating.
 * These endpoints stay closed even when legacy KS authentication is disabled.
 */
export function createGitCredentialRoutes(store: GitCredentialStore, serviceKey: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!serviceKey) return c.json(wrapError(503, "Git credentials require KNOWLEDGE_SERVICE_KEY"), 503);
    if (!verifyBearer(c.req.header("authorization"), serviceKey)) return c.json(wrapError(401, "Service authentication required"), 401);
    return next();
  });
  app.use("*", bodyLimit({ maxSize: 160 * 1024 }));
  app.onError((error, c) => {
    if (error instanceof GitCredentialError) return c.json(wrapError(error.status, error.message), error.status);
    if (error instanceof GitTransportError) return c.json(wrapError(400, error.message), 400);
    // Never echo request bodies, ciphertext or third-party error details.
    return c.json(wrapError(400, "Invalid Git credential request"), 400);
  });
  for (const action of ["list", "put", "delete", "test", "host-key", "trust-host"] as const) {
    app.post(`/${action}`, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      const serviceId = c.req.header("x-tdai-service-id");
      const teamId = body.team_id;
      const userId = body.user_id;
      if (!isValidIdSegment(serviceId) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
        return c.json(wrapError(400, "service, team and user identity are required"), 400);
      }
      if (action === "list") return c.json(wrapOk({ items: store.list(serviceId, teamId, userId) }));
      if (action === "put") {
        if (body.credential_id !== undefined && !isValidIdSegment(body.credential_id)) throw new GitCredentialError("Invalid credential ID");
        return c.json(wrapOk(store.put(serviceId, teamId, userId, {
          credential_id: body.credential_id as string | undefined,
          name: body.name as string, hostname: body.hostname as string | undefined, secret: body.secret as GitSecret,
        })));
      }
      const id = body.credential_id;
      if (!isValidIdSegment(id)) throw new GitCredentialError("Credential ID is required");
      if (action === "delete") {
        store.delete(serviceId, teamId, userId, id);
        return c.json(wrapOk({ deleted: true }));
      }
      // The test repository is a one-time target, never a credential binding.
      const repoUrl = body.repo_url;
      if (typeof repoUrl !== "string" || !repoUrl) throw new GitCredentialError("A repository URL is required to test access");
      const secret = store.resolve(serviceId, teamId, userId, id, repoUrl);
      if (action === "host-key" || action === "trust-host") {
        if (secret.kind !== "ssh") throw new GitCredentialError("SSH credential required");
        const source = parseGitSource(repoUrl);
        if (action === "trust-host") {
          if (body.previous_known_hosts !== null && typeof body.previous_known_hosts !== "string") throw new GitCredentialError("Previous host trust is required");
          store.trustHost(serviceId, teamId, userId, id, repoUrl, body.known_hosts as string, body.previous_known_hosts);
          return c.json(wrapOk({ trusted: true }));
        }
        const previous = secret.known_hosts ? hostKeyEntries(secret.known_hosts, source.knownHost).join("\n") : null;
        const keys = previous && body.refresh !== true ? previous : await new GitSourceFetcher().hostKeys(repoUrl);
        return c.json(wrapOk({ server_url: source.serverUrl, trusted: keys === previous,
          known_hosts: keys, previous_known_hosts: previous, fingerprints: hostFingerprints(keys) }));
      }
      if (secret.kind === "ssh" && !secret.known_hosts) throw new GitCredentialError("Confirm the SSH server fingerprint before connecting", 409);
      await new GitSourceFetcher().test(repoUrl, secret);
      return c.json(wrapOk({ accessible: true }));
    });
  }
  return app;
}
