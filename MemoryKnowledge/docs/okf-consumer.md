# OKF 0.2 consumer helpers

The reviewed specification is [OKF 0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md). This first building block reads frontmatter and advisory metadata; bundle transport, recovery, graph links, ingestion merges and HTTP/SDK exposure are separate integrations.

`parseFrontmatter` tolerates unknown concept types and metadata. Invalid YAML/mappings fall back to ordinary body consumption. `buildPage` preserves unknown extension values, including nulls and prototype-named keys, and avoids coercing invalid type objects. It remains the existing producer builder: body whitespace is normalized, handled optional null fields and the local `locked` flag retain their prior rules. It is not a byte-preserving bundle exporter.

`sourceEntries` reads structured source objects plus legacy strings. The existing `readSources` continues returning legacy string raw-file keys; this change does not map external provenance URLs to deletion keys. Native-source merge and cascade behavior is outside this block.

`readOkfMetadata(content, now?)` derives status, stale state and advisory verification tiers and returns warnings about selected malformed values. Actor names are unverified producer assertions, not authenticated identities or an independent audit. Verification events remain present even when newer generation metadata makes them older than content. Unknown or malformed optional metadata does not reject the document. Computation/attester/executor fields remain descriptive data; the reader neither invokes their instructions nor contacts source URIs.

Datetime interpretation uses finite JavaScript parsing with an explicit timezone marker, not a complete ISO-8601 conformance validator. Citation warnings use a lexical scan and may include code/example text; CommonMark graph-link integration is separate. This helper does not set a document-size or event-count limit; callers must enforce suitable input budgets. Large verification arrays are reduced without spreading their entries into JavaScript function arguments. Metadata warnings and returned values are available to callers; this block does not redact caller output or all YAML-library diagnostics.

From `MemoryKnowledge`, run `npm test -- tests/okf-consumer.test.ts`. Thirteen synthetic tests cover frontmatter preservation/guards, default/unknown metadata, actor assertions, freshness, provenance ambiguity and retained computation descriptors. These do not establish complete wiki ingestion, native binary trust, application recovery or service authorization.

Use the helpers inside the Knowledge source tree:

```ts
import { readOkfMetadata } from "./engines/wiki/okf.js";

const result = readOkfMetadata(`---
type: Metric
sources:
  - resource: https://example.test/report
    id: evidence
stale_after: 2026-10-13T00:00:00Z
---
A synthetic fact[^evidence].`, Date.parse("2026-10-14T00:00:00Z"));
// result.stale === true; result.trust === "unverified"
```

No new dependency is introduced. Legacy string sources remain readable; adopting object provenance does not change cascade-deletion behavior. This feature requires no automatic data migration and neither rewrites existing pages nor repairs legacy files. Bundle/API integration must define its own migration and recovery contract.

The current upstream Knowledge dependency graph has separately identified advisories; unchanged package metadata here does not remediate them. Upstream's request-cache typecheck error is addressed independently by [PR #1649](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1649). Keep that compiler result distinct from the feature's focused tests and build.
