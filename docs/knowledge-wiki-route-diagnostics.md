# Wiki route manager-failure diagnostics

Four best-effort manager operations in Wiki routes now emit fixed warning text: engine cleanup after deletion, and index synchronization after raw removal, page writing or page removal. These warnings identify the operation without including a caller-supplied Wiki ID, an exception object, its message or stack.

The underlying operation, success response, API payloads and best-effort failure behavior are preserved. Deletion still reports the deleted ID to its authorized caller; successful manager calls remain quiet. This change adds no dependencies or schema changes.

Eight in-process Hono cases use synthetic service/manager outcomes: four injected manager exceptions exercise diagnostic privacy and response preservation; four successful controls exercise quiet behavior and operation results. Both preceding complete source and freshly verified upstream reproduce four privacy failures with four controls passing. The fixed scoped cases pass in prepared Linux dependencies. No real provider, inference or production volume is used.

This is limited to these four warnings. Service validation error responses, other manager/service/provider/proxy logs, historical log retention, filesystem concurrency and independent final review remain separate. Existing logs are not rewritten.
