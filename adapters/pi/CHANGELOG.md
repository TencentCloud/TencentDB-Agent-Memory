# Changelog

All notable changes to the TencentDB Agent Memory adapter for Pi are recorded
here.

## Unreleased

- Wait for Pi `agent_settled` and retain retry, compaction, and follow-up output.
- Capture ordered tool calls and tool results through `/v3/skill/conversation/add`.
- Track L0 and Skill delivery independently and recover incomplete writes after reload.
- Bound and sanitize captured tool payloads, images, recalled context, and credentials.

## 0.1.0 - 2026-08-10

- Add native Pi lifecycle integration for automatic recall and L0 capture.
- Add L1, L2 summary, and L3 bounded context injection.
- Add native atomic-memory and conversation-search tools.
- Add v3 Team, Agent, User, optional Task, and service isolation.
- Add persistent Pi-session capture markers, duplicate suppression, timeout
  handling, and fail-open behavior.
- Add equivalent English and Simplified Chinese setup guides.
- Add unit and HTTP contract tests.
