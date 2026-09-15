# Environment

- Platform used for final verification: Windows 11, PowerShell 7
- Node.js: 22.23.2（项目要求 `>=22.16.0`）
- Package manager: pnpm 10.34.5
- Install policy: frozen lockfile, no provider credentials
- R1: only Node.js and packaged files; no Python, Harbor, Docker, network provider, junction, symlink, or reparse-point dependency
- Tests: Vitest, exactly the 10 entries in `FINAL_TEST_MANIFEST.json`

Dependency installation may use the public package registry. This is not a model-provider call. No `.env`, credentials, caches, `node_modules`, `.git` or `.workbuddy` content is distributed in the ZIP.
