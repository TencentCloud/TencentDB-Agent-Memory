# DSH Native TencentDB Memory Plugin

This bundle provides the smallest native DSH integration: automatic recall before a step, exactly-once per-turn L0 capture, asynchronous Skill conversation delivery, and three read-only search tools. L1/L2/L3 and Skill extraction remain backend-owned asynchronous MemoryCore work.

Install into a DSH profile with `dsh plugin --profile web add ./MemoryCore/dsh-plugin`, then configure `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_API_KEY`, `TDAI_MEMORY_INSTANCE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`, and `TDAI_MEMORY_USER_ID`. Missing identity disables automatic writes without blocking DSH.
