# Install and update a Skill from GitHub

The Skills import dialog now has a **GitHub** tab. Select an agent, enter a public
`https://github.com/owner/repository` URL, optionally select a branch/tag/commit and
Skill subdirectory, then preview and confirm installation. The selected directory
must contain `SKILL.md`; other regular files become resources, preserving paths
relative to that directory and executable bits. Nothing is executed during import.

The detail pane displays the repository, directory, requested ref, resolved commit,
optional frontmatter `version`, installed snapshot timestamp, and the last manual
check (time, remote commit, success/update/error status). Checks persist independently
of content versions, including failed requests, so reloading does not lose their
results. A stale check cannot write into an obsolete or different-team head.

**Check GitHub updates** opens the same near-full-screen package reviewer used for
installation and historical restore. A searchable file list distinguishes added,
changed and removed files; unchanged files are hidden initially. Select `SKILL.md`
or any text attachment to review numbered additions/deletions, expand unchanged
context, or jump between changes (buttons or Alt+Up/Down). Wide layouts use aligned
columns and narrow layouts default to a unified diff; the layout can also be switched
manually. Markdown has a separate reading view without loading embedded images.
Source details are collapsed and commit IDs are shortened with full-value copy.

Text attachments load on selection against the exact preview commit/digest and
current version. Switching files cancels obsolete requests; refreshing the preview
clears file caches and replacement consent. Binary and oversized files show sizes,
file modes and SHA-256 summaries instead of partial or fabricated text differences.
Confirming creates a complete new Skill version. If the body, resource
bytes, paths or executable bits were edited locally, upgrade requires explicit
replacement consent. **Detach and keep local version** creates a version retaining
the package and removing tracking. Closing the dialog cancels the update.

Open **History**, view an earlier version, and select **Restore this version**. Preview
shows the current and historical bodies and resource differences. After explicit
confirmation, the entire historical package (body, all attachments and provenance)
is published as a new version; existing versions remain readable. Expired history,
concurrent changes and changed package digests are rejected. Repeating a successful
restore returns the same version, including a retry after a lost response.

## API

Panel routes are `POST /api/v1/skill/github/{preview,preview-file,apply,detach}` and proxy the
corresponding `/v3/skill/github/*` routes. Restore routes are
`POST /api/v1/skill/versions/{restore-preview,restore-file,restore}` (the Gateway uses `/v3/skill/versions/*`).
Panel verifies the authenticated user's
team membership and agent ownership, and supplies the authenticated `user_id`.
Direct Kernel callers use the existing authenticated service API boundary.

Preview an installation:

```json
{
  "team_id": "team-id",
  "agent_id": "agent-id",
  "user_id": "user-id",
  "repository": "https://github.com/owner/repository",
  "ref": "main",
  "path": "skills/example"
}
```

To check an installed Skill, supply `skill_id` and the identity fields; the server
loads its saved source. The response includes `source.commit`, `source.digest`,
`expected_version`, `local_modified`, `update_available`, content comparison and
resource change lists, and `review_files` descriptors (path, status, before/after
size, executable bit, hash and any non-text reason). `github/preview-file` takes
the apply identity/location, commit, digest, expected version and `file_path`;
`versions/restore-file` takes the restore identity, source version, expected version,
digest and `file_path`. Each returns one descriptor with bounded text on either side.
Paths must be members of the compared packages; stale previews and foreign owners
are rejected before returning contents. Apply includes the same identity/location (or `skill_id`),
that exact commit/digest/expected version, and `overwrite_local: true` only after
explicit consent. The server loads the verified immutable commit and verifies its
bundle digest. Moving a branch after preview cannot change the approved package.
Detach takes the identity, `skill_id` and `expected_version`.
Restore preview takes the identity, `skill_id` and `source_version`; confirmation
also requires the returned `expected_version` and `digest`. No restore endpoint
reads from GitHub: rollback remains available during an upstream outage.

Repeated confirmation of an already published, unchanged package returns its
existing version, including retries after lost responses or asset registration
failures. Source identity is scoped by team, owning agent, repository and path.
Publication writes all resources to a private directory before appending the row;
readers use the row's stored directory. A failed stage is cleaned up without touching
another writer. Unknown database acknowledgment failures retain the staged bytes
unless publication can be recovered by reading the stored version, so a potentially
committed package is never deleted. Unreferenced directories after ambiguous failures
may require storage housekeeping; this change does not introduce a background reaper.

## Limits and deployment notes

- Public GitHub only; no credentials accepted in URLs, private repositories, redirects,
  Git execution, install hooks, automatic polling, or other hosting platforms.
- At most 100 resources plus `SKILL.md`, 5 MB per file, 50 MB per package, bounded API
  responses and a 60-second download deadline. Truncated repository trees are rejected.
- Text review is capped at 100,000 bytes and 2,000 lines per side. Invalid UTF-8 and
  control-character content is summarized as binary. Browser diff calculation has
  a 50 ms / 1,500-edit bound and falls back to an explicit summary for complex changes.
  These display limits do not truncate the package saved on confirmation.
- Only regular Git blobs are imported; symlinks, submodules and unsafe paths fail
  before publication. Every downloaded blob is checked against its Git object hash.
- Anonymous GitHub access works without configuration but has a small shared API quota.
  Operators may set `TDAI_SKILL_GITHUB_TOKEN` on the Gateway to raise the public-read
  quota. Use a dedicated token with only the access required for public repositories.
  The token is never accepted from the browser or a repository URL, nor returned in
  responses. Authenticated fetches first verify the repository is public; private
  imports remain unsupported. Redirects are refused, including authenticated requests.
- Verified snapshots are cached by repository, directory and immutable commit (32 MB,
  10 minutes, LRU eviction). Branch/tag checks still resolve the ref each time; pinned
  confirmation reuses verified bytes. Each caller receives an isolated copy. Errors,
  including rate limiting, leave the installed package intact and remain retryable.
- SQLite checks `expected_version` inside its transaction. MongoDB uses its existing
  unique version index; duplicate publication is translated to a version conflict.
  TCVDB retains its existing head-flip CAS and read-time head repair semantics.
  Installation retries are serialized within a shared store instance. This is not a
  new distributed exactly-once guarantee for first-time TCVDB creation across gateways.
- Live TCVDB/COS testing needs deployment credentials. The test suite exercises its
  transport contract with a substituted client; SQLite/filesystem and MongoDB CRUD
  tests use real local storage engines.

## Validation

```sh
npm --prefix MemoryCore test
npm --prefix MemoryCore run build:plugin
npm --prefix MemoryPanel test
npm --prefix MemoryPanel run typecheck
npm --prefix MemoryPanel/web run test:skill-github
npm --prefix MemoryPanel/web run build
```

Core tests start loopback HTTP and temporary MongoDB servers. Tests cover pinned
commits, bounded downloads, integrity checks, duplicate confirmation, attachment-only
updates/deletions, local-edit conflicts, detach, historical resources/exports,
interrupted writes, lost acknowledgments, asset-registration retries, version races,
and team/instance isolation. Restore tests cover full-package recovery, idempotence,
interrupted writes, expired history, stale previews and tenant boundaries. UI tests
render the real Tea components and verify preview/confirmation, conflict consent,
detach, restore consent/cancel/retry, preview invalidation, version-cache refresh
and isolation, lazy attachment loading, obsolete response cancellation, binary and
large-file summaries, EOF/line numbering, context folding, stale-preview refresh,
and first-install modal expansion/dismissal locking. The feature requires Gateway + Panel + Web; GitHub import and restore
do not require a configured LLM, Knowledge service or MemoryProxy.
