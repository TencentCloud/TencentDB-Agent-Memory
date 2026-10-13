# Development npm dependency

OpenClaw 2026.10.2 depends on npm. The published npm 12.2.0 package includes
prebundled copies of five libraries affected by known advisories. Ordinary npm
overrides cannot reliably replace these bundled files. This repository supplies
an **unbundled npm 12.2.0 archive for development only** so that the dependency
resolver can install the patched libraries from the committed lockfile.

The archive retains the official CLI JavaScript, documentation and licenses
byte-for-byte. Its only retained file modification is `package.json`:
`bundleDependencies` is false, `bundledDependencies` is absent, and upstream
lifecycle scripts are removed. Bundled `node_modules` and embedded lockfiles
are excluded. This is a locally repackaged artifact, not an official npm release.
The upstream npm CLI is licensed under the Artistic License 2.0; the official
license and third-party notices remain inside the archive.

## Reproduce and inspect

On Linux, from `MemoryCore`, with Python 3 and HTTPS registry access:

```sh
python3 scripts/vendor-npm.py
sha256sum vendor/npm-12.2.0-unbundled.tgz
tar -tzf vendor/npm-12.2.0-unbundled.tgz
npm ci --ignore-scripts
npm audit
npm run typecheck
npm test
npm run build
```

The script downloads only the fixed official registry URL and verifies the
original SHA-512 integrity before processing it. It executes no upstream scripts.
It normalizes archive metadata and writes a deterministic gzip archive. The
committed derived SHA-256 is
`a81394ffeaf360a2b61593be10352bf5cfb3153c4d23e81efd85ce8d970e9fbf`.
Original registry integrity:
`sha512-ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ==`.
CI reproduces and compares the archive, then audits the actual installed graph.

The overrides are scoped to npm's dependency tree:

| Library | Patched pinned version |
| --- | --- |
| brace-expansion | 5.0.12 |
| http-cache-semantics | 4.3.0 |
| ip-address | 10.7.4 |
| postcss-selector-parser | 7.1.6 |
| undici (6.x consumers only) | 6.29.0 |

Runtime dependencies, including Core's separate undici version, are unchanged.
Use Node 24.16 or later in the 24.x line for the current OpenClaw development SDK.
The standalone production image excludes development and optional peer packages,
and the vendor artifact is excluded from its context. No npm CLI is installed
in the production runtime. Host-managed OpenClaw installations are separate;
this change does not patch another installation or its package manager.

## Maintenance and limitations

When an official npm release provides fixed bundled dependencies, evaluate it
with a fresh install, audit, CLI smoke checks, typechecking, generator comparison,
tests and build before removing this workaround. To update this artifact, change
the explicitly pinned upstream version and verified registry integrity, regenerate
it and review both metadata and lockfile changes. Do not bypass an integrity
failure or enable lifecycle scripts as a shortcut.

Registry integrity detects substitution relative to the pinned bytes; it is not
an independent audit of upstream code. Audit results reflect the advisory database
at the time of the scan, not proof that all dependencies are safe. CLI smoke
checks exercise basic offline installation and HTTPS registry reads,
not every npm command or every OpenClaw runtime integration.
