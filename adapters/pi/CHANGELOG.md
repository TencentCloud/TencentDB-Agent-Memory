# Changelog

All notable changes to the TencentDB Agent Memory adapter for Pi are recorded here.

## 0.1.0

- Add native Pi lifecycle integration for automatic recall and L0 capture.
- Add L1 atomic recall with optional L2 scenario summaries and L3 core profile.
- Add bounded system-prompt context injection with untrusted-data markers.
- Add native `tdai_memory_search`, `tdai_conversation_search`, and
  `tdai_memory_recall` tools.
- Add v3 Team / Agent / User / optional Task / service isolation on every call.
- Add timeout handling and fail-open behavior so MemoryCore outages never block Pi.
- Add credential-redaction and size-bounding for captured transcripts.
- Add durable capture markers that resume incomplete L0/Skill writes after reload.
- Add layered recall with a soft budget for optional L2/L3 enrichment.
- Add equivalent English and Simplified Chinese setup guides.
- Add unit and HTTP contract tests.
