# Knowledge dependency security updates

This patch changes the Knowledge dependency graph and the two SimpleGit factory imports required by version 4. It adds no feature, route, schema migration or inference call. The advisory snapshot was checked on 14 October 2026.

| Component | Selected change | Scope |
| --- | --- | --- |
| SimpleGit | Pin `4.0.2`, use the named `simpleGit` factory | Updated configuration/editor/argument guards; legacy default factory imports fail the new declarations |
| Drizzle ORM | Pin `0.45.4` | Patched SQL identifier escaping |
| Jaeger propagator | Override to `2.11.0` | Patched malformed-header handling, preserving the existing Node SDK version |
| esbuild under esbuild-kit | Override to `0.25.4` | Removes the vulnerable development-server dependency without downgrading Drizzle Kit |

Reviewed advisories: [SimpleGit configuration includes](https://github.com/advisories/GHSA-g4wm-2vf7-vfgr), [editor environment detection](https://github.com/advisories/GHSA-v5rq-49vh-5v5c), [Drizzle identifiers](https://github.com/advisories/GHSA-gpj5-g38j-94v9), [Jaeger headers](https://github.com/advisories/GHSA-45rx-2jwx-cxfr) and [esbuild development server](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Additional SimpleGit entries are reported by the baseline npm audit. Nine affected package entries include transitive/meta entries; they are not nine distinct CVEs.

Jaeger exposure depends on selecting that propagator; its presence alone does not prove the application uses it. Drizzle identifier tests demonstrate the library behavior, not attacker control of the application's static schema identifiers. The esbuild advisory concerns development-server use; generating SQLite migrations does not by itself expose that server. No observed production exploitation is claimed.

## Installation and compatibility

Use npm with the Knowledge project. The tested Linux fixture uses Node 22 and npm 11, `npm install --include=dev --ignore-scripts`, then `npm audit --include=dev`. The upstream Dockerfile already addresses the npm 10 installation issue. Overrides in this patch are npm overrides; pnpm/Yarn graphs are not verified by this evidence. Do not claim remediation under a package manager that ignores them.

No database format or application schema changes are introduced. Preserve existing backups for an application upgrade; this dependency proposal does not execute a production migration. SimpleGit's named factory retains ordinary operations. Previously accepted unsafe Git configuration may now be rejected; do not weaken its guards to preserve dangerous settings. Remote SSH/credential deployments and all tracing exporters remain outside these tests.

The upstream project has no committed npm lockfile. The verification fixture's generated lock is private test evidence, not a new published project lock. Selected packages are pinned, but a future unlocked installation can resolve a different transitive graph; audit it again. Deprecated esbuild-kit loaders remain and require a separate maintenance decision.

## Validation

Run `npm test -- tests/dependency-security.test.ts`, `npm run build`, and `npm run db:generate` against synthetic fixtures. Seven tests cover malformed and valid Jaeger headers, quoted SQL identifiers, real Knowledge SQLite migration/metadata writes, ordinary Git operations and rejected Git configuration includes. The before fixture uses SimpleGit 3.36.0, Drizzle 0.44.7 and Jaeger 2.8.0: four security cases fail and three ordinary cases pass. All seven pass after the patch. The native SQLite fixture is an actual source-built Linux addon with a matching package version; no fake bindings are used.

The full npm development audit resolves zero known advisories in the tested graph, compared with nine entries in the earlier upstream graph. Application build and Drizzle generation pass. This patch alone retains the unrelated upstream Hono compiler diagnostic; [PR #1649](https://github.com/TencentCloud/TencentDB-Agent-Memory/pull/1649) fixes that separately. With its correction overlaid only in the private fixture, whole Knowledge typecheck passes. None of this establishes independent final audit approval, absence of unknown vulnerabilities, complete native/toolchain trust or a verified production deployment.
