# Independent final review scope

Status: **outstanding**. Contributor testing, static inspection, advisory scans
and CI are evidence for review, not an independent final audit. The upstream
contribution remains draft until independent review is completed. No assertion
of absence of vulnerabilities or malicious code is made.

Review the final contribution against upstream commit
`b1f79fc4714b1e20a1ab94ec6b98e50100af6dc4`, preserving upstream history and authorship.
The [draft PR](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1635)
contains the proposed change; [verification evidence](verification-evidence.md)
and [security review](security-review.md) describe reproducible tests and bounds.
Review findings should identify the inspected revision, affected path, concrete
trigger, impact, reproduction, recommended correction and verification result.
A review request or a successful CI run does not meet this completion criterion.

## Required areas

| Area | Evidence and unresolved boundaries to inspect |
| --- | --- |
| Native OKF | Validate import/export, malformed and oversized inputs, paths, unknown metadata, cross-document references and byte-preserving round trips. Trust metadata is advisory; parsing must not execute code or invoke an LLM. |
| Authentication and tenants | Trace keys and tenant selectors through Core, Knowledge, SDKs and Panel into actual storage queries, including error paths, empty identifiers and tenant changes. Scoped service keys do not establish end-user authorization. |
| Remote clients | Check optional clients, HTTPS verification, redirects, DNS/private-address checks, proxy environment, exporter authentication and logs containing credentials or response bodies. Unit stubs do not establish remote backend compatibility. |
| Local storage and workers | Check SQLite rows/savepoints, paths and symlinks, worker locks, timer identity, state loading, oversized embeddings and failed extraction. Trusted filesystem ancestors remain required; race-free confinement and multiwriter recovery are not established. |
| Development dependencies | Reproduce and inspect the unbundled npm artifact, compare retained code/license bytes with the verified official archive, inspect scoped overrides and lock integrity, and run full audit/typecheck/tests/build. Basic CLI smoke checks do not cover every npm command. |
| Native supply chain | Inspect native package provenance, binary/compiler/header trust and install scripts. Successful Linux execution and source-built SQLite tests do not prove all native packages are trustworthy or reproducible. |
| Compatibility | Check actual modern OpenClaw host integration and native llama execution in an explicitly configured environment. Full strict checking uses real public declarations; it does not prove legacy embedded-runner capabilities exist. Inspect the three fail-closed unpublished legacy Wiki validators and public Knowledge schema regeneration. |
| Recovery | Verify application data, deployment configuration, secret-provider recovery and rollback in isolation. Code-only rollback must not overwrite newer data. A backup archive integrity check is not a full application restore. Adapter-backed generation backup and partial extraction recovery remain bounded. |
| Publication | Inspect the complete contributed history for secrets and private deployment data. Confirm only the final contribution is published on preserved upstream history. History changes cannot remove copies already retained elsewhere. |

## Completion criteria

An independent reviewer must provide a revision-specific report stating the
actual scope, methods, findings, severity and remaining limitations. Confirmed
findings require corrections and fresh reproductions/tests. Unreviewed paths and
unsupported integrations must remain explicit. Final disposition requires review
of the corrected revision; it must not infer readiness from earlier tests or from
an absence of findings in a narrower scan.
