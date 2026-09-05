# MemoryProxy Session Bridge for OpenClaw

This provider-only plugin maps each native OpenClaw session to the existing
MemoryProxy OpenClaw route:

```text
options.sessionId -> x-conversation-id: openclaw-<sha256(UTF-8 sessionId)>
```

The existing `/openclaw/{spaceId}/v1` provider base URL identifies the client
source to MemoryProxy. The proxy's client integration enables Web Session Init;
the shared Web Init service binds the conversation to Team / Agent / optional
Task without interpreting OpenClaw session IDs or client behavior.

It preserves other request headers. If OpenClaw does not supply a non-empty
`sessionId`, the request is forwarded unchanged and a warning is logged; the
plugin never generates a fallback identity.

The plugin contains no recall, capture, memory tools, prompt injection, or
MemoryProxy Web Session Init state.

The manifest's `providers: ["memory-proxy"]` must match the registered ID so
OpenClaw can select the runtime plugin for that provider. Startup activation
alone does not enable the request wrapper.

## Build and install

Supported minimum and verified OpenClaw version: **2026.8.2**. Earlier versions
are not claimed compatible with the provider wrapper contract. Use a Node.js
version supported by OpenClaw (verified with Node.js 22.23.2).

```bash
cd MemoryCore/openclaw-proxy-plugin
npm install
npm test
npm pack
openclaw plugins install ./tencentdb-agent-memory-openclaw-proxy-session-bridge-0.1.0.tgz --accept-capabilities
openclaw plugins enable memory-proxy-session-bridge --accept-capabilities
openclaw gateway restart
```

Use the existing `memory-proxy` provider configuration. Remove its static
`x-conversation-id`; static Team, Agent, and optional Task headers remain
compatible. Session Bridge + Web Init is recommended and requires no static
asset preselection.

Local archives also require source trust confirmation. In a non-interactive
terminal, after reviewing your own build, add `--force` to the plugin install
command to confirm the source (this also permits replacing an existing plugin).

See the [OpenClaw setup guide](../../agents/openclaw/README.md) for a complete
provider example, Web Init workflow, compatibility matrix and repeatable checks.
This bridge is not the [direct memory plugin](../openclaw-plugin/README.md):
do not enable both memory integrations for the same conversation.

Web Init challenges are process-local, expire after ten minutes and are consumed
once. Retry the original prompt after connecting; automatic replay and the full
`mem:session-reset` lifecycle are not implemented.

Configure the proactive Memory / Skill tool URL on the Proxy deployment side:
`PROXY_EXTERNAL_GATEWAY_URL` sets `injection.externalGatewayUrl` and must be
reachable from the Agent's actual tool environment. The plugin does not infer,
configure, or probe network topology; see the [deployment guide](../../deploy/global-images/README.md#agent-主动工具地址).
