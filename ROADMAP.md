# Roadmap

This document describes **what we are building next**. For what has already shipped, see
[CHANGELOG.md](./CHANGELOG.md).

Current release: **v2.0.1-beta.1**

Roadmap items are what the team is actively working on, not promises. Scope and timing may
change. If something here matters to you — or something missing matters more — tell us in
[Discussions](https://github.com/TencentCloud/TencentDB-Agent-Memory/discussions).

---

## Next release · v2.0.1

### Agent templates: admins define the default loadout

**Module: Memory Hub**

v2.0.1-beta.1 gives every new team a default Agent, which solves "starting from nothing." But what
that Agent comes with is built in — admins can't adjust it to match how their team actually works.

- Admins can configure an **Agent template** defining which assets a default Agent is created with
- New members and new Agents initialize from the template, so the team's existing experience is
  the starting point rather than something to re-accumulate
- Different teams can have different default loadouts instead of all starting from the same
  built-in set

> Cold start isn't only about whether an Agent exists — it's whether that Agent knows your team's
> work on day one.

### `mem:` commands, extended around Tasks

**Module: Memory Proxy**

Today there are three commands — `sync` / `create-skill` / `help` — which limits what you can do
without leaving the conversation. This release extends them to the Task dimension:

- **Create a Task** directly in the conversation, without switching to the panel
- **Update a Task**, so its description keeps up with what was just decided in the conversation
- Task-to-asset associations take effect within the session

> Tasks are how memories get organized. Being able to maintain them in place is what prevents
> "the work is done, but the Task still describes three days ago."

### Editable memories: L1 - L3

**Module: Memory Hub**

Automatically extracted memories won't stay correct forever — facts expire, decisions get
reversed, and extraction itself can be off. The panel currently only allows viewing and deleting.

- L1 atoms, L2 scenarios, and L3 personas all become editable in the panel
- Incorrect memories can be corrected directly instead of deleted and rebuilt
- Memory shifts from "whatever the system produced" to an asset humans can calibrate

> The value of memory depends on accuracy. Giving people a way to correct it is more realistic
> than expecting extraction to be perfect.

### L0 / L1 memory search

**Module: Memory Hub**

v2.0.1-beta.1 added filtering the memory list by time range. Time narrows down *when*; finding
*what* still needs search.

- Search across L0 raw conversations and L1 atomic memories
- Works together with time filtering: narrow the range first, then locate by content
- Useful for tracing a conclusion back to its original source, and for checking whether a memory
  was extracted correctly

### Cursor support

**Module: Memory Proxy**

A Cursor adapter, reusing the same injection and write-back path as other clients.

---

## `mem:` session commands

**Module: Memory Proxy** — shipped in v2.0.0; v2.0.1 extends it with Task commands.

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
- What's awkward about the existing commands? Is the argument design getting in your way?
- Is there a workflow you've been working around, that a single command would solve?

Open an [issue](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) with the command
you want. Describing **the situation you're in** helps more than proposing an interface.

---

## Shaping this roadmap

Agent memory has no settled standard yet. What gets prioritized depends heavily on what people
actually run into.

- 🐞 Bugs and questions → [Issues](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues) (we respond within 24 hours)
- 🛠️ Code → read [CONTRIBUTING.md](./CONTRIBUTING.md) first

Contributions we especially welcome: **new client adapters** and **novel Memory Hub use cases**.

[简体中文](./ROADMAP_CN.md)
