# Git Transport Security and Architecture

The Knowledge service retrieves repositories securely using an isolated, validated Git transport layer.

## Connection Security

- **Literal IP CONNECT Relay**: The system pins proxy connections to a validated, literal IP for the CONNECT relay.
- **TLS Verification**: Strict hostname and certificate verification are enforced.
- **No Redirects**: HTTP/HTTPS redirects are explicitly denied to prevent traversal or domain spoofing.
- **Deadline**: A strict 60s deadline is enforced. Tests have verified HTTPS trickle cutoff around 60s, though this is not a universal native resource bounds guarantee across all scenarios.

## Execution Isolation

The local Git environment is scrubbed to prevent execution of untrusted code or arbitrary binary access:
- Scrubbed environment variables and Git configuration.
- Disabled helpers, hooks, templates, and protocols.
- Submodules are not recursively initialized.

## Synchronization Guarantees

Fetch and sync use an exclusive sibling staging directory for isolation:
- **Fresh Staging**: Fetches use a fresh exclusive sibling directory.
- **Rollback and Backups**: Rollback is attempted on failure, but if rollback fails, a retained backup is kept. It is not a clean rollback on every failure.
- **Commit Reading**: The actual commit is read before swap.
- **Binary Existing Index**: Binary existing index is preserved; failed index sync closes the fresh handle.

The storage layer enforces the following constraints:
- **Trusted Parent & Single Writer**: The design requires a trusted parent directory and a single writer process. There are no multiprocess or crash transaction guarantees.
- **Two-Rename Gap**: A two-rename gap exists during swapping.
- **Backups**: Recoverable backups are kept on swap failure.
- **No SQLite/FS Atomicity**: There is no fsync/crash durability guarantee, and no atomicity between SQLite records and the filesystem is claimed.

## CodeGraph Bridge

The CodeGraph bridge inspects repositories prior to opening, indexing, syncing, or exposing them to LLM tools:
- **Project Scan**: Scans the project before operations.
- **Rejections**: The bridge accepts existing regular `.codegraph` directories. However, an incoming remote `.codegraph` conflict is rejected as a FETCHER rule. Symlinks, special entries, and non-directory roots are strictly rejected. Symlink projects now require regular copies.
- **Limits**: The filesystem preflight respects a depth limit of 100 and 100,000 descendant entries.
- **Checks**: Point-in-time checks require a trusted parent and single writer. The bridge does not eliminate TOCTOU (Time-of-check to time-of-use) vulnerabilities against parallel unprivileged attackers, nor does it guarantee full native resource isolation.
- **Payload Logging**: Bridge payload logging has been removed, but this is not a whole-project log redaction claim.

## Authenticated sources

Provider credential transformations remain in memory. The worker passes a clean
HTTPS URL plus a separate trusted resource credential to the fetcher. Git receives
exactly one generated URL-scoped authorization header via its config environment;
no token enters argv, the origin URL or the checkout's `.git/config`. Redirects
remain disabled. Tests exercise actual authenticated clone and sync, reject wrong
credentials and inspect the resulting origin configuration. Same-user/root processes
can inspect the child environment; this is not process-level secret isolation.

Tool query arguments use a shared action-specific allowlist at both HTTP routes
and the bridge. `projectPath`, resource overrides and unknown SDK controls are
rejected before instance loading. Tests use real Hono authentication and routes
with synthetic persistence/native handles; they do not prove a full native attack.
