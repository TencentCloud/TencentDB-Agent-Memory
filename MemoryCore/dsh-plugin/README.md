# DSH Native TencentDB Memory Plugin

This bundle provides the smallest native DSH integration: automatic recall before a step, exactly-once per-turn L0 capture, asynchronous Skill conversation delivery, and three read-only search tools. L1/L2/L3 and Skill extraction remain backend-owned asynchronous MemoryCore work.

Recall is agent-scoped by default. Set TDAI_MEMORY_SHARED_RECALL=true to opt into the Gateway's permission-checked team read scope for recall and read-only search; writes remain owned by the configured agent. The Gateway still requires the caller's team/agent/user identity for authorization and removes only the agent filter for that request.

Install into a DSH profile with `dsh plugin --profile web add ./MemoryCore/dsh-plugin`, then configure `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_API_KEY`, `TDAI_MEMORY_INSTANCE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`, and `TDAI_MEMORY_USER_ID`. Missing identity disables automatic writes without blocking DSH.
