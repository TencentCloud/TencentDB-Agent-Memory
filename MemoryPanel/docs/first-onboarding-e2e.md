# First onboarding: Panel to first L0 memory

This is a repeatable manual UI flow with a local, deterministic client smoke check. Use a **new, disposable instance with empty data**. The test creates a Team, user, Agent, Task and two L0 messages. Destroy only that isolated instance when finished.

## Prepare the isolated stack

1. Start Core and Control/Panel against empty instance data using the normal installation instructions. Initialize a bootstrap `system_admin` and keep its User Key in a private, ignored file. Record the instance ID. Core, Control, Panel and Proxy must all address the same instance.
2. Start a local fake OpenAI-compatible model. It binds only to loopback and does not log prompts or credentials:

   ```bash
   python3 MemoryPanel/scripts/qa/onboarding-fake-model.py --port 18080
   ```

3. Point a test Proxy at `http://127.0.0.1:18080/v1` (or the equivalent reachable loopback address when Proxy runs in a container). Enable `auth`, `sessionInit.headerAutoSelect`, `extraction` with `tdai-memory`, and `tdai.memory.writeL0`. Point its `auth.url`, `skill.endpoint` and `tdai.endpoint` at the isolated Core. For a single local Proxy process, `redis.enabled: false` and `storage.enabled: true` with `backend: memory` avoid an unrelated Redis requirement. Set `injection.enabled: false` if the test only needs L0. Keep all test ports on loopback.
4. Open the Panel. Do not enter production keys, model-provider credentials or real conversation data in this test instance.

## Create the first usable path in Panel

1. Log in as the bootstrap administrator. In the top-left Team switcher, create a new Team. The bootstrap process may already have created `default-team`; use a separate Team so this run has an identifiable scope.
2. Open **成员管理 → 添加成员 → 新建用户并加入团队**. Create a `normal` business user with the default `member` role. Copy the one-time User Key into a private file such as `MemoryPanel/.env.onboarding-key` and set mode `0600`. The file is ignored by `MemoryPanel/.gitignore`. Do not put the Key in a command line, report or screenshot.
3. Log out, then log in with that business user's Key. Confirm the Team appears. Open **Agents 管理 → 新建 Agent** and create an Agent owned by this user. Record its `agent_id` from the Agent card.
4. Open **任务看板 → 新建 Task** and create a normal Task. Record its `task_id` from the detail drawer. Record the `team_id` from the Team switcher. No API call is used to create these Panel objects.
5. Send one non-streaming OpenCode-format client turn through Proxy and verify Panel readback using the script below. It uses the selected Team/Agent/Task headers, checks the fake-model reply, and polls Panel's Chat Memory API for the user and assistant L0 turns. It reads the Key from a private file and never prints it.

   ```bash
   python3 MemoryPanel/scripts/qa/onboarding-client-smoke.py \
     --panel-url http://127.0.0.1:8125 \
     --proxy-url http://127.0.0.1:8096 \
     --instance-id <instance-id> \
     --team-id <team-id> \
     --agent-id <agent-id> \
     --task-id <task-id> \
     --key-file MemoryPanel/.env.onboarding-key
   ```

6. In Panel, open **Chat_Memory → Agent 资产**, select the new Agent and its memory block, then expand **L0 · 对话原文**. Confirm the new test user turn and the assistant turn `Onboarding fake model response: <same user turn>` are visible. Log out and log back in as the business user; confirm the same two L0 turns remain visible.

## Record the result

| Check | Expected evidence |
| --- | --- |
| Clean instance and bootstrap | Isolated data directory and instance ID recorded; no pre-existing business objects |
| Panel control path | Team, normal user membership, business-owned Agent and Task shown after refresh |
| Client path | Script reports `Proxy response: passed` and `Panel L0 readback: passed` |
| Persistence | After logout and login, Panel still shows the memory block and both L0 turns |
| 0 Task | Track separately against #1429 until its behavior is in the target branch; do not mark this case passed from the normal-Task run |

Record the Core/Control/Proxy/Panel revisions, commands and exit codes, sanitized request IDs on failure, and the exact checks marked Passed, Failed or Not Run. The script verifies the client and Panel API; it does not automate the browser steps. A real-model smoke is a separate test with its own data-transmission authorization.
