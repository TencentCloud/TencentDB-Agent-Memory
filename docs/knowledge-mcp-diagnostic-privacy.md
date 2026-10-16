# Knowledge MCP diagnostic privacy

The MCP wrapper now uses fixed messages for unknown tools, failed HTTP-client calls and transport connection failures. Its startup diagnostic omits the configured API URL. Both MCP logger instances opt into an optional `stderrOnly` logger destination, reserving stdout for JSON-RPC; other logger callers keep their existing default destination. Unknown-tool responses use fixed text (`Unknown tool`) rather than reflecting a caller-supplied name. The `isError` flag remains true and unknown tools do not call the HTTP API.

Successful structured data and intentional text/isError tool results are unchanged. Transport connection failure still exits with status1. Known-tool HTTP error response text is also unchanged: this proposal removes it from diagnostics but does not independently sanitize the tool-facing exception message. #1675 supplies the separate HTTP-client protection for raw backend/transport details, redirects and malformed responses. The complete fork already contains that protection. Neither this change nor its tests promise that successful memory/tool payloads are private from their intended MCP caller.

## Tests

Seven synthetic cases use the real MCP SDK client/server over `InMemoryTransport` for protocol behavior. HTTP-client results and failures are injected in those cases; they do not contact a backend. Two more cases start the actual TypeScript entry point in disposable Node child processes with only the SDK connection outcome injected. They verify startup URL privacy and a nonzero connection-failure exit without exception text. Two real SDK `StdioClientTransport` cases additionally spawn the actual entry point at debug log level, exercising discovery and an HTTP-call refusal without injecting the transport. These expose two startup JSON parsing errors, plus a third debug-line parsing error on HTTP calls, before the stderr correction. No external backend or inference is contacted.

The cases cover unknown-name diagnostics, fixed unknown-tool results, failed-client diagnostics, successful structured data, intentional text results with both isError values, tool discovery, direct startup and connection failure. Six of the eleven fail on the preceding complete source with five controls passing. On fresh upstream `e9a82935b52741e0c798c75326e90b7144eb4d5f`, seven fail because its startup also prints the configured URL; four controls pass. Both fixed variants pass all eleven in a prepared Linux dependency fixture.

## Scope and compatibility

The five-file proposal changes the MCP wrapper, logger destination support, the HTTP client's logger selection, these tests and this note, with no dependency/schema changes. Changing the logger destination alone does not redact upstream HTTP diagnostics; #1675 remains a separate prerequisite for HTTP payload/URL sanitization. It retains upstream's existing entry-point detection and token configuration. The complete fork's portable entry-point detection, service selector forwarding and token fallback are separate existing integration behavior.

Callers parsing the previous `Unknown tool: <name>` text must migrate to the fixed error result or use `isError`. Other error payloads, lifecycle paths, SDK diagnostic hooks, log retention, installed-host integration and other clients/services remain outside this change. Prepared installed dependencies do not establish a fresh upstream installation or a whole-upstream typecheck. This is contributor verification, not an independent final review.

## Integrated validation

Targeted strict TypeScript checking of the scoped wrapper, HTTP client, logger and test passes against upstream sources with prepared dependencies. The complete fork passes strict checking, build and all 414 Knowledge tests across 30 files, with 131 transferred source/config/launcher files matching by SHA-256. Its existing compiled-CLI end-to-end tests now run with debug logging and a strict JSON-RPC stdout parser, rather than silencing diagnostics; the fixed unknown-tool result assertion is updated accordingly.

An isolated composition on upstream e9a8293 with #1675 at `bcb51af2037abe5eb7072dcdde0917c796814b63` passes 27 cases across three files (11 wrapper/stdio,13 HTTP-security,3 forwarding). The composition explicitly retains the new stderr-only logger option when taking #1675's HTTP client. This is a deliberate one-line composition decision, not evidence of automatic conflict-free merging or a clean fresh dependency installation.
