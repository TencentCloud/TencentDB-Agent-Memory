# Knowledge MCP HTTP transport boundaries

The optional Knowledge MCP server forwards tool requests to the configured
Knowledge HTTP API. The client sends the configured bearer token to that endpoint. It refuses redirects (301, 302, 303, 307 and 308)
before contacting the redirect target, including redirects that would otherwise
forward the headers or replay a POST body.

Transport errors, configured URLs, backend application messages and JSON parse
exceptions are excluded from default logs and tool-facing exceptions. Failures
use fixed text with the HTTP status when available. Successful numeric-zero
response data still reaches the caller; non-object or non-zero envelopes fail.
Callers that previously matched backend error message strings must use the new
fixed error text. Token-free operation remains available for existing local
configurations; this change does not introduce server-side authentication or
prove tenant authorization.

Linux verification uses real loopback HTTP servers for five redirect statuses,
backend error text, invalid JSON and malformed envelopes. A separate injected
transport exception checks diagnostic handling. Existing tests preserve token,
successful-response forwarding. Run from MemoryKnowledge:

```sh
npx vitest run tests/mcp-http-security.test.ts tests/client-forwarding.test.ts
npm run typecheck
npm run build
```

This is a bounded client change with no added dependencies. The endpoint and TLS
configuration remain operator responsibilities. Response-size limits, timeouts,
installed external MCP host integration and an independent final security review
are not established by these tests.
