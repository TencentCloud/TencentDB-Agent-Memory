# TencentDB Agent Memory for Pi

This is a local Pi extension that gives future Pi conversations durable, scoped memory through TencentDB Agent Memory. It is an independent adapter: it does not import, modify, or upload your existing Claude Code, Codex, or Pi history.

## What it does

- Before a Pi run, searches the configured agent's L0 conversation memory using the new prompt and adds matched text as explicitly **untrusted** context.
- After Pi has settled, stores only the final successful user/assistant exchange in an isolated Pi-session scope.
- Redacts common `sk-*`, Bearer-token, and private-key forms before persistence; secret values are never shown in the status command.
- Fails open: memory configuration or network failures do not prevent Pi from answering.

This first deliverable intentionally covers L0 conversation memory only. It does not yet extract long-term facts, auto-create teams/agents, or migrate historical chats.

## Requirements

- Node.js `>= 22.19.0`
- Pi `0.84.1` was used for development and verification.
- A running TencentDB Agent Memory core and an existing Team, Agent, User, and User Key.

## Local development installation

From this repository, install the extension by absolute path so Pi loads its TypeScript entry point:

```powershell
pi -e E:\path\to\TencentDB-Agent-Memory\adapters\pi
```

For a permanent Pi configuration, use Pi's extension/package installation flow after this package has been published. The package remains `private` during development and is therefore not yet an npm/Gallery release.

## Configure it

Copy [`tdai-memory.example.json`](./tdai-memory.example.json) to one of these locations:

- Global: `~/.pi/agent/tdai-memory.json` (Windows: `%USERPROFILE%\.pi\agent\tdai-memory.json`)
- Per trusted project: `<project>/.pi/tdai-memory.json`

Project values override global values. Environment variables override both. Do not commit either a key file or a config file containing local IDs to source control.

Put the User Key in a separate regular text file, then refer to it by absolute path. A minimal Windows configuration:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "endpoint": "http://127.0.0.1:8420",
  "serviceId": "default",
  "teamId": "team-...",
  "agentId": "agt-...",
  "userId": "usr-...",
  "userKeyFile": "C:\\Users\\you\\.secrets\\tdai-user-key",
  "timeoutMs": 3000,
  "rejectUnauthorized": true
}
```

For a remote endpoint, use HTTPS. You may instead provide `TDAI_MEMORY_USER_KEY`; `TDAI_MEMORY_GATEWAY_API_KEY` is optional and otherwise falls back to the User Key. Other supported overrides are `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_SERVICE_ID`, `TDAI_MEMORY_TEAM_ID`, `TDAI_MEMORY_AGENT_ID`, `TDAI_MEMORY_USER_ID`, `TDAI_MEMORY_TIMEOUT_MS`, and `TDAI_MEMORY_REJECT_UNAUTHORIZED`.

## Verify

Start Pi and run:

```text
/tdai-memory-status
```

It reports configuration, authentication, metadata visibility, and L0 access while masking IDs and never echoing keys. A status of `memory: captured` after a completed response means that exchange was accepted for the configured agent. Start a new prompt on the same agent to let relevant memory be recalled.

## Development checks

```powershell
cd adapters\pi
npm ci
npm run check
npm run pack:check
```

The test suite has no external-memory or model requirement. End-to-end usage should use a dedicated test agent, never a production/shared one.

## Security notes

- Treat a User Key as a password. Do not paste it into issues, chat logs, committed JSON, or screenshots.
- Use a separate Agent for experiments; memory is scoped by Team, Agent, and User.
- `rejectUnauthorized: false` is only for controlled development certificates and should not be used for a remote endpoint.
