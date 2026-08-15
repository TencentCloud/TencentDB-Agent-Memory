
<div align="center">

<img src="./assets/images/logo.png" alt="TencentDB Agent Memory" width="880" />

### Agents remember. Humans innovate.

<a href="https://trendshift.io/repositories/29310?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-29310" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/29310" alt="TencentCloud%2FTencentDB-Agent-Memory | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/@tencentdb-agent-memory/memory-tencentdb?color=blue)](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E=22.16-brightgreen)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E=2026.3.13-orange)](https://github.com/openclaw/openclaw)
[![Hermes](https://img.shields.io/badge/Hermes-Gateway-7B61FF)](https://hermes-agent.nousresearch.com/docs/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/dJQM6mKMF)

[Installation](#installation) · [What is it?](#what-is-tencentdb-agent-memory) · [Team Play](#one-play-style-build-a-growing-agent-team-for-a-one-person-company) · [Technical Implementation](#technical-implementation) · [Benchmark](#benchmark) · [Roadmap](#roadmap)

[**English**](./README.md) · [简体中文](./README_CN.md) · [**Русский**](./README_RU.md)

</div>

---

> **Latest:** Team Memory Beta быстро развивается — поставьте и начните за минуты.

<td>
   <video src="https://github.com/user-attachments/assets/efb1a808-1f86-4cfe-802c-f7453f7ca938" width="100%" controls autoplay loop muted playsinline></video>
</td>

# Installation

Запуск трёх сервисов одной командой (`memory-core` + `memory-hub` + `proxy`):

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env
$EDITOR .env       # Fill in two sets of LLM parameters (memory group + proxy group)
./start-all.sh     # Launch everything with one command; when finished, it prints a one-liner you can paste directly into Claude
```

Панель: [http://localhost:8125](http://localhost:8125).

Полная установка (standalone Hub, Proxy + Claude Code / CodeBuddy, stop/cleanup, ports): [**INSTALL.md**](./INSTALL.md) (中文: [INSTALL_CN.md](./INSTALL_CN.md)).

### Миграция со старой версии

С v1.x / v0.x на v2.0.0+: [**Data Migration Tool (v2 → v3)**](./MemoryCore/scripts/migrate-v2-to-v3/README.md). Новые установки можно пропустить.

# What is TencentDB Agent Memory?

Практический вопрос: **как уменьшить повторную работу с Agents?**

Если контекст проекта уже объясняли — не нужно снова. Если документы уже читали — каждый Agent не должен начинать с первой страницы. Рабочий workflow не должен «открываться заново» каждый раз.

Memory — не только «помнить разговоры». **Любая информация, которая помогает следующему Agent не изобретать велосипед, должна сохраняться, организовываться и переиспользоваться.**

```text
Existing information → Reusable memory assets → Fewer turns → Less rework → More stable results and higher efficiency
```

### Пусть опыт накапливается, циркулирует и передаётся следующему Agent

**Memory Hub** для agent teams замыкает lifecycle: работа → assets → shared team memory → cold start с «save file».

1. **Automatic asset extraction**: Chat Memory и Skills из conversations/tasks; docs и code → Wiki и CodeGraph; единый review/route.
2. **Portable & multi-Agent**: assets decoupled от frameworks — shared между Agents и людьми.
3. **Cold-start friendly**: import docs, codebases, sessions — команда стартует с опыта, не с нуля.

### 🧠 Brain: people & context

- **Chat Memory** — preferences, facts, decisions, history.
- У каждого Agent своя memory при создании.
- L0 Conversation → L1 Atom → L2 Scenario → L3 Persona.

<img width="" src="assets/images/chat_memory.cn.png" alt="Chat Memory" />

### ⚡ Skill library

- После сложной работы Agents извлекают reusable Skills (versions, resources, triggers, steps, validation).
- Personal Skills private by default; после review — team share.

<img width="" src="assets/images/skill.cn.png" alt="Skills" />

### 📖 Knowledge map: docs + code

- **Wiki** — product docs, specs, runbooks + link graph (inspired by Karpathy LLM Wiki).
- **CodeGraph** — symbols, files, calls, impact paths.
- Search, read, callers/callees, impact analysis before change.

<img src="./assets/images/wiki.cn.png" alt="Wiki" />
<img width="" src="assets/images/codegraph.cn.png" alt="CodeGraph" />

### 🛡️ Human-controlled team panel

- Teams, Agents, review/share/equip assets.
- Ownership, versions, status, visibility, bindings.
- `private` / `team` / `restricted` ACL.
- System Admin vs Team Admin/Member.

<img width="" src="assets/images/asset.cn.png" alt="Assets" />

## Cold Start: load the save file

<img alt="Cold Start" src="assets/images/flowchart3.png" />

- **Codebases** → CodeGraph
- **Documents** → Wiki
- **Conversation sessions** → Skills + Chat Memory

> Stop retraining every Agent. Give it the save file.

## One Play Style: growing Agent team for a one-person company

```text
Tiny but Serious Inc.
├── 👤 You · Set goals / Make decisions
├── 🔭 Scout · Research / Find opportunities
├── 🛠 Builder · Write code / Build products
├── 🧪 Reviewer · Test / Find issues
└── 🧠 Agent Memory · Preserve the team's experience
```

### Recruit first, then equip

```text
🔭 Scout  → interview Chat Memory, market Wiki, competitive Skill
🛠 Builder → Product Wiki, Project CodeGraph, Delivery Skill
🧪 Reviewer → incident Chat Memory, CodeGraph, Release Checklist Skill
```

**Компания может быть tiny. Experience compounds forever.**

## Memory Assets, not a chat log warehouse

| | Chat History | Standard RAG | TencentDB Agent Memory |
| :--- | :---: | :---: | :---: |
| Cross-session user understanding | △ | △ | ✅ Chat Memory |
| Distilled executable experience | — | — | ✅ Skill |
| Document structure & relationships | — | △ Chunk | ✅ Wiki + Link Graph |
| Code call graphs & impact | — | △ Text match | ✅ CodeGraph |
| Ownership / Version / Status | — | — | ✅ |
| Team sharing & Agent loadout | — | — | ✅ |
| Private / Team / ACL | — | △ | ✅ |

## Memory Hub = control panel

| Play Style | What you do |
| :--- | :--- |
| **Team Up** | Teams, people, Agents, sharing boundaries |
| **Asset Library** | Browse, search, review Chat Memory / Skills / Wiki / CodeGraph |
| **Agent Loadout** | Bind assets; priority & usage mode |
| **Knowledge Workshop** | Build Wiki/CodeGraph; processing status |
| **Access Control** | private / team / ACL; revoke when needed |

## Every Loop Gains Experience

<img alt="Every Loop Gains Experience" src="assets/images/flowchart4.png" />

Memory не крутит Agent loop — обеспечивает наследование: interactions → Chat Memory, workflows → Skills, docs/code → Wiki/CodeGraph.

## Shared experience, not shared privacy

| Visibility | Semantics |
| :--- | :--- |
| `private` | Only Owner |
| `team` | Team members |
| `restricted` | User / Role / Agent ACL |
| `agent` | Targeted Agent equip |

## Technical Implementation

<img alt="Technical overview" src="assets/images/flowchart5.png" />

### 1. Layered memory (L0–L3)

| Layer | What | Use |
| :--- | :--- | :--- |
| **L0 Conversation** | Raw full context | Exact wording / sources |
| **L1 Atom** | Facts, prefs, events | Precise recall |
| **L2 Scenario** | Project/scenario blocks | Restore working context |
| **L3 Core / Persona** | Long-term profiles | Fast enter user/team context |

Retrieval: L2/L3 bootstrap; BM25 + vector + RRF → L1/L0; caps on items/chars/timeout.

### 2. Loadout, not global prompt

Fixed Binding + ACL: Team / User / Agent / visibility, then query retrieval.

### 3. On-demand knowledge

Wiki pages + link graph; CodeGraph files/symbols/calls. Tools: `/v3/tools/list`, `/v3/tools/call`.

## Benchmark

| Benchmark | Without | With | Relative |
| :--- | :---: | :---: | :---: |
| **PersonaMem** | 48% | **76%** | **+59%** |

## Notes

- Wiki/CodeGraph async → wait for `ready`
- CodeGraph prioritizes public HTTPS repos
- Manual binding supported; auto routing still iterating
- OpenClaw, Hermes, Claude Code, CodeBuddy, SDK; more on roadmap

## Related Documentation

- [INSTALL.md](./INSTALL.md) · [ROADMAP.md](./ROADMAP.md) · [ROADMAP_CN.md](./ROADMAP_CN.md)
- [Migration v2→v3](./MemoryCore/scripts/migrate-v2-to-v3/README.md)
- [Knowledge OpenAPI](./MemoryKnowledge/openapi.yaml)
- [CONTRIBUTING.md](./CONTRIBUTING.md)

## Roadmap

**v2.0.0** current. Next (**v2.0.1**): zero-config cold start, faster Wiki, custom prompts, Skill export, Codex IDE Plan.

👉 [**ROADMAP.md**](./ROADMAP.md)

## Acknowledgements

- [**CodeGraph**](https://github.com/colbymchenry/codegraph)
- [**Hermes Agent**](https://github.com/nousresearch/hermes-agent)
- [**"LLM Wiki"** by Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Community & Contributing

- Issues: [GitHub Issues](https://github.com/Tencent/TencentDB-Agent-Memory/issues)
- Discussions: [GitHub Discussions](https://github.com/Tencent/TencentDB-Agent-Memory/discussions)
- Code: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Discord: [join](https://discord.gg/dJQM6mKMF)

---

<p align="center">
 Пусть пройденный путь команды станет стартовой линией следующего Agent.
</p>

---

## ✨ Contributors

<div align="center">
  <a href="https://github.com/TencentCloud/TencentDB-Agent-Memory/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=TencentCloud/TencentDB-Agent-Memory&columns=12&anon=1" />
  </a>
</div>

## Star History

<p align="center">
  <a href="https://www.star-history.com/#Tencent/TencentDB-Agent-Memory&Date">
    <img src="https://github.com/user-attachments/assets/16753a90-8bc9-471b-819e-311947ed94f7" alt="Star History Chart" width="600" />
  </a>
</p>

---

[MIT](./LICENSE) © TencentDB Agent Memory Team
