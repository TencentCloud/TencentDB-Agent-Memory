import type { Db } from "../db/client.js";
import { isValidIdSegment } from "../api-helpers.js";
import type { CodeSourceRegistry } from "../code-source/registry.js";
import { GitSourceFetcher } from "../source-fetcher/git-fetcher.js";
import { parseGitSource, validateGitBranch } from "../source-fetcher/git-source.js";
import { GitCredentialStore, GitCredentialError, validateGitSecret, type GitSecret } from "../store/git-credential-store.js";
import type { CodeGraphRow, IKnowledgeStore } from "../store/types.js";
import type { CreateCodeGraphParams } from "../store/code-graph-service.js";
import type { CredentialStatus, ICredentialStore, SourceCredential } from "./types.js";

/** Internal representation only; the existing HTTP request formats stay unchanged. */
export type CodeGraphAuthInput =
  | { mode: "none" }
  | { mode: "saved"; credential_id: string; share_with_team?: boolean }
  | { mode: "resource"; provider_id: string; secret: string; username?: string };

/** Membership is verified at the HTTP boundary, independently of credential input. */
export interface CodeGraphAuthActor {
  serviceId: string;
  teamId: string;
  userId: string;
  serviceAuthenticated: boolean;
}

export class CodeGraphAuthError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 503 = 400) {
    super(message);
    this.name = "CodeGraphAuthError";
  }
}

export interface CodeGraphAuthServiceOptions {
  db: Db;
  store: IKnowledgeStore;
  gitCredentialStore: GitCredentialStore;
  credentialStore: ICredentialStore;
  codeSourceRegistry: CodeSourceRegistry;
}

/** Shares authentication rules across the existing Git and provider routes.
 * Stores must use the same SQLite connection: reads see one snapshot, while
 * creation, replacement and deletion commit before any worker can use them.
 */
export class CodeGraphAuthService {
  constructor(private readonly deps: CodeGraphAuthServiceOptions) {}

  replace(serviceId: string, graphId: string, input: CodeGraphAuthInput, actor: CodeGraphAuthActor): CodeGraphRow {
    return this.deps.db.transaction(() => {
      const { row } = this.read(serviceId, graphId);
      this.authorize(row, actor);
      if (row.credential_id !== null || input.mode === "saved") {
        this.requireServiceAuth(actor);
        if (row.owner_user_id !== actor.userId) throw new CodeGraphAuthError("Only the graph owner may replace saved Git authentication", 403);
      }
      if (row.status === "pending" || row.status === "processing") throw new CodeGraphAuthError("Code graph is busy", 409);
      const credential = this.validateTarget(row, input, actor);
      return this.write(row, input, credential, actor.userId);
    }, { behavior: "immediate" });
  }

  resolve(serviceId: string, graphId: string): { url: string; auth?: GitSecret } {
    return this.deps.db.transaction(() => {
      const { row, resource } = this.read(serviceId, graphId);
      this.rejectConflict(row, resource);
      try {
        if (row.credential_id !== null) {
          const auth = this.deps.gitCredentialStore.resolve(serviceId, row.team_id, row.owner_user_id ?? "", row.credential_id, row.repo_url);
          validateGitSecret(auth);
          return { url: row.repo_url, auth };
        }
        if (resource) {
          const credential = this.deps.credentialStore.get(this.ref(serviceId, graphId));
          if (!credential) throw new Error("Unreadable resource credential");
          return this.resolveResource(resource.provider_id, row.repo_url, credential);
        }
        if (parseGitSource(row.repo_url).kind === "ssh") throw new Error("Missing SSH credential");
        return { url: row.repo_url };
      } catch {
        // A stored but broken binding is never interpreted as public access.
        throw new CodeGraphAuthError("Repository authentication is invalid or unavailable; repair it before syncing", 409);
      }
    });
  }

  resourceStatus(serviceId: string, graphId: string, actor: CodeGraphAuthActor): CredentialStatus | null {
    return this.deps.db.transaction(() => {
      const { row, resource } = this.read(serviceId, graphId);
      this.authorize(row, actor);
      if (row.credential_id !== null) this.requireServiceAuth(actor);
      return resource;
    });
  }

