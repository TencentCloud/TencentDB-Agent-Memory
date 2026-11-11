# Configured Knowledge service-key authentication

When `KNOWLEDGE_SERVICE_KEY` is nonempty, all requests passing through the Knowledge service API auth middleware now require `Authorization: Bearer <key>`, including read/query/tool and provider/status endpoints. Previously upstream deliberately exempted a read-only allowlist even with a key configured. This proposal changes that policy so configuring a service key protects memory reads as well as writes. Invalid or missing keys receive the same fixed 401 envelope.

Rejected-request diagnostics are fixed text. Paths, headers, request bodies and scope identifiers are not included in this middleware's log message. The preceding complete fork already required keys for reads/tools, but still logged private rejection paths; this follow-up removes those paths.

## Client migration and compatibility

Clients using previously exempt reads or tools must send the configured service key. MCP uses `KNOWLEDGE_API_TOKEN`; Panel uses its configured Knowledge auth token. Authentication forwarding and transport/privacy hardening are separate client concerns, including #1675. Caller-provided `x-tdai-service-id`, team and user selectors are scope inputs, never substitutes for the Bearer credential.

An empty service key intentionally retains upstream's no-auth compatibility mode. This middleware change does not establish secure non-loopback listener policy; deployments must configure a nonempty key and appropriate transport/isolation. Separately mounted `/health`, `/docs` and `/openapi.json` remain public. The internal `isReadonlyPath` export and allowlist are removed; direct importers of that helper must migrate rather than treating read-only status as authorization. Other middleware function/configuration signatures are retained.

A shared service key remains an administrative service credential. It does not cryptographically bind an end user to a particular service/team selector or replace tenant authorization checks.

## Verification and limits

31 in-process Hono cases exercise the actual middleware with mounted API routes. They cover the formerly exempt reads/tools/status/provider routes, write controls, a custom prefix, incorrect credentials, untrusted scope selectors, an unread private request stream, authorized read/write compatibility, empty-key mode, public routes and rejection-log privacy.

On fresh upstream `e9a82935b52741e0c798c75326e90b7144eb4d5f`, 23 cases fail the proposed policy/privacy contract and eight compatibility controls pass. On the preceding complete fork, only the two private-path log cases fail; 29 controls pass. All 31 pass with the fixed middleware on both branches in a prepared Linux dependency fixture. These are deliberate policy regressions against upstream's existing allowlist, not a claim that upstream intended to protect those exempt routes. Targeted strict TypeScript checking of the scoped middleware and test passes against fresh upstream sources with prepared dependencies. The complete fork passes strict checking, build and all 403 Knowledge tests across 29 files; 130 transferred source/config/launcher files match by SHA-256. The scoped and complete middleware emit identical JavaScript after comments are removed; listener-policy comments differ to describe their respective server scope accurately.

This proposal changes the auth middleware, its server comment, the tests and this note. It adds no dependency or database migration. The prepared dependencies come from the complete project's installed graph; these tests do not establish a clean fresh-upstream install or whole-upstream typecheck.

The middleware refuses before downstream handlers read bodies. This is not a claim about earlier middleware: upstream's access logger runs before API auth and may still consume/log rejected bodies. #1677 addresses that logger separately. The complete fork separately mounts authentication ahead of logging, telemetry and body-size checks. Error responses/other logger privacy (#1681), listener posture and whole-server ordering remain separate contributions. These tests are not an installed-client integration or independent final review.
