import { createHash } from "node:crypto";
import {
  bundleDigest,
  fetchGitHubSkill,
  normalizeGitHubLocation,
  GitHubSourceError,
  type GitHubLocation,
  type GitHubSnapshot,
  type GitHubSource,
} from "./github-source.js";
import type { ISkillStore } from "./skill-store.interface.js";
import type {
  SkillResourceStore,
  SkillResourcePayload,
} from "./skill-resource-store.js";
import type { SkillVersioning } from "./skill-versioning.js";
import type { Skill, GitHubCheck } from "./types.js";
import {
  assertOwner,
  assertTeamMatch,
  assertVersionFresh,
  SkillPermissionError,
} from "./skill-permission.js";
import { parseSkillFile, validateSkillFile } from "./skill-format.js";

export interface GitHubRequest {
  team_id: string;
  agent_id: string;
  user_id: string;
  skill_id?: string;
  repository?: string;
  ref?: string;
  path?: string;
}
export interface GitHubApplyRequest extends GitHubRequest {
  expected_version: number;
  commit: string;
  digest: string;
  overwrite_local?: boolean;
}
interface Options {
  store: ISkillStore;
  resources: SkillResourceStore;
  versioning: SkillVersioning;
  fetcher?: (input: GitHubLocation) => Promise<GitHubSnapshot>;
  assertReadableVersion?: (target: Skill, head: Skill) => void;
}
// Coalesce retries within a store instance; database expected_version remains authoritative.
const locks = new WeakMap<ISkillStore, Map<string, Promise<unknown>>>();
export class GitHubSkillManager {
  private readonly fetcher: NonNullable<Options["fetcher"]>;
  constructor(private readonly opts: Options) {
    this.fetcher = opts.fetcher ?? fetchGitHubSkill;
  }

