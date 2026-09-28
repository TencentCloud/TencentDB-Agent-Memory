# Dify Workflow Diagram

This diagram covers the recommended Dify workflow for TencentDB Agent Memory.
The adapter keeps Dify-specific wiring at the edge and reuses the existing
Gateway and `TdaiCore` pipeline.

```mermaid
flowchart TD
  User["End user"] --> DifyStart["Dify workflow start"]
  DifyStart --> RecallTool["tdai_recall tool"]
  RecallTool --> ClientRecall["TdaiGatewayClient"]
  ClientRecall --> GatewayRecall["Gateway POST /recall"]
  GatewayRecall --> CoreRecall["TdaiCore handleBeforeRecall"]
  CoreRecall --> StoresRead["Memory stores and embedding search"]
  StoresRead --> CoreRecall
  CoreRecall --> GatewayRecall
  GatewayRecall --> RecallTool
  RecallTool --> Prompt["Inject returned context into LLM prompt"]
  Prompt --> LLM["Dify LLM node"]
  LLM --> CaptureTool["tdai_capture tool"]
  CaptureTool --> ClientCapture["TdaiGatewayClient"]
  ClientCapture --> GatewayCapture["Gateway POST /capture"]
  GatewayCapture --> CoreCapture["TdaiCore handleTurnCommitted"]
  CoreCapture --> L0["L0 raw conversation"]
  CoreCapture --> Scheduler["Progressive memory scheduler"]
  Scheduler --> L1L3["L1/L2/L3 memories"]
  LLM --> User
  DifyStart --> EndTool["tdai_session_end at workflow end"]
  EndTool --> GatewayEnd["Gateway POST /session/end"]
```

Recommended identifiers:

| Dify value | TDAI parameter | Reason |
| --- | --- | --- |
| `conversation_id` | `session_key` | Stable across turns in the same Dify conversation. |
| End-user id | `user_id` | Optional metadata; current Gateway/Core behavior still relies primarily on `session_key`. |
| Current user message | `query` for recall | Drives memory retrieval before generation. |
| User plus assistant turn | `capture` body | Records completed conversation turns after generation. |
