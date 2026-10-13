# Migration from the private Proxy extension

The private `@context-proxy/cost-guard` integration has been removed. Proxy no
longer loads its module, starts its control plane, rewrites requests through its
compressor, filters responses through its hooks or installs a placeholder package.
Ordinary agent forwarding, memory/knowledge injection and native OKF remain separate.

## Configuration changes

Delete the entire `costGuard` and `badcaseCollector` YAML sections, including
previously disabled sections. Startup rejects these legacy settings rather than
silently ignoring them. Use `upstream.url`, `upstream.apiKey` and `upstream.agents`
for explicit upstream endpoints and credentials. The requested/resolved model is
forwarded without private cheap-model routing or compression.

Remove `/cost-guard`, `/cost-guard/pre` or `/cost-guard/cheap` from agent endpoint
URLs. Retired marker URLs return 404 before forwarding; they cannot reactivate an
extension. The independent `/analyse` feature follows its own existing opt-in.

## Proxy state storage

The private STS-backed COS factory and Proxy COS backend have been removed.
Remove `storage.cos`; select `storage.backend: sqlite`, `fs` or `memory`.
Legacy COS configuration is rejected even if storage was disabled, so migration
cannot accidentally change persistence behavior during a later activation.
SQLite and filesystem stores are local; memory is transient. This build does not
provide a replacement shared store for multiple Proxy instances.

For a deployment using COS, stop writers and export/migrate the actual state
before changing the backend. Retain the old image, configuration and a consistent
backup for rollback. Do not point multiple independent local stores at the same
logical multi-node service or claim they replace shared COS semantics. Removing
Proxy COS does not delete remote objects or alter Core/SDK object-storage features.

## Verification

Regression tests cover real loopback HTTP forwarding, streaming, model and key
selection, response preservation, retired endpoint rejection and configuration
migration. The public image builder uses the committed dependency lockfile and
no longer generates the extension placeholder. Private extension sources are not
required for build or startup.

## Authenticated Core gateways

When the Core gateway requires a service key, configure Proxy `auth.apiKey`
(or `TDAI_AUTH_API_KEY`) for user-key verification, `tdai.apiKey` for memory
requests, and `skill.serviceToken` for skill requests. These are server-side
service credentials; client user keys remain separate. Keep the gateway key
out of client prompts and logs. All direct SDK clients must also supply the
gateway service key in their existing API-key setting.

## Service redirects and Panel logs

SDK and Panel service requests now reject redirects. Replace redirecting service
URLs with canonical endpoints before upgrading. Panel metadata logs retain
operation/status/timing fields but omit request/response bodies and business-error
messages; consumers must not depend on those payload fields for diagnostics.
API responses and errors returned to callers keep their existing content.

## Retired backend selection and safe initialization

The absent private internal observability integration previously fell back to
console output, exposing attributes/errors without explicit console selection.
Internal selection now throws a clear unsupported-backend error; the process
initializer contains that failure with noop and omits raw error payloads.
Gateway status reports the actual selected backend. Explicit console debugging,
OTLP and default noop remain available through the public factory. The gateway's
legacy internal facade becomes noop in this build; separately configured SDK
exporters remain distinct and are not certified private by this correction.

The unshipped Core COS factory integration is rejected explicitly, without a
dynamic import or credential-provider access. This does not remove the SDK COS
transports or existing storage-adapter interfaces. Use local storage in this
public factory; migrate actual data separately before changing storage settings.

Five Linux factory tests cover rejection, noop containment without attribute
leakage, initializer error privacy and explicit console/default behavior. Four
assertions failed before the correction; COS already rejected missing credentials
beforehand, so its clearer unsupported error is not a newly fixed data-access
vulnerability. Core74 tests/build pass; strict checking still fails with 183
diagnostics, three fewer after removal of unavailable integration imports.
