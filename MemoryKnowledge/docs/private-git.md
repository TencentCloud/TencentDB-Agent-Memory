# Private Git repositories

CodeGraph supports public HTTPS repositories, HTTPS repositories authenticated with a username and access token, and SSH repositories authenticated with an unencrypted private key and separately confirmed server fingerprints. Supported SSH URL forms include `git@host:owner/repo.git` and `ssh://git@host:2222/owner/repo.git`.

## Configure the service

Set these on the Knowledge service:

```dotenv
KNOWLEDGE_SERVICE_KEY=<service-to-service-key>
KNOWLEDGE_GIT_CREDENTIAL_KEY=<64-hex-characters>
```

Generate the encryption key once using `openssl rand -hex 32`. Retain the same key across restarts, replicas and database restores. Store it separately from the database and source control. Losing or changing it makes previously saved credentials unreadable. Rotating a repository token/key in the UI does not require changing this encryption key.

Panel must use the same service key as `KNOWLEDGE_AUTH_TOKEN`. Credential management stays disabled when the service key is empty, even though legacy public-repository endpoints support unauthenticated local deployments. Missing encryption configuration does not affect existing public repositories.

For `deploy/global-images`, set `KNOWLEDGE_GIT_CREDENTIAL_KEY` in that deployment's `.env`; the launch script forwards it to Memory Hub. The combined and standalone Docker images include the SSH client. Native deployments require Git, OpenSSH and a POSIX shell. For private Git servers using a custom CA, set `GIT_SSL_CAINFO` to the CA file available inside the Knowledge container; TLS verification remains enabled.

## Use the Panel

1. Open **Code_Graph → team assets → Manage Git credentials**.
2. Add a named credential. For HTTPS, supply only the hostname (such as `cnb.cool`, without a protocol, port or repository path), provider username and a token with read access. For SSH, supply only a name and an unencrypted private key: no server URL or manual `known_hosts` is needed. Authorize the corresponding public key on each Git server you want to access.
3. Test the saved credential by entering a repository URL. For a new SSH server, the service retrieves public host keys without authenticating. Compare the displayed SHA256 fingerprints with the Git provider or server administrator, then confirm. Cancellation does not persist trust or authenticate with the private key. The service then runs `git ls-remote`; the test URL is not saved as a credential binding.
4. Register a repository and choose **No authentication** or **Use saved credential**. For the latter, select the saved credential; the list is available before entering the repository URL. Confirm that its indexed code will be shared with the selected team.
5. Bind the resulting CodeGraph to agents as usual. Agents receive the knowledge asset, not the Git credential.

The credential is private to its owner within one service and team, and reusable across repositories and branches. SSH identities work across servers and ports; HTTPS tokens match the repository URL hostname, regardless of repository path or port. Hostnames are normalized for case, internationalized names and a trailing DNS dot. Subdomains do not match their parent domain. Tokens are still used only with HTTPS repositories; HTTP and SSH URLs cannot use an HTTPS token. SCP-style and `ssh://` URLs match the same SSH server; default ports are normalized. Git provider permissions still determine which repositories the token/key can access: a deploy key restricted to one repository does not gain access to other repositories. Other team members cannot list, rotate, replace or delete the owner's Git credentials.

Previously saved credentials retain their IDs, graph bindings and ciphertext. SSH credentials become reusable across servers, and their previously verified host entries still apply only to the original host/port. Legacy encryption inputs are preserved for decryption; no key re-entry or destructive migration is needed.

Rotate a credential by supplying its replacement secret. Manual and scheduled sync resolve the current secret when the worker executes. To change which credential a graph uses, open its details and update the binding; the graph must be idle and you must own it. An in-use credential cannot be deleted until its graphs are unbound or deleted. SSH graphs must retain an SSH credential; deleting their graphs releases the binding.

## SSH server trust

Host trust is stored in SQLite separately from private keys, scoped by service, team, owner, server and port. It survives container restarts and private-key rotation and is reusable with the same owner’s other SSH credentials. A new host requires explicit fingerprint confirmation. Normal clone/fetch uses `StrictHostKeyChecking=yes`: a changed server key blocks access, never silently updates trust. **Test connection** rescans the public host keys and allows the owner to verify and confirm a legitimate server-key change. Confirmations include the previous keys; stale confirmations cannot overwrite newer trust. `ssh-keyscan` discovers keys but does not establish their authenticity, so the displayed fingerprints must be verified independently.

## Storage and execution

