# Proxy security and outbound data

The private routing/preparation extension has been removed. No private module is
loaded and no extension control plane is started. See the
[migration guide](../../docs/extension-removal.md) before reusing an old configuration.

## Forwarding and trust

Proxy forwards requests to operator-configured upstream endpoints and can inject
configured memory and knowledge. Tenant headers and authenticated client identities
must be authorized at the gateway. Explicit per-agent upstream settings control
endpoint/key selection; an empty per-agent key preserves the existing client-key
passthrough contract. Tool arguments and responses are not filtered by private hooks.

Proxy state uses local SQLite, filesystem or transient memory storage. The private
STS-backed COS backend is unavailable. Local storage does not provide shared state
for multiple Proxy instances. Protect local state files and backups; choose retention
and deletion policies appropriate for conversations and credentials.

## Optional telemetry

Public defaults disable Langfuse, Opik, ClickHouse, Redis and local trace archives;
console logging remains enabled. Configuration can enable additional data flows:

- [Langfuse](../src/langfuse.ts) and [Opik](../src/opik.ts) can receive conversation
  input/output and metadata. Review content controls before enabling tracing.
- [ClickHouse](../src/clickhouse.ts) can retain operational records and `user_input`,
  which is user content rather than only aggregate metrics.
- [Trace archives](../src/trace-archive.ts) can persist request/response data locally.

These settings are not a global guarantee that request content never reaches logs.
LLM forwarding and configured memory/service integrations have separate data flows.
Review actual destinations, credentials, retention and access permissions before
production use. Native and third-party dependencies still require supply-chain review.
