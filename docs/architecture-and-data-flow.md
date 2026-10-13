# Architecture, data flow and trust

An agent sends LLM traffic through MemoryProxy. Configured injectors can retrieve
conversation memory and knowledge and modify the forwarded request. Core captures
and retrieves conversations and extracts layered memory/skills. Knowledge stores
Git code graphs, raw document sources, processed Markdown and derived indexes.
Panel provides management workflows through configured Core and Knowledge bindings.

## Authentication boundaries

Knowledge's `KNOWLEDGE_SERVICE_KEY` protects its prefixed APIs, including tools,
source credentials and administration. Public health/docs are outside the prefix.
Core uses the distinct `TDAI_GATEWAY_API_KEY` or YAML `server.apiKey`. With a key,
its gateway rejects unauthorized API requests; health and CORS preflight are public.
Metadata routes additionally enforce their user/service identity contracts.
Keyless loopback development remains supported. Both services reject accidental
non-loopback keyless listeners unless their explicit insecure-listener flag is set.

Tenant headers are routing data supplied by an authenticated trusted service;
they do not prove an end user's identity. Resource lookup checks service ownership.
Credential management additionally checks the team's resource ownership. A gateway
must prevent users from choosing unauthorized tenant headers. Shared service keys
are not a replacement for user-level authorization or tenant-specific credentials.

## Exports and destinations

The upstream LLM receives configured prompts and conversation context. Generated
wiki ingestion sends source text to the configured LLM. Native OKF exchange does
not call an LLM or execute a computation runner. CodeGraph tools may return source
code to the requesting agent; that agent can subsequently send it to its LLM.

Proxy defaults disable Langfuse, Opik, ClickHouse, Redis, COS storage and trace
archives. Console logging remains enabled. Enabling exporters can send request
content, identifiers, usage or traces to operator-configured destinations; inspect
each exporter's options and retention policy. Core defaults also retain local file logs under `/data/log/`; set `LOG_PATH`
to a protected directory or an empty string to disable those file logs. Core
observability is separately configured; an explicitly configured endpoint can activate tracing. Knowledge
ClickHouse telemetry and Langfuse are optional. These are not a global assertion
that no request content reaches logs: bridges redact their payloads, while other
application paths retain their existing logging behavior.

Optional wiki/task providers contact the configured external systems. Git source
credentials are attached only to a scoped HTTPS request, not URLs or persisted
Git configuration. They remain in the Git child environment and are inspectable
by same-user/root processes. SQLite source credentials use reversible base64;
protect databases and backups. External TLS trust and source endpoints are
operator responsibilities; the tested Git transport enforces certificate and
hostname verification and disallows redirects.

## Public forwarding and native code

The private routing/preparation extension and its Proxy COS factory have been
removed. Proxy forwards to explicit configured endpoints; see the
[migration guide](extension-removal.md) for old configuration and state migration.
Native CodeGraph and other compiled dependencies retain supply-chain limits:
source-level integration tests do not independently audit every shipped binary.

The [Git guide](git-transport.md) describes filesystem constraints and trusted-parent,
single-writer assumptions. The [OKF guide](../MemoryKnowledge/docs/okf/README.md)
describes recovery journals, refused ambiguous states and offline backup requirements.

SDK service/STS/COS transports and Panel service calls reject redirects. The
Panel metadata transport omits request/response payloads and business-error
messages from its own logger; this does not redact every application log path.
See [security review findings](security-review.md) for reproduced behavior and
real HTTP/HTTPS test scope.
