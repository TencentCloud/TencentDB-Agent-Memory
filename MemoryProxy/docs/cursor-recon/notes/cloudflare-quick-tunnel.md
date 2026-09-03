# Local Probe + Cloudflare Quick Tunnel Runbook

## Current verified setup

- Probe: `127.0.0.1:8096`
- Probe implementation: `tools/cursor_probe.py`
- cloudflared version: `2026.8.2`
- cloudflared SHA-256: `1CD6013845C9E757CC21FD922B17601DBA11DAA00B0945877B839C8921E17A5F`
- Public health check: verified on 2026-08-24
- Public model-list check: verified on 2026-08-24

The Quick Tunnel URL is ephemeral and must be read from the active cloudflared process each time it starts. The URL verified during initial setup was:

```text
https://aspect-cabin-disabled-presents.trycloudflare.com
```

Do not assume this URL will survive a cloudflared restart.

## Cursor configuration candidate

For an OpenAI-compatible Base URL field, test this first:

```text
https://aspect-cabin-disabled-presents.trycloudflare.com/v1
```

If Cursor documents that it appends `/v1` itself, use the tunnel origin without `/v1`. Determine the correct form by checking whether the probe receives `/v1/models`, `/models`, `/v1/chat/completions`, or `/chat/completions`.

The probe accepts both `/v1/models` and `/models`, and any path ending in `/chat/completions` or `/responses`.

Use a non-production placeholder API key for the first connectivity test. The probe always replaces Authorization values with `[REDACTED]` before writing logs.

## Start the local probe

From the repository worktree:

```powershell
python MemoryProxy\docs\cursor-recon\tools\cursor_probe.py
```

Local check:

```powershell
curl.exe http://127.0.0.1:8096/health
```

## Start the Quick Tunnel

From the workspace root:

```powershell
.\.tools\cloudflared.exe tunnel --no-autoupdate --url http://127.0.0.1:8096
```

Copy the generated `https://*.trycloudflare.com` URL. Keep both the probe and cloudflared processes running throughout the Cursor test.

## Capture safety

- Live sanitized records are written to `proxy-inbound/probe.ndjson`.
- `probe.ndjson` is ignored by Git.
- Authorization, cookies, and API keys are not retained.
- Identity-like values are stable-hashed.
- Conversation content is represented only by type, length, and stable hash.
- Query parameter values are stable-hashed.
- After each scenario, extract only the relevant record into a named fixture and manually review it before staging.

## Stop conditions

Stop and inspect before continuing if:

- Cursor Agent mode never reaches the tunnel;
- only `/models` reaches the probe but chat does not;
- Cursor reports an unsupported model before sending a chat request;
- streaming fails after the request reaches the probe;
- the probe log contains any unredacted credential, user identity, private path, repository name, source code, or conversation text;
- Cursor rejects the `trycloudflare.com` hostname.

## Quick Tunnel limitations

- No uptime guarantee.
- URL changes after restart.
- Cursor's remote backend may reject or fail to reach the hostname.
- Streaming/tool-call behavior may differ behind the tunnel.
- A stable public instance remains the fallback for final E2E if Quick Tunnel is unreliable.
