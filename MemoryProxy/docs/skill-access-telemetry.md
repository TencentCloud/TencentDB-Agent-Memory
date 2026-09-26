# Structured Skill access telemetry

`tool_call_logs` records attempts, not task outcomes. For `bridge_source =
'skill-bridge'` and `executed_endpoint IN ('get', 'get-by-name')`, the proxy
additionally records `skill_id` and `skill_version` from the Core response when:

- HTTP status is 2xx and the JSON envelope has numeric `code: 0`;
- `data.skill_id` is a nonblank string;
- `data.version` is a positive safe integer;
- `data.content` is a string (metadata-only reads are excluded).

An empty content string is allowed: this records the returned content, not its
quality. The version comes from the response, since session pinning may override
the requested version. Search/listing results and file reads are not Skill opens.
Missing or malformed information leaves both fields absent (`''` / `NULL` in
ClickHouse). Absence means insufficient evidence, not proof of a failed load.
`upstream_status` remains the HTTP status, including when a 200 envelope reports
a business error. Network failures retain status 0 in telemetry and return 502.

This is **proxy-observed loaded evidence**: Core returned Skill content to the
bridge. It cannot prove that the client received or read the response, adopted
the instructions, executed them, or succeeded because of them. Retries can
produce multiple rows. Telemetry is buffered and best effort, not a durable audit
ledger; disabled logging, overflow or sink failures can leave gaps.

## Schema and deployment

New tables include `skill_id String DEFAULT ''` and
`skill_version Nullable(UInt64) DEFAULT NULL`. The existing `migrateSchema`
path issues these idempotent upgrades for existing tables:

```sql
ALTER TABLE tool_call_logs ADD COLUMN IF NOT EXISTS skill_id String DEFAULT '';
ALTER TABLE tool_call_logs ADD COLUMN IF NOT EXISTS skill_version Nullable(UInt64) DEFAULT NULL;
```

Existing rows get empty/NULL defaults; old writers can omit the columns. Other
bridge calls and model-intent rows retain existing fields with empty/NULL access
fields. New writers require the columns: apply and verify these ALTERs before
rolling out new writers, especially with multiple pods. The existing startup
migration is best effort and asynchronous; missing ALTER permissions or a startup
race can cause telemetry inserts to fail. Defaults alone do not fix a missing
column. Check migration warnings and `DESCRIBE TABLE tool_call_logs` before rollout.
No ClickHouse engine validation is claimed by the unit tests (they check generated
commands and row shapes).

```sql
SELECT space_id, user_id, team_id, agent_id, agent_source, session_key,
       executed_endpoint, skill_id, skill_version, upstream_status, elapsed_ms
FROM tool_call_logs
WHERE kind = 'bridge_call' AND bridge_source = 'skill-bridge'
  AND executed_endpoint IN ('get', 'get-by-name')
  AND skill_id != '' AND skill_version IS NOT NULL;
```

`elapsed_ms` covers the upstream fetch and body read; it is not Skill execution
time. Bridge callers do not currently supply `turnSeq`, so `turn_seq` remains 0.
Do not derive a real round trace from that default. Cross-pod round correlation
requires a separate design accounting for concurrent requests and retries.

## Privacy and failure isolation

The extractor retains only the resolved ID and version, never Skill content,
manifest, storage paths or authorization headers. These identifiers still have
tenant context and should remain under the existing telemetry access controls.
Existing truncated request-body logging is unchanged; truncation is not
redaction and caller-provided bodies can already contain sensitive text.

Parsing failures degrade to absent access fields. The existing synchronous
telemetry helper swallows sink exceptions; the default ClickHouse writer buffers
and handles asynchronous flushing separately. Neither extraction nor sink
failures change the successful Skill response.
