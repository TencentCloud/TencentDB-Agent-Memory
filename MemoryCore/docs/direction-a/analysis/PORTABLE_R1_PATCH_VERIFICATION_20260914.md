# Direction A — Portable R1 Path Patch Verification

**Date:** 2026-09-14  
**Outcome:** `PORTABLE_R1_PATCH_READY`  
**Mode:** zero-provider / minimal allowlist amendment / path-only patch / targeted verification

## 1. Allowlist amendment

Exactly five previously confirmed deterministic-analysis provenance/integrity inputs were added to both final allowlists. No sixth allowlist item was added.

| Input | SHA-256 verification | Destination | Classification | GitHub | ZIP |
| --- | --- | --- | --- | --- | --- |
| `11_SUPERSEDED_FRESH_AUTHORIZATIONS.json` | PASS — `87b718e5116a9ca32b8d80841ea67ce7a3986b6430028d5e8abbd3344ae8b9b2` | `evidence/evo/fresh-authority/11_SUPERSEDED_FRESH_AUTHORIZATIONS.json` | `E1_MINIMAL_REPRO_EVIDENCE` | EXCLUDE | INCLUDE |
| `WORKBUDDY_EVO_FRESH_FINAL_RECOVERY.md` | PASS — `74e31458a90185b02b31288eebd982956c19948dd99a005dd8580c5be59b279a` | `evidence/evo/fresh-authority/WORKBUDDY_EVO_FRESH_FINAL_RECOVERY.md` | `E1_MINIMAL_REPRO_EVIDENCE` | EXCLUDE | INCLUDE |
| `Direction_A_FINAL_FREEZE_CANDIDATE_MAP_20260914.md` | PASS — `6cce4f73a679bd0a08d48a21ef2efb0d2494e4ee9f3fb507e41746daf10608b8` | `evidence/authority/Direction_A_FINAL_FREEZE_CANDIDATE_MAP_20260914.md` | `E1_MINIMAL_REPRO_EVIDENCE` | EXCLUDE | INCLUDE |
| `Direction_A_Conversation2_Final_Analysis_and_Report_GOAL_20260914.md` | PASS — `5c80fd3cff7069e36995ff17d64518ebd880a5067dcd4eae0647afc900250036` | `evidence/authority/Direction_A_Conversation2_Final_Analysis_and_Report_GOAL_20260914.md` | `E1_MINIMAL_REPRO_EVIDENCE` | EXCLUDE | INCLUDE |
| `Direction_A_Codex_Whole_Project_Final_Report_Revision_GOAL_20260914.md` | PASS — `9fe66734dc1e7c23a994bbe41a2238d53800e721784ab9185d51acdb77b56efc` | `evidence/authority/Direction_A_Codex_Whole_Project_Final_Report_Revision_GOAL_20260914.md` | `E1_MINIMAL_REPRO_EVIDENCE` | EXCLUDE | INCLUDE |

Post-amendment invariants:

- `mainEvidenceFiles`: **297** (was 292).
- `sourceFiles`: **95**, unchanged.
- `testFiles`: **10**, unchanged.
- Source-array canonical serialization SHA-256: `040800a33e662f50fe8dbe2eb384ed00572f3085a1b8c94a93af5b317d75d12a`, unchanged.
- Test-array canonical serialization SHA-256: `cff629d8d25743a255c5f1ebb933e15441f44eb5c6c28c0e0512ad0f30e18399`, unchanged.
- Existing held-out analysis SHA-256 before/after amendment: `617b0fc271f88ff0a697579cb11b0c476de46a0811acd3b829c3b71e200f0026`.
- Existing method metrics SHA-256 before/after amendment: `483a616636480a945c2a0f659145a889a04cfa8722d84650299c268e7edfe8fe`.
- Final report SHA-256 before/after amendment: `1eeddb9fe51d82189912509dfccd42e3799566f562926a3d8e47431d07344d4a`.

The five additions are provenance/integrity inputs only. They are not active method source and do not change any result.

## 2. Portable path patch

The original script was preserved. A new portable script was created:

`analysis/scripts/rebuild_direction_a_final_analysis_PORTABLE.mjs`

| Script | SHA-256 |
| --- | --- |
| Original `rebuild_direction_a_final_analysis.mjs` | `fb73eafd54c04320aa633107122cd7b96637c1e0ca4a471686593864417f7fba` |
| Portable `rebuild_direction_a_final_analysis_PORTABLE.mjs` | `8bf9157c3c9c925b36da4a45aef990293ee78d32d14fac9a9f602b47133433df` |