- SQLite stores AES-256-GCM ciphertext with per-record nonces and authenticated service/team/owner/scope identity. Only credential metadata and `credential_id` leave the store.
- Git uses a temporary isolated HOME and environment. HTTPS secrets enter only the Git subprocess environment and a generated askpass helper reads them. SSH identity/host files use owner-only permissions outside the checkout, and are removed in `finally`.
- Git URLs never contain usernames/tokens for HTTPS. Git helpers, global config and ssh-agent are not inherited. SSH host checking is mandatory. Authenticated Git operations do not follow redirects; public HTTPS repositories retain Git's initial redirect behavior. Non-HTTPS/non-SSH transports are disabled.
- Git failures return bounded, sanitized messages, not raw stderr. Authentication/network failure preserves the existing checkout and index. A graph is marked failed and can be retried after correcting the credential; the scheduler only automatically selects ready graphs.
- URL and resolved-address checks retain the default private-network restriction. An operator may set `KNOWLEDGE_SSRF_CHECK=off` for trusted internal Git servers. Apply network egress controls as well: DNS preflight checks the initial host only and does not constrain public-repository redirects or DNS rebinding.

## Sharing and deployment boundary

Private **Git access** and **knowledge asset sharing** are separate. This feature retains the project's current team asset model: importing with a credential requires explicit agreement to share the code index with the team. It does not synchronize Git provider membership with Knowledge ACLs.

Panel checks team membership and asset ACLs. The existing Knowledge tool/read endpoints use a trusted-service/network model and some are exempt from service-key authentication. Do not expose the Knowledge port directly to untrusted networks when indexing private source code; deploy it on a trusted network or behind an authenticated gateway for authorized Agent clients. Adding credential management does not turn those existing read endpoints into user-authenticated APIs.

## API additions

All paths below are under `/v3`, require `Authorization: Bearer <KNOWLEDGE_SERVICE_KEY>` and `x-tdai-service-id`. Panel authenticates the user and supplies `user_id`; Knowledge treats that identity as an assertion from the trusted Panel service.

| Endpoint | Request fields | Result |
| --- | --- | --- |
| `POST /source-credential/list` | `team_id`, `user_id` | Owner's metadata only |
| `POST /source-credential/put` | `team_id`, `user_id`, optional `credential_id`, `name`, `secret`, `hostname` (HTTPS only) | Created/rotated metadata |
| `POST /source-credential/test` | `team_id`, `user_id`, `credential_id`, `repo_url` | `{ accessible: true }` |
| `POST /source-credential/host-key` | `team_id`, `user_id`, `credential_id`, `repo_url`, optional `refresh` | Public keys, SHA256 fingerprints and current trust; no authentication or trust mutation |
| `POST /source-credential/trust-host` | `team_id`, `user_id`, `credential_id`, `repo_url`, `known_hosts`, `previous_known_hosts` (null on first use) | Explicitly persist verified host trust |
| `POST /source-credential/delete` | `team_id`, `user_id`, `credential_id` | `{ deleted: true }`, or 409 if in use |
| `POST /code-graph/set-credential` | `code_graph_id`, `user_id`, `credential_id` (or null), `share_with_team` | Updated graph |

`secret` is either `{ "kind": "https", "username": "...", "token": "..." }` or `{ "kind": "ssh", "private_key": "..." }`. HTTPS requires `hostname`; SSH has no server scope and reports a null `hostname`. Server trust is managed through the separate host-key/trust-host endpoints. Updating a credential replaces its secret and cannot change its authentication kind or HTTPS hostname. Existing encrypted records remain readable without rewriting their encryption inputs; this storage compatibility does not add alternative credential API fields.

Use `credential_id` and `share_with_team: true` in `/code-graph/create` to bind a credential. Existing public create requests remain valid. Creating an already registered repository/branch preserves the existing graph and credential; use the owner-only binding endpoint to change it.

Panel exposes the corresponding endpoints under `/api/v1/knowledge`, deriving the instance and caller identity from its authenticated context. Do not pass a Git secret through an Agent prompt or store it in a repository URL.

## Validation

Run `npm test`, `npm run typecheck` and `npm run build` in MemoryKnowledge, `npm test` and `npm run typecheck` in MemoryPanel, and `npm run build` in MemoryPanel/web. The HTTPS integration test starts a loopback-only TLS Git smart-HTTP server with synthetic credentials, exercises real clone/fetch and token rotation, and verifies that Git config and index data are preserved correctly. It requires Git, OpenSSL and permission to listen on localhost. The SSH integration test runs real Git through a transport double to verify wrapper execution, selected identity/host files and cleanup; it does not exercise an external SSH server's authentication handshake.
