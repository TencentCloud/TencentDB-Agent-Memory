# Changelog

All notable changes to the Plandex adapter are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this adapter adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-17

### Added

- Plandex custom-provider config (`tencentdb-agent-memory`) that routes every
  model role through MemoryProxy's OpenAI-compatible endpoint
  `/proxy/<spaceId>/v1/chat/completions`.
- Model `tencentdb/tdai-memory-agent` and model pack `tdai-memory-pack`
  covering planner / coder / architect / summarizer / builder / names /
  commitMessages.
- Zero-dependency CLI `tdai-plandex.mjs` with `generate` and `check --probe`.
- Dependency-free test suite written tests-first (Node's built-in runner),
  including a local mock-gateway integration test and a bilingual-docs guard.
- Bilingual setup guides (`README.md` / `README_CN.md`).

### Fixed

- Corrected the relative deploy link depth in both guides (`../../` instead of
  `../../../`), which previously 404'd on GitHub.
- Hardened base-URL handling: embedded credentials are rejected, trailing
  slashes are normalized before building the chat route, and builders fall
  back to documented defaults instead of emitting missing fields.
- `generate --output` now creates missing parent directories.
