# Knowledge HTTP access-log boundaries

Access logs now contain the HTTP method, registered Hono route template, status
and timing only. A matched route logs parameter names rather than caller values;
unmatched requests never fall back to the caller's raw URL path. The existing
request-id context remains available to handlers.

The middleware no longer parses request bodies or reads and reconstructs error
responses for logging. Consequently, arbitrary identifier/path fields and
backend response text do not enter these access logs, unused request bodies and
streaming errors remain unconsumed, and non-UTF8 error bytes are preserved. API
status, headers, payloads and route-level body parsing/limits are unchanged.
Log consumers that used identifier fields, response text or concrete path values
must adapt to the reduced access-log fields.

Seven Linux in-process Hono tests cover payload/path privacy, unused request and
response streams, binary response bytes, request-id tracking and successful JSON
handling. Six fail before the correction; all seven pass afterward using a
prepared dependency fixture. From MemoryKnowledge:

```sh
npx vitest run tests/access-log-privacy.test.ts
```

No dependencies are added. This change is limited to this access middleware;
it does not sanitize route-specific logs, provider diagnostics, external proxies
or log stores already holding old entries. It does not establish server tenant
authorization, installed-host integration, or an independent final audit.
