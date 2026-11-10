# iWiki client redirects and error details

The optional iWiki provider sends its configured bearer token and document RPC arguments to `WIKI_SOURCE_IWIKI_MCP_URL`. The client now rejects redirects, including redirects to another path on the same origin. Configure the final endpoint directly; installations relying on endpoint redirects must update that configuration.

Transport exceptions, JSON-RPC errors, MCP `isError` results and application error envelopes become fixed `IWikiMcpError` messages. This prevents provider-controlled diagnostics from flowing into import failure reports. HTTP authentication failures retain their existing status and message; successful document content remains unchanged. This does not classify or redact successful documents, change credential storage, or establish per-user authorization.

Sixteen Linux cases cover five redirect statuses (301/302/303/307/308), each on the same and a different loopback origin, three upstream error envelopes, an injected transport exception and two successful/authentication controls. The earlier eight-case reproduction observed both same-origin and cross-origin 307 redirects forwarding document RPC bodies. Cross-origin bearer forwarding is not claimed. Real loopback HTTP is used except for the explicit transport-exception fixture; no external provider, inference or production data is involved.

Tests use the prepared Linux dependency environment, with no new dependency or lockfile changes. This focused client change does not cover other provider clients, downstream diagnostic sinks, malformed success envelopes, response-size budgets, endpoint network policy, installed external hosts or independent final review.
