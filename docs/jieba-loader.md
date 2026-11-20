# Jieba native loader compatibility

MemoryCore lazily uses `@node-rs/jieba` for Chinese keyword segmentation. The
reviewed official main package and platform binding both report version 2.0.3,
but the generated main loader compares binding metadata against 2.0.1. With
`NAPI_RS_ENFORCE_VERSION_CHECK=1`, this rejects the correctly matched binding
and Core falls back to its existing Unicode tokenizer. The reviewed official
2.0.4 main archive retains the same stale expected version.

## Adapter and installation

The main dependency is pinned to 2.0.3. `MemoryCore/vendor/jieba-loader.cjs` is
an MIT-licensed derivative of that exact generated loader: its 54 version
literals are corrected to 2.0.3 and it runs inside a lazy function using a
`createRequire` scoped to the official package. Core resolves the adapter through
its internal `#jieba-loader` package import, in both source and packaged builds.
The npm package and Docker context include the adapter, original upstream license
and provenance manifest. Normal source installation and image build need no extra
postinstall patch or configuration switch.

The adapter does not edit installed dependencies, use eval, bundle a host's native
binary, disable version enforcement or change dictionary bytes. Native binding,
WASI and operator-provided native-path selection retain the upstream loader's
behavior. An unsupported main version fails before loading a native binding;
Core retains its existing fallback if loading fails. Updating the pinned dependency
requires reviewing and regenerating this adapter, not merely editing the version.

## Verification

Reproduce the committed adapter and license from the official SHA512-pinned
archive without executing upstream scripts:

```sh
cd MemoryCore
python3 scripts/vendor-jieba-loader.py --check
# Offline alternative with the same verified upstream archive:
python3 scripts/vendor-jieba-loader.py --check --archive /path/to/jieba-2.0.3.tgz
npm test -- __tests__/jieba-loader.test.ts
```

The provenance manifest records the official URL, archive integrity and original
and derived loader hashes. The generator rejects unexpected source bytes, metadata,
license bytes and gate counts. `--check` compares output without changing files.
Linux tests use fresh processes to check lazy loading, enforced native segmentation,
wrong native metadata rejection, unsupported main metadata rejection, unchanged
official loader bytes and the actual source tokenizer path.

## Local BM25 SDK integration

The official `@tencentdb-agent-memory/tcvdb-text` 0.1.1 entry point eagerly
imports the official Jieba loader, so using the adapter only in Core's keyword
tokenizer does not protect gateway startup under strict version enforcement.
Core's local BM25 implementation and its sparse-vector type consumers use
`#tcvdb-text`, a small source adapter reproduced from the official SHA512-pinned
SDK archive. Two JavaScript files change: the tokenizer calls the existing lazy
Jieba adapter, and resource paths resolve the unchanged installed SDK's model
data without executing that SDK's entry point. The two altered files omit their
stale original source maps. All other SDK source, type declarations, MIT license
and README bytes are preserved. Model JSON and native binaries are not vendored.

The official SDK is pinned to 0.1.1 for its data, and `murmurhash` is a direct
2.0.1 dependency for the adapter. There are no local tarball runtime dependencies
or root-only overrides needed by a consuming application. Both source and packed
Core installations carry the adapter and notices. This changes Core's imports;
it does not change unrelated programs importing the official SDK directly.
The official SDK and its model resources remain required at runtime. Updating
that SDK requires reviewing/regenerating this adapter and checking the data path
and encoder contract again.

```sh
cd MemoryCore
python3 scripts/vendor-tcvdb-text.py --check
npm test -- __tests__/sdk-jieba-loader.test.ts
```

Real SDK tests cover Chinese and English document/query tuple vectors with
version enforcement enabled, unchanged installed loader bytes, and rejection of
incorrect native metadata in a copied fixture. Installed dependencies and memory
records are untouched. A fresh-cache Linux Node 22 consumer installs this proposal’s complete packed
Core package and exercises its strict SDK route. Installation uses
`--ignore-scripts --legacy-peer-deps`: native installation hooks and peer-host
installation are skipped. The plugin bundle is built before
`npm pack --ignore-scripts`; the unrelated upstream build-scripts/prepack chain
is not verified by this test. Running a complete embedded OpenClaw host is
outside these focused tests.

## Migration and limits

No memory records or index files are rewritten by installing the adapter. Operators
who previously used the enforcement flag while the native loader failed may have
keyword indexes produced by the fallback tokenizer. Native segmentation changes
new writes and queries; assess recall on a backed-up copy before deployment and
plan an explicit index rebuild if needed. There is no dedicated public HTTP endpoint
or automatic migration for this tokenizer transition. The internal SQLite store's
`rebuildFtsIndex()` is a maintenance operation, not a verified atomic recovery tool;
do not invoke it blindly against live data.

A matching version and hash prove artifact identity and this tested compatibility
behavior. They do not establish native binary/source reproducibility, absence of
malicious behavior, general path safety or trust in operator-provided library
paths. Platforms other than the tested Linux native target and full WASI/embedded
host interoperability require their own verification. The adapter retains upstream
native/WASI load-error handling; it does not implement a new native sandbox.

## Contribution scope

This proposal changes native-loader integration, package import mappings and
packaging only. It excludes the full project’s type corrections, dependency
security upgrades, HTTP authentication fixes and OKF features. The generated SDK
files retain its complete relative imports and declarations; only two runtime
files differ from the official archive.

Targeted Linux tests reuse exact installed Jieba 2.0.3, SDK 0.1.1, murmurhash
2.0.1 and Vitest artifacts. This verifies proposed source against those artifacts;
the separate fresh packed-consumer check resolves the proposal’s runtime
dependencies. Neither check clears inherited compiler diagnostics or remediates
inherited dependency advisories. No native
package is compiled or installed on macOS.
