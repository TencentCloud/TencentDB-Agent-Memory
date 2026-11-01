# Unicode validation for Wiki FILE blocks

Node replaces lone UTF-16 surrogates with U+FFFD when encoding strings as UTF-8.
Consequently, a malformed FILE path can address an existing filename containing
an actual replacement character; malformed file content can silently lose data.

`normalizeWikiPath` rejects malformed paths, and `parseFileBlocks` skips blocks
with malformed content using its existing warnings-and-continue contract.
Valid surrogate pairs (including astral characters), literal U+FFFD and other
well-formed text remain accepted. Existing whitespace normalization is unchanged.

This change applies only to the existing Wiki FILE-block parser. It adds no
OKF bundle import/export API and does not depend on PR #1655 or #1659. It does
not validate all other writers, subsequent merge-model output or binary data,
and makes no new tenant-isolation or filesystem-confinement claim.

## Targeted validation

From `MemoryKnowledge`, with the project's development dependencies installed:

```sh
npm test -- tests/wiki-file-unicode.test.ts --maxWorkers=1
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --types node \
  --target ES2022 --module NodeNext --moduleResolution NodeNext \
  src/engines/wiki/ingest-v2/file-protocol.ts tests/wiki-file-unicode.test.ts
```

The 13 tests passed on Linux with Node 22.23.2 and Vitest 4.1.11 using an existing
dependency fixture, with networking disabled and no model calls. Against the
unchanged upstream parser, the same tests produce seven failures and six passes.
The filesystem regression creates and removes only a temporary synthetic file.
This is targeted parser/type validation, not a full application build, a fresh
lockfile installation or an end-to-end model run. No dependencies are changed.
