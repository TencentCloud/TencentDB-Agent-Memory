# Reproducibility and binding report

Status: **PASS_BYTE_IDENTICAL / zero-provider**.

Every artifact is emitted deterministically (`node ... evo-fresh-final-recovery-closure.ts --check` replays byte-identically). The request content hash is computed from the on-disk request body, and every other 64-hex field is the content hash of an artifact that was really written into this closure.

Bound surface: 44 transitively reached source/config files, 10 promoted nested feature-scoring byte paths, 15 byte-identical frozen post-T1 artifacts, and 13 generated closure artifacts. No provider/model call, secret read, paid dispatch or Docker launch occurred.
