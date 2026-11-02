# Contributing

Thanks for your interest in **TencentDB Agent Memory**! This document covers
the shared contribution flow for every open-source module in this repo
(`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` / `MemoryProxy` + SDK). For
module-specific dev instructions, see that module's own `CONTRIBUTING.md`
(when present) or `README.md`.

## How to contribute

- **Report bugs**: GitHub Issues — describe the symptom, reproduction steps, env
- **Feature requests**: Issues — describe the use case and the outcome you want
- **Docs**: fix typos, expand examples, clarify explanations
- **Code**: fix a bug, land a feature, improve performance

## Repository layout

```
tdai-memory-openclaw-plugin/
├── MemoryCore/          # Memory kernel (Gateway, 4-layer pipeline, Skill extraction)
├── MemoryPanel/         # Team memory control panel
├── MemoryKnowledge/     # Knowledge service (Wiki + CodeGraph)
├── MemoryProxy/         # LLM request proxy for coding agents
├── sdk/memory-core/     # Official TypeScript / Python SDKs
├── deploy/              # Image build & local deploy scripts
│   ├── global-images/   # One-command local stack
│   ├── dockerhub/       # Docker Hub publish recipe
│   └── panel-knowledge-combined/  # memory-hub image build
├── INSTALL.md / INSTALL_CN.md
├── CHANGELOG.md
└── README.md / README_CN.md
```

## Prerequisites

Module stacks differ slightly; common baseline:

- **Node.js ≥ 22.16.0** (`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
  `MemoryProxy` all run on Node 22)
- **npm** or **pnpm** (lockfiles vary per module)
- **Python ≥ 3.9** (for `sdk/memory-core/python` or v2→v3 migration scripts)
- **Docker** (for building images or running the local three-in-one stack)

## Bring up a dev environment

The simplest inner loop: run the full stack in Docker, then patch the target
module locally.

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env
./start-all.sh
```

Then work in the module source. Each module's `README.md` explains how to run
it standalone (usually `cd <module> && npm install && npm run dev`).

## Submitting changes

1. Fork the repo
2. Cut a feature branch from the branch you plan to target. The default branch
   is `feat/server_team`; use `main` or `feat/server` only when maintainers
   direct the change there.
   ```bash
   git switch -c fix/xxx-issue origin/feat/server_team
   ```
3. Make your changes, run the relevant tests
   ```bash
   cd <module>
   npm test          # or pnpm test
   ```
4. Commit using Conventional Commits + DCO sign-off (see below)
5. Push and open a PR against the same base branch, normally
   `feat/server_team` (follow the maintainer's latest guidance)
6. Get through CI + review, then merge

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

Signed-off-by: Your Name <your-email@example.com>
```

### type

| type | meaning |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `perf` | Performance optimization |
| `refactor` | Refactor (no behaviour change) |
| `docs` | Docs |
| `test` | Tests |
| `chore` | Build / deps / tooling |
| `style` | Formatting only |
| `revert` | Revert |

### scope

Use a module or subsystem name: `memory-core` / `panel` / `knowledge` /
`proxy` / `sdk-ts` / `sdk-py` / `deploy` / `docs`.

### Examples

```
feat(memory-core): add batch insert for L1 records
fix(proxy): sessionInit form retry when kernel returns 429
docs(sdk-ts): update v3 constructor examples
```

## Code style

- **TypeScript**: follow existing style; add comments explaining *why*, not *what*
- **Python**: PEP 8 with type annotations
- **Naming**: prefer English, be descriptive
- **Import order**: Node/Python builtins → third-party → project internals
- **Tests**: add tests with new features; fix a bug with a regression test first

## DCO sign-off

Every commit must carry a [DCO](https://developercertificate.org/) sign-off:

```bash
git commit -s -m "feat(memory-core): ..."
```

Commits without a `Signed-off-by:` trailer will not be merged. To make it
automatic:

```bash
git config user.name "Your Name"
git config user.email "your-email@example.com"
```

## Security issues

If you discover a security vulnerability, **do not** open a public issue.
Please email [agentmemory@tencent.com](mailto:agentmemory@tencent.com); we'll
respond promptly.

## License

By submitting a contribution you agree that it will be licensed under the
project's [MIT License](./LICENSE).

---

Thanks again! If you're unsure about any step, open a "question" Issue and
we'll help.
