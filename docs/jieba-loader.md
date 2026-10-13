# Jieba native loader compatibility

MemoryCore lazily uses `@node-rs/jieba` for Chinese keyword segmentation. The
locked official main package and platform binding both report version 2.0.3,
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
