# Agent Memory

Shared memory and knowledge for coding agents, served through a proxy that every agent client
points at. This glossary covers the terms of the subscription account pool.

## Language

### People and clients

**Member**:
A person who uses Memory Hub and authenticates to the proxy with a user key.
_Avoid_: user account, account

**Client Type**:
The kind of coding agent client that sends requests through the proxy, such as `claude-code` or `codex`.
_Avoid_: agent (in pool context), agent source

**Agent**:
A team-defined worker in Memory Hub (for example Builder or Reviewer) that has its own memory and asset loadout.
_Avoid_: client, client type

### Subscription pool

**Subscription Account**:
One paid Claude or ChatGPT subscription login that the proxy uses on behalf of Members.
_Avoid_: account (alone), provider key, API key

**Subscription Pool**:
The set of Subscription Accounts that serves one Client Type in one Memory instance.
_Avoid_: account pool, key pool

**Session Binding**:
The link between one client session and the Subscription Account that serves it.
_Avoid_: sticky session, assignment

**Quota Window**:
One usage limit of a Subscription Account with its own used percentage and reset time, such as the 5-hour window, the 7-day window or a per-model weekly window.
_Avoid_: quota, rate limit (alone)

**Threshold**:
The used percentage of a Quota Window at which a Subscription Account stops getting new Session Bindings.
_Avoid_: limit, cap

**Exhausted**:
The state of a Subscription Account that the provider rejected with a usage-limit error, until the reset time of the Quota Window.
_Avoid_: blocked, banned

**Release**:
The return of an Exhausted Subscription Account to service at its reset time.
_Avoid_: unblock, reset (as a verb on the account)
