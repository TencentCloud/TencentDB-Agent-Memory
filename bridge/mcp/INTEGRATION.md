# MCP Server - Interface Coverage & Integration Verification

## Architecture
TS MCP Client --stdio--> bridge/mcp/server.py --> TdaiAdapter --> Gateway

## Coverage
5 tools: tdai_health, tdai_recall, tdai_capture, tdai_memory_search, tdai_conversation_search
4 gates: API key (HMAC), rate limit (sliding window), circuit breaker (10 fail/60s), audit log

## Tests
- test_protocol.py: 14 tests (JSON-RPC compliance)
- test_redteam.py: 13 tests (injection, stress, boundaries)
Total: 27 tests, zero Gateway dependency in CI