  /** Legacy resource DELETE must never remove an owner's reusable binding. */
  deleteResource(serviceId: string, graphId: string, actor: CodeGraphAuthActor): { deleted: boolean } {
    return this.deps.db.transaction(() => {
      const { row, resource } = this.read(serviceId, graphId);
      this.authorize(row, actor);
      if (row.credential_id !== null) this.requireServiceAuth(actor);
      if (!resource) throw new CodeGraphAuthError("Resource credential not found", 404);
      this.rejectConflict(row, resource);
      this.replace(serviceId, graphId, { mode: "none" }, actor);
      return { deleted: true };
    }, { behavior: "immediate" });
  }

  create(params: CreateCodeGraphParams): { row: CodeGraphRow; existed: boolean } {
    if (params.credential_id !== undefined && params.credential !== undefined) throw new CodeGraphAuthError("Select either a saved Git credential or a source provider");
    const input: CodeGraphAuthInput = params.credential_id !== undefined
      ? { mode: "saved", credential_id: params.credential_id, share_with_team: params.share_with_team }
      : params.credential !== undefined ? { ...params.credential, mode: "resource" } : { mode: "none" };
    try {
      new GitSourceFetcher().validate(params.repo_url);
      validateGitBranch(params.branch);
    } catch (error) {
      throw new CodeGraphAuthError(error instanceof Error ? error.message : "Invalid repository URL or branch");
    }
    if (parseGitSource(params.repo_url).kind === "ssh" && input.mode !== "saved") throw new CodeGraphAuthError("SSH repositories require a saved SSH credential");
    const actor = params.authActor;
    if (input.mode !== "none" && !actor) throw new CodeGraphAuthError("Authenticated identity is required to configure repository credentials", 401);
    if (input.mode === "saved") this.requireServiceAuth(actor!);
    if (actor && (actor.serviceId !== params.service_id || actor.teamId !== params.team_id ||
        (params.owner_user_id !== undefined && params.owner_user_id !== actor.userId))) throw new CodeGraphAuthError("Repository identity does not match the authenticated caller", 403);
    return this.deps.db.transaction(() => {
      // Validate the submitted credential even when the repository already exists.
      // The requester's own credential is checked without requiring ownership of
      // the existing graph; an idempotent create never changes that graph's binding.
      const scope = { service_id: params.service_id, team_id: params.team_id, repo_url: params.repo_url,
        owner_user_id: actor?.userId ?? params.owner_user_id ?? null };
      if (actor) this.authorize(scope, actor);
      const credential = this.validateTarget(scope, input, actor);
      const result = this.deps.store.createCodeGraph({ ...params, credential_id: undefined,
        ...(actor ? { owner_user_id: actor.userId, user_id: actor.userId } : {}) });
      if (result.existed) return result;
      const row = input.mode === "none" ? result.row : this.write(result.row, input, credential, actor!.userId);
      return { row, existed: false };
    }, { behavior: "immediate" });
  }

  /** Asset deletion removes the resource secret, never the reusable vault entry. */
  cleanup(serviceId: string, graphId: string): void {
    this.deps.db.transaction(() => {
      const row = this.deps.store.getCodeGraphById(serviceId, graphId);
      this.deps.credentialStore.delete(this.ref(serviceId, graphId));
      if (row) this.deps.store.deleteCodeGraph(serviceId, row.team_id, graphId);
    }, { behavior: "immediate" });
  }

  private ref(serviceId: string, resourceId: string) {
    return { type: "code-graph" as const, serviceId, resourceId };
  }

  private read(serviceId: string, graphId: string) {
    const row = this.deps.store.getCodeGraphById(serviceId, graphId);
    if (!row) throw new CodeGraphAuthError("Code graph not found", 404);
    return { row, resource: this.deps.credentialStore.status(this.ref(serviceId, graphId)) };
  }

