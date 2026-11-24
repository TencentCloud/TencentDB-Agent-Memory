# Hermes recall failure accounting

The optional Hermes provider recalls atomic memories, persona content and scene
navigation in three parallel Gateway calls. Previously, it recorded success even
when every call failed or no worker completed before its join timeout. A cached
Gateway-available flag also bypassed the circuit breaker for recall and capture.

A recall with no completed successful response now records one failure, rather
than three. Five consecutive failed operations open the existing 60-second
breaker. New recall and capture requests honor that pause even when the cached
availability flag remains true. The existing explicit tool-call guard remains.
After the cooldown, requests may run again.

A successful empty response is valid connectivity evidence and resets the
failure count. Partial success still returns the completed memory context and
resets the count. A lock-protected snapshot fixes the point at which completed
responses and errors are classified; late workers cannot change that recall's
returned context or failure accounting.

## Installation and compatibility

Install the updated `MemoryCore/hermes-plugin/memory/memory_tencentdb` provider
package into your existing Hermes plugin installation and restart its host.
There are no new dependencies, configuration keys, API fields or data migrations.
Failure counters and cooldown state remain process-local and reset on restart.
Successful content and request tenant selectors are unchanged. During an outage,
recall still returns an empty string and capture skips new requests during the
cooldown; skipped captures are not queued for later delivery.

## Verification

From a checkout, with Python 3.11:

```sh
python3 -m unittest discover -s MemoryCore/hermes-plugin/tests -p test_recall_accounting.py -v
```

Six cases exercise repeated complete failure, partial success, successful empty
responses, recall/capture blocking with stale availability, cooldown expiry, and
late worker completion. Three fail on the preceding upstream implementation.
They load the full provider with only the external Hermes base interface replaced
by a minimal stand-in; client methods are synthetic and no Gateway is started.
The Linux run uses an unprivileged user, a read-only root and no external network.
This is not installed-Hermes integration or an independent final security audit.

## Limits

Join timeout behavior is unchanged: each of three threads is joined separately.
This is not a single end-to-end deadline or cancellation mechanism. Already
running requests and background capture threads are not cancelled by opening the
breaker. Other successful operations or successful watchdog recovery may reset
its shared failure count. Counter updates across concurrent operations are not
made atomic by this change. Authentication and diagnostic privacy
policies remain separate concerns; this scoped contribution retains the
upstream client's existing behavior and is not a logging-redaction fix.

## HTTP success versus application success

HTTP200 alone does not acknowledge a v3 operation. The provider now requires a
JSON-object envelope with numeric `code: 0` before using recalled data, reporting
a tool result or acknowledging capture. Numeric `0.0` is also accepted; boolean
`false`, string `"0"`, missing/null codes and nonzero codes are rejected. The
native Gateway emits numeric zero for successful operations.

A rejected recall branch contributes no context; other successful branches remain
usable. When no branch succeeds, recall records one failure. A rejected capture
records a failure instead of silently reporting success. Tool calls return a
static `GatewayResponseError` reply rather than false memories or a misleading
empty-result message. Response-controlled data/messages are not inserted into
that exception. Logical rejection from a reachable Gateway does not request a
process relaunch or clear the failure count through a health probe. Direct SDK
callers still receive the original envelope for deliberate inspection.

Eight additional real loopback HTTP cases exercise six failure scenarios plus
successful capture and numeric-zero compatibility controls. On unchanged upstream
`e9a82935b52741e0c798c75326e90b7144eb4d5f`, the six failure scenarios fail; both
positive controls pass. Together with the six recall accounting cases, all 14
functional tests pass on the standalone proposal. Run them with:

```sh
python3 -m unittest discover -s MemoryCore/hermes-plugin/tests -v
```

The scoped proposal retains upstream client logging/transport. In its malformed
code case, that client still emits a pre-existing `%d` logging-format traceback
for nonnumeric codes. Transport/diagnostic proposal #1648 fixes that separate
client-layer defect. These standalone assertions do not establish clean stderr
or whole-client privacy without that correction. Test error messages are generic;
sentinels in rejected data prove the provider does not use that data as memory.
The complete integration with the reviewed client passes all 38 Hermes cases
without those logging diagnostics. The external Hermes host interface is a
minimal stand-in; no installed-host integration or independent audit is claimed.

No new dependencies, configuration or database migration is required. Custom
Gateways must supply the v3 success envelope; absent/string/boolean status codes
are not treated as acknowledgments. Failed or paused captures are not queued or
retried by this change. Existing per-thread deadlines, in-flight requests, shared
counter concurrency and independent watchdog recovery remain bounded as above.
