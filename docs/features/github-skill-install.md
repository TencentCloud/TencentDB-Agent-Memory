# Install and update a Skill from GitHub

The Skills import dialog now has a **GitHub** tab. Select an agent, enter a public
`https://github.com/owner/repository` URL, optionally select a branch/tag/commit and
Skill subdirectory, then preview and confirm installation. The selected directory
must contain `SKILL.md`; other regular files become resources, preserving paths
relative to that directory and executable bits. Nothing is executed during import.

The detail pane displays the repository, directory, requested ref, resolved commit,
optional frontmatter `version`, and the check timestamp associated with the installed
snapshot. **Check GitHub updates** performs a fresh read without modifying the Skill.
The dialog displays that check's timestamp, incoming commit, current/incoming
`SKILL.md`, and added/changed/removed resource paths. Confirming creates a complete
new Skill version. Existing history, resource reads and ZIP exports continue to work.
A manually checked timestamp is returned in the preview; it is persisted with the
source metadata only when a version is installed, avoiding a new version for a read.

If the body, resource bytes, paths or executable bits were edited locally, upgrade
requires explicit replacement consent. **Detach and keep local version** creates a
new version retaining the local package and removing its GitHub tracking metadata.
Closing the dialog before confirmation cancels the update. Historical versions keep
their original provenance. This MVP does not add a separate history-restore action.

## API

Panel routes are `POST /api/v1/skill/github/{preview,apply,detach}` and proxy the
corresponding `/v3/skill/github/*` routes. Panel verifies the authenticated user's
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
resource change lists. Apply includes the same identity/location (or `skill_id`),
that exact commit/digest/expected version, and `overwrite_local: true` only after
explicit consent. The server downloads the immutable commit again and verifies its
bundle digest. Moving a branch after preview cannot change the approved package.
Detach takes the identity, `skill_id` and `expected_version`.

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
- Only regular Git blobs are imported; symlinks, submodules and unsafe paths fail
  before publication. Every downloaded blob is checked against its Git object hash.
- GitHub's anonymous API quota applies. HTTP errors, including rate limiting, leave
  the installed package intact and are returned to the user for retry.
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
and team/instance isolation. UI tests render the real Tea components and verify the
preview/confirmation, conflict consent, detach, retry and preview-invalidation flows.