  private authorize(row: Pick<CodeGraphRow, "service_id" | "team_id">, actor: CodeGraphAuthActor): void {
    if (!actor || !isValidIdSegment(actor.userId) || actor.serviceId !== row.service_id || actor.teamId !== row.team_id) throw new CodeGraphAuthError("Code graph not found for this caller", 404);
  }

  private requireServiceAuth(actor: CodeGraphAuthActor): void {
    if (actor.serviceAuthenticated !== true) throw new CodeGraphAuthError("Saved Git credentials require service authentication", 401);
  }

  private rejectConflict(row: CodeGraphRow, resource: CredentialStatus | null): void {
    if (row.credential_id !== null && resource) throw new CodeGraphAuthError("Multiple authentication configurations exist; replace the repository authentication", 409);
  }

  private resolveResource(providerId: string, repoUrl: string, credential: SourceCredential): { url: string; auth: GitSecret } {
    const provider = this.deps.codeSourceRegistry.get(providerId);
    if (!provider || credential.kind !== provider.authMethod.kind) throw new CodeGraphAuthError("Code source provider is unavailable or its credential type does not match");
    if (provider.applyToCloneUrl) throw new CodeGraphAuthError("Legacy clone URL overrides cannot be used with isolated Git authentication");
    const source = parseGitSource(repoUrl);
    if (source.kind !== "https") throw new CodeGraphAuthError("Source provider credentials require an HTTPS repository URL");
    const auth = provider.authMethod.toGitAuth(credential, provider.cloneUsername);
    validateGitSecret(auth);
    return { url: source.url, auth };
  }

  private validateTarget(row: Pick<CodeGraphRow, "service_id" | "team_id" | "repo_url" | "owner_user_id">, input: CodeGraphAuthInput, actor?: CodeGraphAuthActor): SourceCredential | undefined {
    if (input.mode === "none") {
      if (parseGitSource(row.repo_url).kind === "ssh") throw new CodeGraphAuthError("SSH repositories require a saved SSH credential");
      return;
    }
    if (!actor) throw new CodeGraphAuthError("Authenticated identity is required", 401);
    if (input.mode === "saved") {
      this.requireServiceAuth(actor);
      if (!isValidIdSegment(input.credential_id)) throw new CodeGraphAuthError("Invalid saved credential ID");
      if (row.owner_user_id !== actor.userId) throw new CodeGraphAuthError("Only the graph owner may select a saved credential", 403);
      if (input.share_with_team !== true) throw new CodeGraphAuthError("Confirm sharing the indexed repository with this team");
      try {
        validateGitSecret(this.deps.gitCredentialStore.resolve(row.service_id, row.team_id, actor.userId, input.credential_id, row.repo_url));
      } catch (error) {
        if (error instanceof GitCredentialError) throw new CodeGraphAuthError(error.message, error.status);
        throw new CodeGraphAuthError("Saved Git credential is invalid or unavailable");
      }
      return;
    }
    if (input.mode !== "resource" || typeof input.provider_id !== "string" || !input.provider_id || typeof input.secret !== "string" || !input.secret ||
        (input.username !== undefined && typeof input.username !== "string")) throw new CodeGraphAuthError("A source provider and valid credentials are required");
    const provider = this.deps.codeSourceRegistry.get(input.provider_id);
    if (!provider) throw new CodeGraphAuthError("Code source provider is not enabled");
    try {
      const credential = { kind: provider.authMethod.kind, ...provider.authMethod.buildCredential({ secret: input.secret, username: input.username }) };
      this.resolveResource(input.provider_id, row.repo_url, credential);
      return credential;
    } catch {
      throw new CodeGraphAuthError("Invalid credentials for the selected repository provider");
    }
  }

  private write(row: CodeGraphRow, input: CodeGraphAuthInput, credential: SourceCredential | undefined, userId: string): CodeGraphRow {
    const ref = this.ref(row.service_id, row.code_graph_id);
    this.deps.credentialStore.delete(ref);
    if (input.mode === "resource") this.deps.credentialStore.put(ref, credential!, input.provider_id, userId);
    return this.deps.store.updateCodeGraphMeta(row.service_id, row.code_graph_id, { credential_id: input.mode === "saved" ? input.credential_id : null })!;
  }
}