  private scope(input: GitHubRequest) {
    if (
      ![input.team_id, input.agent_id, input.user_id].every(
        (v) => typeof v === "string" && v.trim(),
      )
    ) {
      throw new GitHubSourceError("team_id, agent_id and user_id are required");
    }
  }
  private async head(input: GitHubRequest): Promise<Skill | null> {
    this.scope(input);
    if (!input.skill_id) return null;
    const head = await this.opts.store.getHead(input.skill_id, input.team_id);
    assertTeamMatch(head, input.team_id);
    assertOwner(head, input.agent_id, input.team_id);
    return head;
  }
  private source(head: Skill): GitHubSource {
    const source = JSON.parse(head.metadata_json).github_source as
      GitHubSource | undefined;
    if (!source?.repository || !source.commit || !source.digest)
      throw new GitHubSourceError("Skill is not linked to GitHub");
    return source;
  }
  private location(input: GitHubRequest, head: Skill | null) {
    return normalizeGitHubLocation(
      head
        ? this.source(head)
        : {
            repository: input.repository ?? "",
            ref: input.ref,
            path: input.path,
          },
    );
  }
  private async bundle(
    head: Skill,
  ): Promise<{ content: string; resources: SkillResourcePayload[] }> {
    const resources: SkillResourcePayload[] = [];
    for (const entry of head.manifest) {
      const r = await this.opts.resources.readResource(
        head.skill_id,
        head.version,
        entry.path,
        "base64",
        head.storage_dir,
      );
      if (!r) throw new Error(`Missing stored resource: ${entry.path}`);
      resources.push({
        path: entry.path,
        content: r.content,
        encoding: "base64",
        is_executable: entry.is_executable,
      });
    }
    return { content: head.content, resources };
  }
  async preview(input: GitHubRequest) {
    const head = await this.head(input);
    let snapshot: GitHubSnapshot;
    try {
      snapshot = await this.fetcher(this.location(input, head));
    } catch (error) {
      if (head)
        await this.opts.store
          .recordGitHubCheck(head, {
            checked_at: new Date().toISOString(),
            status: "error",
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "GitHub check failed",
          })
          .catch(() => {});
      throw error;
    }
    const current = head
      ? await this.bundle(head)
      : { content: "", resources: [] };
    const files = diffFiles(current.resources, snapshot.resources);
    const parsed = parseSkillFile(snapshot.content);
    validateSkillFile(parsed);
    if (head && parsed.frontmatter.name !== head.name)
      throw new GitHubSourceError(
        "Upstream renamed this Skill; install it separately",
      );
    if (head) {
      const check: GitHubCheck = {
        checked_at: snapshot.source.checked_at,
        status:
          snapshot.source.commit === this.source(head).commit &&
          snapshot.source.digest === this.source(head).digest
            ? "current"
            : "update_available",
        remote_commit: snapshot.source.commit,
      };
      if (!(await this.opts.store.recordGitHubCheck(head, check))) {
        throw new SkillPermissionError(
          "SKILL_VERSION_STALE",
          "Skill changed while checking; check again",
        );
      }
    }
    return {
      source: snapshot.source,
      previous_source: head ? this.source(head) : null,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: snapshot.content,
      previous_content: current.content,
      files,
      expected_version: head?.version ?? 0,
      local_modified:
        !!head &&
        bundleDigest(current.content, current.resources) !==
          this.source(head).digest,
      update_available:
        !head ||
        snapshot.source.commit !== this.source(head).commit ||
        snapshot.source.digest !== this.source(head).digest,
    };
  }
  async apply(
    input: GitHubApplyRequest,
    beforePublish?: () => Promise<void>,
  ): Promise<Skill> {
    const observed = await this.head(input);
    const location = this.location(input, observed);
    if (
      !/^[a-f0-9]{40}$/.test(input.commit) ||
      !/^[a-f0-9]{64}$/.test(input.digest) ||
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 0
    ) {
      throw new GitHubSourceError(
        "A preview commit, digest and expected_version are required",
      );
    }
    const sid =
      input.skill_id ??
      `skl-${createHash("sha256")
        .update(
          JSON.stringify([
            input.team_id,
            input.agent_id,
            location.repository,
            location.path,
          ]),
        )
        .digest("hex")
        .slice(0, 24)}`;
    return this.locked(sid, async () => {
      const head = await this.opts.store.getHeadIncludingArchived(
        sid,
        input.team_id,
      );
      if (head) {
        assertOwner(head, input.agent_id, input.team_id);
        if (head.status !== "active")
          throw new SkillPermissionError(
            "SKILL_VERSION_STALE",
            "Skill was archived",
          );
        const source = this.source(head);
        const current = await this.bundle(head);
        const digest = bundleDigest(current.content, current.resources);
        if (
          source.repository !== location.repository ||
          source.path !== location.path ||
          source.ref !== location.ref
        )
          throw new GitHubSourceError("Source changed; preview again");
        if (
          source.commit === input.commit &&
          source.digest === input.digest &&
          digest === input.digest
        ) {
          await this.opts.versioning.ensureBundleAsset(head);
          return head;
        }
        assertVersionFresh(head, input.expected_version);
        if (digest !== source.digest && input.overwrite_local !== true)
          throw new SkillPermissionError(
            "SKILL_VERSION_STALE",
            "Local edits detected; preview and explicitly confirm replacement",
          );
      } else if (input.expected_version !== 0 || input.skill_id) {
        throw new SkillPermissionError("SKILL_NOT_FOUND");
      }
      // Download the exact preview commit again: branch movement cannot alter confirmation.
      const snapshot = await this.fetcher({ ...location, ref: input.commit });
      if (
        snapshot.source.commit !== input.commit ||
        bundleDigest(snapshot.content, snapshot.resources) !== input.digest
      )
        throw new GitHubSourceError(
          "Preview differs from downloaded commit; preview again",
        );
      const parsed = parseSkillFile(snapshot.content);
      validateSkillFile(parsed);
      if (head && head.name !== parsed.frontmatter.name)
        throw new GitHubSourceError(
          "Upstream renamed this Skill; install it separately",
        );
      await beforePublish?.();
      return this.opts.versioning.replaceBundle(sid, head, input, {
        content: snapshot.content,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        resourcesToWrite: snapshot.resources,
        metadata_json: JSON.stringify({
          ...(head ? JSON.parse(head.metadata_json) : {}),
          github_source: { ...snapshot.source, ...location },
          github_check: {
            checked_at: snapshot.source.checked_at,
            status: "current",
            remote_commit: snapshot.source.commit,
          },
        }),
      });
    });
  }
  async detach(
    input: GitHubRequest & { expected_version: number },
  ): Promise<Skill> {
    const head = await this.head(input);
    if (!head) throw new SkillPermissionError("SKILL_NOT_FOUND");
    return this.locked(head.skill_id, async () => {
      const current = (await this.head(input))!;
      assertVersionFresh(current, input.expected_version);
      const metadata = JSON.parse(current.metadata_json);
      if (!metadata.github_source) return current;
      delete metadata.github_source;
      delete metadata.github_check;
      const bundle = await this.bundle(current);
      return this.opts.versioning.replaceBundle(
        current.skill_id,
        current,
        input,
        {
          ...bundle,
          resourcesToWrite: bundle.resources,
          name: current.name,
          description: current.description,
          metadata_json: JSON.stringify(metadata),
        },
      );
    });
  }
  private async restoreTarget(
    input: GitHubRequest & { source_version: number },
    head: Skill,
  ) {
    if (
      !Number.isSafeInteger(input.source_version) ||
      input.source_version < 1 ||
      input.source_version >= head.version
    ) {
      throw new GitHubSourceError("Select an earlier version to restore");
    }
    const target = await this.opts.store.getByVersion(
      head.skill_id,
      input.source_version,
      input.team_id,
    );
    if (!target)
      throw new SkillPermissionError(
        "SKILL_NOT_FOUND",
        "Historical version is unavailable",
      );
    this.opts.assertReadableVersion?.(target, head);
    return target;
  }
  async previewRestore(input: GitHubRequest & { source_version: number }) {
    const head = await this.head(input);
    if (!head) throw new SkillPermissionError("SKILL_NOT_FOUND");
    const target = await this.restoreTarget(input, head);
    const before = await this.bundle(head);
    const after = await this.bundle(target);
    return {
      source_version: target.version,
      expected_version: head.version,
      digest: bundleDigest(after.content, after.resources),
      name: target.name,
      content: after.content,
      previous_content: before.content,
      files: diffFiles(before.resources, after.resources),
      source: JSON.parse(target.metadata_json).github_source ?? null,
    };
  }
  async restore(
    input: GitHubRequest & {
      source_version: number;
      expected_version: number;
      digest: string;
    },
    beforePublish?: () => Promise<void>,
  ): Promise<Skill> {
    const initial = await this.head(input);
    if (!initial) throw new SkillPermissionError("SKILL_NOT_FOUND");
    return this.locked(initial.skill_id, async () => {
      const head = (await this.head(input))!;
      const receipt = JSON.parse(head.metadata_json).restored_from;
      if (
        head.version === input.expected_version + 1 &&
        receipt?.version === input.source_version &&
        receipt?.digest === input.digest &&
        receipt?.expected_version === input.expected_version
      ) {
        const current = await this.bundle(head);
        if (bundleDigest(current.content, current.resources) === input.digest) {
          await this.opts.versioning.ensureBundleAsset(head);
          return head;
        }
      }
      assertVersionFresh(head, input.expected_version);
      const target = await this.restoreTarget(input, head);
      const bundle = await this.bundle(target);
      if (bundleDigest(bundle.content, bundle.resources) !== input.digest)
        throw new GitHubSourceError(
          "Historical package changed; preview again",
        );
      const metadata = JSON.parse(target.metadata_json);
      delete metadata.github_check;
      metadata.restored_from = {
        version: target.version,
        expected_version: head.version,
        digest: input.digest,
      };
      await beforePublish?.();
      return this.opts.versioning.replaceBundle(head.skill_id, head, input, {
        content: target.content,
        name: target.name,
        description: target.description,
        resourcesToWrite: bundle.resources,
        metadata_json: JSON.stringify(metadata),
      });
    });
  }
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let map = locks.get(this.opts.store);
    if (!map) {
      map = new Map();
      locks.set(this.opts.store, map);
    }
    const previous = map.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    map.set(key, next);
    try {
      return await next;
    } finally {
      if (map.get(key) === next) map.delete(key);
    }
  }
}
function diffFiles(
  before: SkillResourcePayload[],
  after: SkillResourcePayload[],
) {
  const hash = (r: SkillResourcePayload) => bundleDigest("", [r]);
  const a = new Map(before.map((r) => [r.path, hash(r)]));
  const b = new Map(after.map((r) => [r.path, hash(r)]));
  return {
    added: [...b.keys()].filter((p) => !a.has(p)).sort(),
    removed: [...a.keys()].filter((p) => !b.has(p)).sort(),
    changed: [...b.keys()]
      .filter((p) => a.has(p) && a.get(p) !== b.get(p))
      .sort(),
  };
}
