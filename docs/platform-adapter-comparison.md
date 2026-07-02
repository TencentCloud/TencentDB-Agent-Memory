## MCP Transport

Bridge provides an MCP stdio server (ridge/mcp/server.py) as an alternative transport layer, wrapping the TdaiAdapter SDK as MCP tools:

| Dimension | Bridge MCP Server |
|---|---|
| **Language** | Python (server) + TypeScript (client) |
| **Tools** | tdai_health, tdai_recall, tdai_capture, tdai_memory_search, tdai_conversation_search |
| **Gates** | API key (HMAC), rate limit, circuit breaker, audit log |
| **Tests** | 27 (14 protocol + 13 red-team), zero Gateway dependency |
| **agentgateway** | Linux Foundation AAIF for production auth/rate-limit/OPA/OTEL |