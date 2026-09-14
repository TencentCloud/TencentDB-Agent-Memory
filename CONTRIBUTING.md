# Contributing Guide

Thank you for your interest in the **TencentDB Agent Memory** project! We welcome all kinds of contributions from the community — whether it's reporting issues, improving documentation, or submitting code.

## How to Contribute

- **Report Bugs**: Describe the issue in GitHub Issues and provide steps to reproduce.
- **Request Features**: Describe your use case and proposed solution in Issues.
- **Improve Documentation**: Fix typos, clarify explanations, or add examples.
- **Submit Code**: Fix bugs, implement new features, or optimize performance.

## Getting Started

### Prerequisites

- Node.js >= 22.16.0
- npm or pnpm
- OpenClaw >= 2026.3.13

### Developing from Source

This project requires no build step. Node.js 22.16+ natively supports TypeScript type stripping, and OpenClaw directly loads `.ts` source files at runtime.

```bash
# Clone the repository
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory

# Install dependencies
npm install

# Register the current directory as a local plugin in OpenClaw
openclaw plugins install --link .
```

`install --link` registers the current directory as a local plugin in OpenClaw. After modifying source code, simply restart the Gateway for changes to take effect.

### Project Structure

```
├── index.ts                 # Plugin entry point
├── openclaw.plugin.json     # OpenClaw plugin manifest
├── src/
│   ├── config.ts            # Configuration management
│   ├── conversation/        # L0 Conversation layer — raw dialogue capture
│   ├── record/              # L1 Record layer — structured information extraction
│   ├── scene/               # L2 Scene layer — scene summarization & aggregation
│   ├── persona/             # L3 Persona layer — user profile construction
│   ├── store/               # Storage layer — SQLite / vector database
│   ├── hooks/               # OpenClaw hooks integration
│   ├── prompts/             # LLM prompt templates
│   ├── tools/               # Tool functions
│   ├── utils/               # General utilities
│   └── report/              # Health check & reporting
├── hermes-plugin/           # Hermes agent plugin adapter
├── scripts/                 # Helper scripts (Gateway control, etc.)
├── CHANGELOG.md             # Changelog
└── README.md                # Project documentation
```

## Submitting a Pull Request

1. **Fork** this repository and create your feature branch from `main`.
2. **Make changes** — keep each commit focused and atomic.
3. **Test** — ensure existing functionality is not affected.
4. **Update documentation** — if changes affect user-facing behavior, update the README or related docs.
5. **Open a PR** — describe the motivation, changes, and link related Issues.

### Branch Information

| Branch | Purpose |
|--------|---------|
| `main` | Default branch, PR target |

## Commit Message Convention

Use the following format for commit messages:

```
<type>(<scope>): <short summary>

<detailed description (optional)>

Closes #123
Signed-off-by: Your Name <your-email@example.com>
```

### Types

Aligned with the PR template Change Types:

| Type | Description | PR Change Type |
|------|-------------|----------------|
| `fix` | Bug fix | Bug fix |
| `feat` | New feature | New feature |
| `docs` | Documentation update | Documentation update |
| `perf` | Performance optimization | Code optimization |
| `refactor` | Code refactoring (no behavior change) | Code optimization |
| `test` | Test related | — |
| `chore` | Build / tooling / dependency changes | — |

### Scope Examples

`store`, `hooks`, `persona`, `scene`, `record`, `conversation`, `gateway`, `hermes`

## Code Style

- **TypeScript**: Follow the existing code style in the project for consistency.
- **Naming**: Use meaningful variable and function names, prefer English.
- **Comments**: Add comments at critical logic points explaining "why" rather than "what".
- **Import order**: Node.js built-in modules → third-party dependencies → internal project modules.

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by` line, indicating your agreement to the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "feat(store): add batch insert support"
```

Commits without a valid `Signed-off-by` will not be merged.

## Security Issues

If you discover a security vulnerability, please report it via the email agentmemory@tencent.com and we will address it promptly.

## License

By submitting a contribution, you agree that your code will be licensed under the [MIT License](./LICENSE).

---

Thank you again for contributing! If you have any questions, feel free to discuss them in Issues.
