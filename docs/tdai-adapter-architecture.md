## MCP Transport Layer

Bridge delivers an MCP stdio server (ridge/mcp/server.py) that wraps TdaiAdapter methods as 5 MCP tools with 4 defense gates (API key HMAC, rate limit, circuit breaker, audit log). A TypeScript MCP client (ridge/mcp/tdai-memory-client.ts) provides the same interface via MCP stdio protocol.

For production deployments, agentgateway (Linux Foundation AAIF) provides session-persistent auth, rate limiting, OPA policy, and OpenTelemetry observability. See ridge/mcp/INTEGRATION.md for full details.