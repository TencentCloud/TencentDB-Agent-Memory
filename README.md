
<div align="center">

<img src="./assets/images/logo.png" alt="TencentDB Agent Memory" width="880" />

### Agents remember. Humans innovate.

<a href="https://trendshift.io/repositories/29310?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-29310" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/29310" alt="TencentCloud%2FTencentDB-Agent-Memory | Trendshift" width="250" height="55"/></a>

[![npm](https://img.shields.io/npm/v/@tencentdb-agent-memory/memory-tencentdb?color=blue)](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb)
[![GitHub Release](https://img.shields.io/github/v/release/TencentCloud/TencentDB-Agent-Memory?label=release)](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E=22.16-brightgreen)](https://nodejs.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E=2026.3.13-orange)](https://github.com/openclaw/openclaw)
[![Hermes](https://img.shields.io/badge/Hermes-Gateway-7B61FF)](https://hermes-agent.nousresearch.com/docs/)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/dJQM6mKMF)

[Installation](#installation) · [Supported Agents](#all-agents-share-the-same-memory-server) · [Best Practices](#best-practices) · [What is it?](#what-is-tencentdb-agent-memory) · [Team Play](#one-play-style-build-a-growing-agent-team-for-a-one-person-company) · [Technical Implementation](#technical-implementation) · [Benchmark](#benchmark) · [Roadmap](#roadmap)

[**English**](./README.md) · [简体中文](./README_CN.md)

</div>

---

<td>
   <video src="https://github.com/user-attachments/assets/efb1a808-1f86-4cfe-802c-f7453f7ca938" width="100%" controls autoplay loop muted playsinline></video>
</td>

# Installation

Start all three services in one go (`memory-core` + `memory-hub` + `proxy`):

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env
$EDITOR .env       # Fill in two sets of LLM parameters (memory group + proxy group)
./start-all.sh     # Launch everything with one command; when finished, it prints a one-liner you can paste directly into Claude
```

Open the panel: [http://localhost:8125](http://localhost:8125).

Complete installation documentation (standalone Memory Hub deployment, Proxy + Claude Code / CodeBuddy usage, stop and cleanup, port reference, etc.) is available in [**INSTALL.md**](./INSTALL.md) (中文: [INSTALL_CN.md](./INSTALL_CN.md)).
The MongoDB storage backend is **experimental** (off by default); see
[INSTALL.md · MongoDB storage backend](./INSTALL.md#optional-mongodb-storage-backend-experimental-off-by-default).

### Migrating data from an older version

If you're already on an older release (v1.x / v0.x) and want to bring your existing data over to v2.0.0+, we provide a migration tool:

See [**Data Migration Tool (v2 → v3)**](./MemoryCore/scripts/migrate-v2-to-v3/README.md) for full usage and flags. New installations can skip this.

## All Agents Share the Same Memory Server

One Proxy, unchanged protocol, zero-code integration — point the Agent's base URL to the Proxy and configure its User Key. Most clients don't require a plugin, hook, or MCP server.

<table>
<tr>
<td align="center" width="140"><a href="./agents/dsh/"><img src="./assets/images/agents/dsh.png" width="48" height="48" /><br /><sub><b>DeepSeek Harness</b></sub></a></td>
<td align="center" width="140"><a href="./agents/claude-code/"><img src="./assets/images/agents/claude-code.png" width="48" height="48" /><br /><sub><b>Claude Code</b></sub></a></td>
<td align="center" width="140"><a href="./agents/codex/"><img src="./assets/images/agents/codex.png" width="48" height="48" /><br /><sub><b>Codex</b></sub></a></td>
<td align="center" width="140"><a href="./agents/codebuddy/"><img src="./assets/images/agents/codebuddy.png" width="48" height="48" /><br /><sub><b>CodeBuddy</b></sub></a></td>
</tr>
<tr>
<td align="center" width="140"><a href="./agents/workbuddy/"><img src="./assets/images/agents/workbuddy.png" width="48" height="48" /><br /><sub><b>WorkBuddy</b></sub></a></td>
<td align="center" width="140"><a href="./agents/hermes/"><img src="./assets/images/agents/hermes.png" width="48" height="48" /><br /><sub><b>Hermes</b></sub></a></td>
<td align="center" width="140"><a href="./agents/openclaw/"><img src="./assets/images/agents/openclaw.png" width="48" height="48" /><br /><sub><b>OpenClaw</b></sub></a></td>
<td align="center" width="140"><a href="./agents/adapter-agent-development.md"><sub><b>More frameworks coming soon...</b></sub></a></td>
</tr>
<tr>
<td align="center" width="140" colspan="2"><a href="./agents/opencode/"><picture><source media="(prefers-color-scheme: dark)" srcset="https://opencode.ai/brand/files/opencode-logo-dark-square.png" /><img src="https://opencode.ai/brand/files/opencode-logo-light-square.png" width="48" height="48" alt="" /></picture><br /><sub><b>OpenCode</b></sub></a></td>
<td align="center" width="140" colspan="2"><a href="./MemoryCore/pi-plugin/README.md"><img src="https://pi.dev/favicon.svg" width="48" height="48" alt="" /><br /><sub><b>Pi</b></sub></a></td>
</tr>
</table>

See [**INSTALL.md**](./INSTALL.md#using-proxy-with-agents) for links to the exact configuration steps of each client.

OpenCode has a [ready-to-use adapter configuration](./adapters/opencode/README.md), and Pi uses the [`pi-plugin` extension](./MemoryCore/pi-plugin/README.md) to connect through OpenAI Chat Completions. After binding a session, you can save a Team, Agent, and Task combination as the default for new sessions.

Don't see your favorite Agent? You can try adapting it yourself with the [Generic integration guide](./agents/adapter-agent-development.md) — and we'd love a PR adding native support for it. See [**CONTRIBUTING.md**](./CONTRIBUTING.md) to get started.

### Best Practices

Once you've deployed the stack and connected your Agents, use the guide to set up a team, import and assign memory assets, and see how well they work on a real task.

See the [Best Practices guide](https://tencentcloud.github.io/TencentDB-Agent-Memory/best-practices).

# What is TencentDB Agent Memory?

We started from a practical question: **How do you reduce repetitive work when using Agents?**

If project context has already been explained, it shouldn't need to be repeated in a new session. If documents have already been read, every Agent shouldn't have to start again from page one. A workflow that already works shouldn't have to be rediscovered next time.

Memory here means more than just "remembering conversations." **Any information that helps the next Agent avoid reinventing the wheel should be saved, organized, and reused.**

```text
Existing information → Reusable memory assets → Fewer turns → Less rework → More stable results and higher efficiency
```

### Let experience accumulate, flow, and pass on to the next Agent

**Memory Hub** for Agent teams closes the loop across the entire experience lifecycle: work produces assets, assets circulate through the team, and new members can load the team's save file on day one.

1. **Automatic asset extraction**: Extract Chat Memory and Skills from conversations and tasks; convert documents and code into Wiki and CodeGraph; then manage, review, and route them consistently.
2. **Portable & multi-Agent compatible**: Memory assets are decoupled from Agent frameworks — they can move across frameworks and be shared and maintained by multiple Agents and team members.
3. **Cold-start friendly**: Import existing documents, codebases, and Agent conversation sessions. New Agent teams can start from existing experience instead of learning from scratch.

### 🧠 A brain that remembers people and context

- **Chat Memory** retains preferences, facts, decisions, and interaction history.
- Session bindings and permissions determine which memories an Agent can access. When an Agent returns to the same work, it can reuse the context.
- L0 Conversation → L1 Atom → L2 Scenario → L3 Persona — raw conversations are distilled layer by layer.

<img width="" src="assets/images/chat_memory.png" alt="image.png" />

> "Don't refactor the old auth module — mobile is still using it." — Context this costly shouldn't depend on humans repeating it every time.

### ⚡ A Skill library that accumulates expertise

- After completing complex work, Agents can extract and manage reusable Skills from conversations and tool calls, and import them into the context of a designated Agent when needed. Skills can be edited and exported from the panel.
- A Skill isn't just a prompt snippet; it has versions, resource files, trigger boundaries, execution steps, and validation rules.
- Personal Skills are private by default; they can be shared with the team and assigned to other Agents.

<img width="" src="assets/images/skill.png" alt="image.png" />

> Troubleshooting, code review, release checklists — learn it once, and the whole team can use it.

### 📖 A knowledge map that reads both docs and code

- **Wiki** turns product docs, design specs, and ops runbooks into structured pages with a link graph. It supports Markdown, plain text, HTML, Word, Excel, PowerPoint, and PDF. (Inspired by Karpathy's LLM knowledge base.)

<img src="./assets/images/wiki.png" alt="image.png" />

- **CodeGraph** indexes code symbols, files, call relationships, and impact paths.
<img width="" src="assets/images/codegraph.png" alt="image.png" />

- Agents can search, read, inspect callers/callees, and perform impact analysis before modifying code.

> Wiki keeps Agents from reading every file list before getting to work. CodeGraph doesn't just tell them "the code is here" — it tells them "changing this might affect those."

### 🛡️ A team memory panel controlled by humans

- Create teams and Agents in Memory Hub; review, share, and equip memory assets.
- Manage ownership, versions, status, visibility, usage counts, and Agent bindings in one place.
- `private` belongs strictly to the Owner; `team` is visible to all team members; `restricted` grants precise access via User / Role / Agent ACLs.
- Two role layers: **global System Admin** manages users and teams (creating teams, adding members) and can also use Wiki, CodeGraph, Skill, and other asset management features; **Team-level roles** include Admin (team manager) and Member (regular member), responsible for asset collaboration and access control within a team. Asset ownership is tracked via Owner — the Owner automatically has management permissions for their assets.

<img width="" src="assets/images/asset.png" alt="image.png" />


## Cold Start: Load the Save File, Then Get to Work

Most Agents' first task is re-learning your project. TencentDB Agent Memory turns the learning cost you've already paid into a save file:

<img alt="Cold Start: import codebase, docs, and history into Memory Hub" src="assets/images/flowchart3.png" />

Admins can configure a default Agent template for the team so new members can pick up the team's way of working.

Specifically, you can import codebases and documents in the panel and use the client import script for past conversation sessions:

- **Codebases**: Import public repositories or private repositories with configured credentials — **CodeGraph** automatically indexes symbols, files, call relationships, and impact paths.
- **Documents & files**: Import relevant docs and files, including from configured external sources — **Wiki** automatically generates structured pages with a link graph.
- **Conversation sessions**: Use the [local asset import script](./agents/README.md#本地资产导入) to import past sessions from supported clients. By default, the script triggers both **Skill and Chat Memory** extraction; you can also choose to trigger just one.

> Stop retraining every Agent. Give it the save file.

## One Play Style: Build a Growing Agent Team for a One-Person Company

Open Memory Hub and create a team:

```text
Tiny but Serious Inc.
├── 👤 You · Set goals / Make decisions
├── 🔭 Scout · Research / Find opportunities
├── 🛠 Builder · Write code / Build products
├── 🧪 Reviewer · Test / Find issues
└── 🧠 Agent Memory · Preserve the team's experience
```

You're not opening four disconnected chat windows — you're assembling a squad with different roles that can inherit the team's accumulated experience.

### Recruit first, then equip

```text
🔭 Scout
   ├── User interview Chat Memory
   ├── Market research Wiki
   └── Competitive analysis Skill

🛠 Builder
   ├── Product Wiki
   ├── Project CodeGraph
   └── Feature Delivery Skill

🧪 Reviewer
   ├── Historical incident Chat Memory
   ├── Project CodeGraph
   └── Release Checklist Skill
```

Different roles, different loadouts. Less noise — give each Agent the memory assets it actually needs to get work done.

**The company can be tiny. Experience can compound forever.**

## Memory Assets, Not a Chat Log Warehouse

RAG answers "what can be found?" Team Memory also answers "who can use it, which version is valid, and which Agent should receive it."

| | Chat History | Standard RAG | TencentDB Agent Memory |
| :--- | :---: | :---: | :---: |
| Cross-session user understanding | △ | △ | ✅ Chat Memory |
| Distilled executable experience | — | — | ✅ Skill |
| Document structure & relationships | — | △ Chunk retrieval | ✅ Wiki + Link Graph |
| Code call graphs & impact scope | — | △ Text match | ✅ CodeGraph |
| Ownership / Version / Status | — | — | ✅ |
| Team sharing & Agent loadout | — | — | ✅ |
| Private / Team / ACL | — | △ | ✅ |

## Memory Hub Is Not a Display Board — It's a Control Panel

| Play Style | What you do in the Hub |
| :--- | :--- |
| **Team Up** | Create teams, add people and Agents, define sharing boundaries |
| **Asset Library** | Browse, search, review, and manage Chat Memory, Skills, Wiki, and CodeGraph |
| **Agent Loadout** | Bind different memory assets to different Agents; adjust priority and usage mode; configure the team's default Agent template |
| **Knowledge Workshop** | Build Wiki and CodeGraph; monitor processing status and asset metadata |
| **Access Control** | Switch between private, team, and ACL-based access; revoke sharing when needed |
| **Asset Usage Analytics** | Enable optional analytics to see how often memory, skill, and knowledge tools are called |

When you open an asset, what matters is not just "what it says," but also "where it came from, which version it is, who it's assigned to, and whether it's been used recently."

## Every Loop Gains Experience

<img alt="Every Loop Gains Experience: continuous accumulation, making every use smarter" src="assets/images/flowchart4.png" />

Memory doesn't run the Agent loop; it ensures the next iteration inherits the previous one's results: valuable interactions stay in Chat Memory, proven workflows are distilled into Skills, and document/code changes are updated through Wiki ingest and CodeGraph sync.

**Without Memory, loops may just repeat faster. With inherited memory, each iteration has the chance to be better than the last.**

## One Agent Team: Shared Experience, Not Shared Privacy

New Chat Memory and Skills are private by default. Sharing is an explicit action, not a default leak.

| Visibility | Semantics |
| :--- | :--- |
| `private` | Only the Owner can read — not even team admins |
| `team` | Team members can read; the Owner / Admin can manage |
| `restricted` | Precise access via User / Role / Agent ACL |
| `agent` | For targeted equipping of Agents within the same team |

You can assign the "Release Skill" to the Release Agent, the "Architecture Wiki" to all development Agents, and CodeGraph to Coder and Reviewer.

## Technical Implementation

TencentDB Agent Memory doesn't aim to "store everything." It solves three problems: **what's worth keeping, who can use it, and how to retrieve less while retrieving the right things next time.**

<img alt="Technical overview: layering (L0–L3), Memory Assets, Memory Hub, identity-based assembly for Agents" src="assets/images/flowchart5.png" />

### 1. Memory isn't flat records — it grows in layers

Conversations are first saved as L0, then refined by an async pipeline into multiple levels of granularity:

| Layer | What it stores | Primary use |
| :--- | :--- | :--- |
| **L0 Conversation** | Raw conversations with full context | Verify exact wording, timestamps, and sources |
| **L1 Atom** | Facts, preferences, constraints, and events extracted from conversations | Precise recall of actionable information |
| **L2 Scenario** | Knowledge blocks organized around projects or scenarios | Quickly restore a working context |
| **L3 Core / Persona** | Long-term profiles, stable patterns, and high-level cognition | Let Agents rapidly enter a user's and team's context |

Both generation and retrieval are layered: normally, L2/L3 provide a quick context bootstrap; when specific facts are needed, BM25 + vector retrieval + RRF fall back to L1/L0. Results are further capped by item count, character budget, and timeout limits to prevent memory from overwhelming the context window.

### 2. Memory isn't a global prompt — it's the Agent's loadout

Chat Memory, Skills, Wiki, and CodeGraph are all registered uniformly as Memory Assets. Memory Hub uses **Fixed Binding + ACL** to determine which assets a given Agent can use: first narrow the permission scope by Team, User, Agent, and visibility, then retrieve based on the current query.

This lets teams share experience without exposing all their private information; switching Agents or frameworks only requires re-equipping, not retraining.

### 3. Knowledge isn't injected wholesale — it's called on demand

Documents are organized into searchable Wiki pages that support link-graph drill-down; codebases are indexed into CodeGraph assets containing files, symbols, and call relationships. Agents call authorized knowledge tools on demand to read relevant pages, source code, or impact paths. The Knowledge service exposes `/v3/tools/list` and `/v3/tools/call` for integrations.

This makes documents and code part of memory as well — but they remain available tools that only enter context when truly needed.

## Benchmark

| Benchmark | Without TencentDB Agent Memory | With it enabled | Relative improvement |
| :--- | :---: | :---: | :---: |
| **PersonaMem** | 48% | **76%** | **+59%** |

PersonaMem tests whether an Agent can correctly understand and apply user information after extended interactions.

## Notes

- Wiki and CodeGraph are built asynchronously; allow some processing time before they reach `ready` status.
- CodeGraph supports public HTTPS repositories and private repositories with configured credentials. To clone a private repository over SSH, get the public key from the panel and grant it access on your code hosting platform.
- The Hub supports manual asset binding. On-demand Skill selection in the Proxy is off by default. Once you enable it and configure a selection strategy, the Proxy can select up to one relevant Skill to load per turn.

## Related Documentation

- [Full Installation Guide](./INSTALL.md) (Memory Core + Hub + Proxy one-click deployment)
- [Client Integration and Local Asset Import](./agents/README.md)
- [Data Migration Tool (v2 → v3)](./MemoryCore/scripts/migrate-v2-to-v3/README.md) (if you're on an older release and want to migrate existing data)
- [Knowledge OpenAPI](./MemoryKnowledge/openapi.yaml)
- **API Documentation**:
  - [Memory Core v3 API](./MemoryCore/v3-api-memorycore-doc.md)
  - [Memory Knowledge v3 API](./MemoryKnowledge/v3-api-memoryknowledge-doc.md)
  - [Memory Proxy v3 API](./MemoryProxy/v3-api-memoryproxy-doc.md)
  - [Memory Panel API](./MemoryPanel/panel-api-doc.md)
- [Contributing Guide](./CONTRIBUTING.md)

Agent Memory doesn't have a settled standard yet. Bug reports, documentation, benchmarks, new framework adapters, and more creative Memory Hub use cases are all welcome.

---
## Roadmap

[v2.0.3](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/tag/v2.0.3) adds default session bindings and support for rich document formats in Wiki. See [GitHub Releases](https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/latest) for the latest stable release and [CHANGELOG.md](./CHANGELOG.md) for the release history.

👉 See earlier plans in [**ROADMAP.md**](./ROADMAP.md) (中文: [ROADMAP_CN.md](./ROADMAP_CN.md)).

---
## Acknowledgements

TencentDB Agent Memory stands on the shoulders of the open-source community:

- [**CodeGraph**](https://github.com/colbymchenry/codegraph) — our CodeGraph asset module **uses code from this project**. Its design of a pre-indexed code graph is the foundation of our implementation.
- [**Hermes Agent**](https://github.com/nousresearch/hermes-agent) (Nous Research) — our Skill asset management **uses part of the Skill-related code from Hermes Agent and builds further optimizations base on it**.
- [**"LLM Wiki"** by Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the idea of treating documentation as an LLM-maintained, incrementally growing knowledge artifact directly informed how our Wiki layer is built and kept up to date.

We are grateful to the authors and contributors of these projects.

---
## Community & Contributing

We welcome contributions of all kinds — bug reports, feature suggestions, documentation fixes, benchmark reproductions, ecosystem integrations, or pull requests. Agent memory is far from settled, and we hope to build it together with the community.

- 🐞 **Found a bug or have a question?** Open an issue in [GitHub Issues](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) — we respond within 24 hours.
- 💡 **Have an idea to share?** Start a thread in [GitHub Discussions](https://github.com/TencentCloud/TencentDB-Agent-Memory/discussions).
- 🛠️ **Want to contribute code?** Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.
- 💬 **Want to chat with us?** Join our [Discord community](https://discord.gg/dJQM6mKMF) and talk to the core developers directly.
- ☁️ **Try the hosted version**: [Tencent Cloud Agent Memory](https://cloud.tencent.com/product/agm) is now available.
- 💬 **Want to join the community?** Scan the QR code to join the **Agent Memory WeChat group** and talk directly with the early developers.

<p align="center"><img src="https://github.com/user-attachments/assets/41ed193d-e70e-484e-8627-0e363a4b1eb0" width="200" alt="Agent Memory WeChat community QR code" /></p>

---

<p align="center">
 Let the path the team has walked become the next Agent's starting line.
</p>

---

## ✨ Contributors

> 💡 Thanks to the following contributors building with us — you make TencentDB Agent Memory better.

<div align="center">
  <a href="https://github.com/TencentCloud/TencentDB-Agent-Memory/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=TencentCloud/TencentDB-Agent-Memory&columns=12&anon=1" />
  </a>

  <br /><br />
<a href="https://github.com/TencentCloud/TencentDB-Agent-Memory/issues">
  <img src="https://img.shields.io/badge/Contributions_Welcome-006eff?style=for-the-badge&logo=github&logoColor=white" alt="Contributions Welcome" />
</a>

</div>


<table width="100%">
  <tr>
    <td width="68%">
      <b>If TencentDB Agent Memory has been helpful to you, please consider starring the project.</b><br />
      If you have any suggestions, feel free to open an issue for discussion.
    </td>
    <td width="32%" align="right">
      <img src="./assets/images/star-helper.png" alt="Star TencentDB Agent Memory" width="260" />
    </td>
  </tr>
</table>

---

## Star History

<p align="center">
  <a href="https://star-history.dera.page/#TencentCloud/TencentDB-Agent-Memory&Date">
    <img src="https://star-history.dera.page/svg?repos=TencentCloud/TencentDB-Agent-Memory&type=Date" alt="Star History Chart" width="600" />
  </a>
</p>

---

[MIT](./LICENSE) © TencentDB Agent Memory Team
