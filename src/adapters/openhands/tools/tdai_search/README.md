# TDAI Search Tool for OpenHands

This optional tool exposes TencentDB Agent Memory search to OpenHands through an
MCP server.

It is intentionally separate from the core OpenHands adapter. The first adapter
phase can use recall/capture only; this tool is for active in-run memory search.

## Tools

- `tdai_memory_search(query, limit)`: search durable memories.
- `tdai_conversation_search(query, limit, session_key)`: search captured raw
  conversation records.

## Environment

- `TDAI_GATEWAY_URL`, default `http://127.0.0.1:8420`
- `TDAI_GATEWAY_API_KEY_ENV`, default `TDAI_GATEWAY_API_KEY`
- `TDAI_GATEWAY_TIMEOUT`, default `8`
- `TDAI_MEMORY_SEARCH_LIMIT`, default `5`
- `TDAI_CONVERSATION_SEARCH_LIMIT`, default `5`
- `TDAI_SESSION_KEY`, optional

For Docker-based SWE-bench runs, set `TDAI_GATEWAY_URL` to an address reachable
from the OpenHands sandbox/container.
