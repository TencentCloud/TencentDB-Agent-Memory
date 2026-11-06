# Scoped memory overlay — opt-in experiment

This is a small local experiment for one owner's private Multica agent. It adds
combined retrieval without changing the existing Memory Core/Hub/Proxy accounts,
credentials, service configuration or stored project memories. It is **not** the
Hub's L0/L1 extraction pipeline and is not enabled by installing this directory.

## Data and access

| Scope | Default readers | Runtime writers |
| --- | --- | --- |
| `public` | This owner's enabled private agent, across configured projects | None; local human approval only |
| `daily` | The same agent in no-project issues/chats | Current no-project issue/chat |
| `project:<UUID>` | The same agent in that project | Current project issue |

“Public” means shared across this owner's projects, not workspace-public. Runtime
identity comes from task-scoped Multica credentials, the daemon marker, live issue
metadata, the configured private agent owner and project resources. Unknown
projects fail closed. Each source is pinned to its first scope; moving an issue
requires a new issue/session. Parallel tasks do not modify any shared selection.

Every result includes its scope, source, timestamp, state, revision and previous
record ID. Raw archives and explicit summaries are separate records. Only the
latest confirmed revision is returned. Superseded/revoked records remain in the
audit history and are not physically erased. Records from memory are data, not
instructions or authority to execute an action.

## Install for an experiment

Copy `scoped_memory.py` into a dedicated private directory outside the checkout.
Use mode 0700 for the directory. Create `scope-config.json` with mode 0600:

```json
{
  "workspace_id": "<real Multica workspace UUID>",
  "agent_id": "<private test agent UUID>",
  "owner_id": "<the authorized human owner UUID>",
  "projects": ["<explicitly authorized project UUID>"]
}
```

No keys or service credentials belong in this file. The tool creates
`overlay.sqlite` alongside it using umask 077. Do not install it into a directory
readable by other OS users. Do not share the configured agent or change its owner;
the next call will reject that change. This prototype uses an explicit project
allowlist; the owner must remove a project if authorization is withdrawn.

## Runtime use

In an authorized Multica task, replace `<tool>` below with the installed script:

```sh
python3 <tool> query --query "relevant phrase"
python3 <tool> query --kind skill
python3 <tool> archive --name "unique-source-note" --text-file raw.txt
python3 <tool> remember --name "decision-key" --kind fact --text-file summary.txt
python3 <tool> propose --name "reply-style" --kind preference --text-file preference-summary.txt
```

`archive` stores raw text in the current scope. `remember` stores an explicitly
chosen fact, preference, task status or method in the current scope. A model
choosing “confirmed” is not evidence of human verification; the source must be
checked before treating a remembered business fact as authoritative.

`propose` saves a private candidate, excluded from default retrieval. It does not
publish to `public`. Summarize only the stable preference or validated method,
not its original private conversation. Ambiguous statements remain in the raw
archive. Automatic classification is not a security boundary.

Use `revise --id <latest-id> --text-file corrected.txt` to correct a current-scope
record or update a task from in-progress to completed. Use `revoke --id <latest-id>`
to remove it from future retrieval. Changing an old revision is rejected. Previous
versions remain available to the local owner for audit. Do not put a task status
inside a reusable skill; record it as `kind=task` and update it explicitly.

The tool does not resolve natural-language project names. Ask the user when a
project is unclear. In a no-project session, an explicit read-only comparison is:

```sh
python3 <tool> compare --project <UUID-A> --project <UUID-B> --kind fact
```

This queries only the listed allowed projects and returns source labels. It does
not change the session's write scope. Start a new project task to work/write in a
selected project. Cross-project comparisons from an existing project task are
rejected. No unrestricted `--scope`, `--database` or account override is exposed.

When a project rule conflicts with a public default, explain both sources and
apply the project rule within that project. Current user instructions and checked
code take priority over remembered suggestions. No remembered rule overrides ACLs.

## Local owner management

Open a normal terminal on the machine as the configured owner, outside a Multica
agent run. Do not paste or export a Multica task token into it:

```sh
python3 <tool> inspect --limit 100
python3 <tool> publish --id <candidate-id>
python3 <tool> correct-public --id <latest-public-id> --text-file corrected.txt
python3 <tool> revoke-public --id <latest-public-id>
```

Mutations show the record and require typing the exact action and ID. Publishing
consumes the reviewed candidate and adds a public record referencing it in one
SQLite transaction. Reusing a consumed/stale candidate is rejected. There is no
public-publishing operation available inside a task run. The local OS user is
trusted: a process with that user's file access can bypass these CLI guardrails.
This is not a hostile-process sandbox or server-enforced human approval system.

`inspect` is the combined local management entry point for latest records,
including candidates and revoked entries. It is a CLI, not a new web panel. The
existing Memory Hub panel continues to manage its own data; it does not display
this independent overlay. No admin key is needed or handed to the model.

## Skills, validation and rollback

Public methods exist as one public `kind=skill` record, not copies in every
project. Project methods are scoped records. These are method documents, not
automatically installed executable skills. Keep actual Multica workspace skills
as their existing single source; do not duplicate them into Memory Hub. Do not
publish automatically extracted executable skills without review and validation.

Run the isolated tests (no live service or credentials needed):

```sh
cd deploy/global-images/scoped-memory
python3 -m unittest -v
```

Tests cover identity failure, chat/no-project routing, private data boundaries,
scope changes, public approval, stale revisions, correction/revocation, task
updates, project methods, explicit comparisons and concurrent writes. Synthetic
chat-marker tests are not evidence that a real Multica Chat was created and
recalled. Record live acceptance results separately.

Opt in by including the tool commands in a test task. No global agent instruction
change, model proxy modification or container restart is necessary. Stop all
trial calls before cleanup; archive this dedicated directory to retain test data,
or remove it after deciding the audit records are no longer needed. Existing Hub
volumes, project routing and formal agents require no rollback because they were
not changed. For a database backup, use Python's `sqlite3.Connection.backup()`;
do not copy an active database file while writers run.

Known limits: explicit tool use rather than automatic turn capture; substring
search rather than semantic ranking; no automatic expiry or synchronization with
Multica task status; human approval rather than guaranteed automatic extraction;
latest-record inspection capped at 100; static owner-managed project allowlist;
no multi-machine deployment or strong isolation from the same OS user's processes.