The patch changes only path behavior:

- package-root discovery priority is `--package-root`, then `DIRECTION_A_PACKAGE_ROOT`, then two levels above `import.meta.url`;
- original scientific inputs are mapped to their allowlist `destinationRelativePath`;
- all 81 request bindings are resolved to direct or byte-identical allowlisted destinations and still SHA-256 checked;
- recorded absolute Harbor task paths are checked by their invariant package-independent `/prepared/tasks/<task-name>` suffix;
- every application-level file read/hash is guarded against leaving the resolved package root;
- missing-input errors name exact package-relative paths.

No hardcoded original Desktop/project path remains in the portable source.

## 3. Scientific equivalence

Commands executed:

```powershell
node C:\Users\L2503\Desktop\Direction_A_Final_Submission\analysis\scripts\rebuild_direction_a_final_analysis.mjs
node analysis\scripts\rebuild_direction_a_final_analysis_PORTABLE.mjs
```

The following complete projection was deeply equal between original and portable results:

- `scientificStatus`
- `treatmentFidelityVerdict`
- `treatmentFidelity`
- `sample`
- `estimator`
- `tasks`
- `primaryCoverage`
- `coverageSensitivity`
- path-independent `inference` status/consequence
- `costs`
- `claimLadder`
- `interpretation`
- `crossChecks`

Additional checks:

| Check | Result |
| --- | --- |
| Scientific projection equality | PASS |
| `theta` in prefix order | `0, 0, 0, 0, 0.056501547988` |
| Proposed primary `V` | `0.011300309598` |
| Proposed primary `G` | `0.002260061920` |
| Proposed − matched-capacity `DeltaV / DeltaG` | `0 / 0` |
| Proposed − target-only `DeltaV / DeltaG` | `0 / 0` |
| `FINAL_METHOD_METRICS.csv` byte equality | PASS |
| Pair-table scientific columns equality | PASS |
| Request bindings matched | `81 / 81` |
| Treatment fidelity | `PASS_WITH_LIMITATION` |
| Scientific status | `PARTIALLY_SUPPORTED` |

The full portable `FINAL_HELDOUT_ANALYSIS.json` hash differs from the original because its recorded evidence/search paths are package-local, as required. The compared scientific projection is exactly equal.

## 4. Clean-directory R1 smoke

Clean root:

`%TEMP%\Direction_A_Portable_Analysis_R1_Test_20260914`

Invocation was performed from that root using exactly:

```powershell
node analysis\scripts\rebuild_direction_a_final_analysis_PORTABLE.mjs
```

Staging and isolation facts:

- 297 exact `mainEvidenceFiles` destinations were copied and verified.
- All 81 binding destinations were present and matched their request-bound SHA-256.
- The final report and frozen treatment-fidelity audit were copied from their allowlisted destinations.
- The pre-existing `auditOnlyFiles` prepared-task scope was copied to `evidence/full-audit/fresh/prepared-tasks/` so the original task-tree, native-tests, environment-equality, and workspace-isolation checks remained byte-exact; this scope was already in the allowlist and is not a sixth main-evidence addition.
- 396 prepared-task files (258,858,588 bytes) were copied from that existing allowlisted audit scope.
- Total staged files: 741.
- Junction/symlink/reparse points: 0.
- Portable run exit code: 0.
- Package-contained application input paths observed: 395.
- Application reads outside package root: 0.
- Generated provenance paths outside clean root: 0.
- Original Desktop/project markers in portable source: 0.
- Original Desktop/project markers in generated clean outputs: 0.
- The clean run did not read `TencentDB-Agent-Memory` or the original `Direction_A_Final_Submission`.
- No junction or symlink was used.

Clean-directory R1 status: **PASS**.

## 5. Provider and prohibited-action audit

- Provider calls made during verification: **0**.
- The `576` count in output is historical ledger data read from frozen evidence, not new calls.
- Harbor/Docker/paid runtime: not invoked.
- Retraining/threshold tuning/additional experiments: not performed.
- Full repository tests, 227-test suite, and full typecheck: not run.
- Final report: not modified.
- ZIP/package: not created.

## 6. Missing inputs

None after the exact five-file amendment.

## 7. Final status

- Allowlist amendment: PASS.
- Five-file byte verification: PASS.
- Portable path patch: PASS.
- Scientific equality: PASS.
- Clean-directory zero-provider R1: PASS.

`PORTABLE_R1_PATCH_READY`
