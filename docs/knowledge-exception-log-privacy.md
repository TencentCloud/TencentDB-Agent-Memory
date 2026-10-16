# Knowledge exception-log privacy

The complete project's global Knowledge error handler previously interpolated `c.req.path` into its diagnostic for an unhandled exception. Caller path values can contain private identifiers. Its response was already generic, but the error log still retained the path.

Fresh upstream `e9a82935b52741e0c798c75326e90b7144eb4d5f` instead interpolates the exception message into both the error log and the HTTP 500 response. Exception messages may contain backend details or caller input. The small upstream proposal removes that message disclosure and adds the complete project's existing fixed malformed-JSON response.

The handler now emits a fixed diagnostic. It does not inspect the request body, headers, raw path, exception message or stack for logging. The existing generic HTTP 500 envelope and malformed-JSON HTTP 400 handling remain unchanged. This change is independent of the access-log middleware.

## Validation

Five in-process Hono tests use synthetic values only: a matched path parameter, an unmatched path with failing global middleware, a mounted router, malformed request JSON, and a non-JSON SyntaxError. On the preceding complete source, the three path cases fail the no-private-marker assertion; the two compatibility controls pass. On fresh upstream, all five tests fail: the generic-error and malformed-JSON response contracts also differ. All five pass with the fix in a prepared Linux fixture using Hono and Vitest from the complete project's installed dependencies.

The small upstream proposal contains the handler change, these tests and this note. It does not change dependency manifests. Prepared-fixture tests do not establish reproducibility of a fresh upstream dependency installation.

## Scope

This addresses only the global error handler's diagnostic. It does not sanitize other route, engine, provider, proxy or subprocess logs; purge historical logs; change authorization; or establish an independent final security review. Synthetic throwing routes reproduce the logging behavior, rather than demonstrating an exploit of a particular production endpoint.
