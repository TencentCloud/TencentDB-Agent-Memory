# Changelog

## Unreleased

- Send the deterministic turn key as `idempotency_key` for retry-safe L0 capture; forward the same key on Skill requests for Gateways that expose the corresponding contract.
- Ship compiled ESM and declaration files so OpenCode Desktop's Node runtime never needs to strip TypeScript under `node_modules`.
- Add a safe one-command installer, private JSON configuration, diagnostics, uninstall, and bilingual installation guides.
- Cap L0 messages at the Gateway's 8192-character limit, including replay of legacy outbox records.
- Disable Skill recall and capture by default so Gateways without the optional Skill module do not accumulate pending deliveries.
- Add cross-process delivery claims with crashed-owner recovery, locked dependencies, Windows CI, and a real local-Gateway contract test.
- Reject misspelled booleans, oversized task IDs, and remote endpoint changes that would reuse credentials from another origin.
- Preserve all final assistant text around tool calls and harden native-tool result boundaries against wrapper injection.
- Add bilingual, 30-second user guides centered on one-command install, restart, and verification.
- Separate pre-publication local-tarball commands from post-publication `npx` commands so reviewers do not encounter an unexplained npm `E404`.
- Document the zero-key L0 boundary and exact server-side LLM, optional Embedding, and Skill enablement steps in both languages.

## 0.1.0

- Add automatic Atomic/Core/Skill recall through OpenCode hooks.
- Add L0 conversation and tool-aware Skill capture.
- Add persistent per-pipeline delivery state, restart recovery, and whole-transcript catch-up.
- Add five native memory tools and untrusted-data boundaries.
- Add configuration validation, credential redaction, request timeouts, tests, and bilingual documentation.
