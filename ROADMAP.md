# Roadmap

This document describes **what we are building next**. For what has already shipped, see
[CHANGELOG.md](./CHANGELOG.md).

Current release: **v2.0.0**

Roadmap items are what the team is actively working on, not promises. Scope and timing may
change. If something here matters to you — or something missing matters more — tell us in
[Discussions](https://github.com/TencentCloud/TencentDB-Agent-Memory/discussions).

---

## Next release · v2.0.1

### Zero-config cold start: default Agent with preset Skills

**Module: Memory Hub**

Getting started currently means: deploy → create a team → create an Agent → bind assets →
copy the endpoint → start talking. Too many steps before the first useful turn.

In v2.0.1, Memory Hub provisions a **default Agent** on initialization:

- A default Agent exists as soon as a team or user is created — no manual setup
- The default Agent ships with **preset Skills**, so it can perform useful work before you
  have accumulated any Skills of your own
- Basic memory assets are pre-bound, so Chat Memory is written and recalled from the first turn
- The panel surfaces a ready-to-paste client endpoint, optionally pointing at Memory Proxy
- On single-host deployments the endpoint resolves to the host LAN address instead of an
  in-container hostname, so external clients can actually reach it

**Goal:** after `start-all.sh`, one copy-paste is enough to begin.

### Faster Wiki generation

**Module: Memory Knowledge**

Importing a large document set is where waiting is most visible today: pages move from
`processing` to `ready` one at a time.

v2.0.1 reworks Wiki generation into a bounded-concurrency pipeline:

- Page generation runs concurrently instead of strictly serially
- The build queue enforces a concurrency ceiling and rate limits, so upstream LLM quota
  isn't exhausted by a single large import
- A failed page no longer stalls the batch — it retries independently and keeps its error reason
- Build progress and per-page status are visible instead of being a black box

The larger the document set, the larger the gain. This matters most during cold start, when
you import an existing knowledge base for the first time.

### User- and team-level custom prompts

**Module: Memory Core** — configured via the Memory Core API. Editing custom prompts from the
Memory Hub panel is **not supported yet**.

Memory extraction quality depends on domain context. An infrastructure team cares about
change impact; a product team cares about user intent. A single hard-coded prompt cannot serve both.

- Override memory extraction and recall prompts at the **user** and **team** level
- Falls back to built-in defaults when unset — fully backward compatible
- Generated memories carry **provenance**: which prompt, which model, and when

Provenance makes "memory quality got worse" a traceable question rather than a guess.

### Skill export

**Module: Memory Hub**

A Skill is not a prompt snippet — it carries versions, resource files, trigger boundaries,
execution steps, and validation rules. Today those live only inside the Hub.

- New `/v3/skill/export` endpoint packages a Skill and its resource files as a downloadable zip
- Export timeout raised to accommodate Skills with large attached resources
- Exported content matches what is actually injected at runtime, including listing header/footer

Use it for backup, cross-environment migration, and sharing reusable workflows with the community.

### Time-based memory filtering

**Module: Memory Hub** 

The memory list in the panel can only be paged through as a whole today. Once memories
accumulate, narrowing down to a specific period is hard.

- Filter the memory list by time range in the panel
- Pairs with this release's timestamp fix: imported sessions keep their original recorded
  time, so filtered results match expectations

### Codex support (IDE Plan mode)

**Module: Memory Proxy**

Memory Proxy gains a Codex adapter, reusing the same injection and write-back path as other frameworks.

- **Supported scope in v2.0.1: Codex IDE, Plan mode only**
- During planning, Codex can read Chat Memory, Skills, Wiki, and CodeGraph — so the plan builds
  on your team's existing context instead of inferring from scratch
- Codex CLI and non-Plan execution modes are **not supported yet**; we'll prioritize based on demand

Framework support after v2.0.1:
OpenClaw · Hermes · Claude Code · CodeBuddy · Codex (IDE Plan) · SDK

### Also landing in v2.0.1

**Memory Core — correctness**
- Imported sessions preserve their original timestamps, including the JSONL mirror — importing
  historical conversations no longer flattens the timeline to import time

**Memory Proxy — correctness**
- Fix: multi-agent `conversation/search` read the wrong field and always returned empty
- Fix: session refresh did not clear the hook cache, so unbinding an asset had no effect

**Memory Hub — ecosystem**
- Opik → Skill importer, for distilling Skills from an external trace platform

**Memory Hub — panel**
- Loading skeletons, transitions, accessibility improvements, and unified asset detail headers

---

## `mem:` session commands

**Module: Memory Proxy** — shipped in v2.0.0. We're deciding which commands to build next.

Type a `mem:`-prefixed command directly in your conversation and Proxy intercepts it, handling
the request in place — no need to leave the session and open the panel:

| Command | What it does |
| --- | --- |
| `mem:sync` | Refresh every asset injected into this session (Skills / memories / Knowledge / Task & Agent descriptions) |
| `mem:create-skill [prompt]` | Archive this conversation as a Skill, extracted asynchronously |
| `mem:help` | Show command help |

The format is `mem:<command>` with no space after the colon. Command names are case-insensitive.

**We'd like to hear from you.** Commands are the lightest possible entry point — no context
switch, no API to remember, one line to trigger. Which ones we build next depends on what you
find yourself needing repeatedly:

- What would you want to do without leaving the conversation? (e.g. inspect what's currently
  injected, temporarily disable an asset, save a passage as a memory)
- What's awkward about the three existing commands? Is the argument design getting in your way?
- Is there a workflow you've been working around, that a single command would solve?

Open an [issue](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) with the command
you want. Describing **the situation you're in** helps more than proposing an interface.

---

## Shaping this roadmap

Agent memory has no settled standard yet. What gets prioritized depends heavily on what people
actually run into.

- 🐞 Bugs and questions → [Issues](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) (we respond within 24 hours)
- 💡 Ideas and proposals → [Discussions](https://github.com/TencentCloud/TencentDB-Agent-Memory/discussions)
- 🛠️ Code → read [CONTRIBUTING.md](./CONTRIBUTING.md) first
- 💬 Talk to the core developers → [Discord](https://discord.gg/dJQM6mKMF)

Contributions we especially welcome: **new framework adapters**, **benchmark reproductions**,
and **novel Memory Hub use cases**.

[简体中文](./ROADMAP_CN.md)
