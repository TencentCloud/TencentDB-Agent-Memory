# Bug Inventory — TencentDB-Agent-Memory

Audited files: Python Hermes plugin (`hermes-plugin/`), TypeScript core pipeline (`src/core/`), gateway layer (`src/gateway/`), and both README files.
Each entry includes exact location, failure mode under production conditions, and a minimal diff.

---

## BUG-001 · Typo: Missing space in README tagline

| Field | Value |
|---|---|
| **File** | `README.md:5` |
| **Category** | Documentation / Typo |
| **Severity** | Low |
| **PR scope** | Can be bundled with BUG-002 |

### Current code

```markdown
### Agents remember,Humans innovate.
```

### Problem

Missing space after the comma. This is the first human-readable text after the logo — the highest-visibility line in the document.

### Fix

```markdown
### Agents remember, Humans innovate.
```

---

## BUG-002 · Hardcoded locale: Chinese ideographic period in English README

| Field | Value |
|---|---|
| **File** | `README.md:333` |
| **Category** | Localization / Copy-paste residue |
| **Severity** | Low |
| **PR scope** | Bundle with BUG-001 as `docs: fix typos in README.md` |

### Current code

```markdown
For all fields, types, and constraints see [`openclaw.plugin.json`](./openclaw.plugin.json)。
```

### Problem

The sentence ends with `。` (Unicode `U+3002`, CJK Ideographic Full Stop) instead of the ASCII period `.`.
This was copy-pasted from `README_CN.md` without correction.
The character is visually subtle in most fonts but is technically the wrong code point for an English document — some linters, screen readers, and CI prose-checkers will flag it.

### Fix

```markdown
For all fields, types, and constraints see [`openclaw.plugin.json`](./openclaw.plugin.json).
```

---

## BUG-003 · Hardcoded Chinese string written into user data storage

| Field | Value |
|---|---|
| **File** | `src/core/record/l1-extractor.ts:388` |
| **Category** | Localization / Hardcoded string |
| **Severity** | Medium |
| **PR scope** | Standalone: `fix: use language-neutral fallback for malformed LLM scene names` |

### Current code

```typescript
scenes.push({
  scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
  message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
  memories: ...
});
```

### Problem

`"未知情境"` is the Mandarin phrase for "Unknown Scene/Context".
This fallback is activated whenever the LLM returns a scene segment whose `scene_name` field is absent, non-string, or otherwise malformed — a realistic occurrence on truncated responses or when a non-Chinese model produces out-of-spec JSON.

**Why this is worse than a log string:** `scene_name` is not a transient variable.
It is written persistently to:

1. The L1 JSONL memory records (`MemoryRecord.scene_name`), which surface in recall results.
2. The scene block index consumed by `SceneExtractor` and the persona generator.

An English-speaking user who triggers this path even once will have `"未知情境"` embedded in their memory store indefinitely — it will appear in recall context injected to the LLM, in `scene-index.json`, and in the scene navigation block shown to the agent. The system prompts being in Chinese is an intentional design choice; this string is **user-visible stored data**, not a prompt instruction, and should be language-neutral.

### Fix

```typescript
// Before
scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",

// After
scene_name: typeof s.scene_name === "string" ? s.scene_name : "unknown-scene",
```

`"unknown-scene"` is ASCII-safe, language-neutral, and follows the kebab-case naming convention enforced downstream by `filename-normalizer.ts`.

---

## BUG-004 · Silent exception in `_tail_stderr_log` hides Gateway crash evidence

| Field | Value |
|---|---|
| **File** | `hermes-plugin/memory/memory_tencentdb/supervisor.py:265` |
| **Category** | Silent exception swallowing |
| **Severity** | Medium |
| **PR scope** | Bundle with BUG-005 as `fix: log swallowed exceptions in supervisor` |

### Current code

```python
def _tail_stderr_log(self, max_bytes: int = LOG_TAIL_BYTES_ON_CRASH) -> str:
    """Return the last `max_bytes` of the stderr log for crash diagnostics."""
    path = self._stderr_log_path
    if not path:
        return ""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(-max_bytes, os.SEEK_END)
            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return ""
```

### Problem

`_tail_stderr_log()` exists for one purpose: to surface the Gateway's stderr output when the process exits non-zero during startup.
Its return value is passed directly into the error log at the call site:

```python
# supervisor.py:276-281
stderr = self._tail_stderr_log()[:500]
logger.error(
    "memory-tencentdb Gateway process exited with code %d during startup. "
    "stderr_log=%s tail=%s",
    rc, self._stderr_log_path or "<none>", stderr,
)
```

If the log file is unreadable — a permissions race between the spawning parent and the new child process, a full disk, a log rotation event — the `except Exception: return ""` path fires silently.
The operator then sees `tail=` with an empty string and no indication that the diagnostic read itself failed.
They assume the Gateway produced no stderr output and have no starting point for debugging the crash.

This is precisely the code path that matters most when things go wrong. It should not be silent.

### Fix

```python
# Before
    except Exception:
        return ""

# After
    except Exception as e:
        logger.debug(
            "memory-tencentdb Gateway: could not read stderr log %s: %s",
            path, e,
        )
        return ""
```

`debug` level is appropriate — this is a best-effort diagnostic helper and the `logger.error` at the call site already surfaces the crash itself.

---

## BUG-005 · Silent exception in `_close_log_handles` discards OS file-close errors

| Field | Value |
|---|---|
| **File** | `hermes-plugin/memory/memory_tencentdb/supervisor.py:248-251` |
| **Category** | Silent exception swallowing |
| **Severity** | Low |
| **PR scope** | Bundle with BUG-004 as `fix: log swallowed exceptions in supervisor` |

### Current code

```python
def _close_log_handles(self) -> None:
    """Close log file handles; safe to call multiple times."""
    for attr in ("_stdout_log", "_stderr_log"):
        handle: Optional[IO[bytes]] = getattr(self, attr, None)
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
            setattr(self, attr, None)
```

### Problem

`file.close()` can raise on POSIX (`EINTR`, `EIO`, `EBADF`).
The log files are opened with `buffering=0` (unbuffered raw bytes, `supervisor.py:197`), so data-loss on close is not a concern here — but a failed `close()` still leaks the underlying file descriptor.
The bare `except Exception: pass` with no logging means the leak produces zero observable signal.
If `_close_log_handles()` is called from a shutdown path after a crash, the OS fd table entry remains open and the log file may be held locked.

### Fix

```python
# Before
            except Exception:
                pass

# After
            except Exception as e:
                logger.debug(
                    "memory-tencentdb Gateway: error closing log handle %s: %s",
                    attr, e,
                )
```

The `setattr(self, attr, None)` line below the block is unchanged — the reference is always cleared regardless of whether `close()` succeeds, which is the correct behavior.

---

## Recommended PR plan

| PR | Bugs | Suggested title |
|---|---|---|
| 1 | BUG-001 + BUG-002 | `docs: fix missing space and stray CJK period in README.md` |
| 2 | BUG-003 | `fix: use language-neutral fallback for malformed LLM scene names` |
| 3 | BUG-004 + BUG-005 | `fix: log swallowed exceptions in supervisor log-handle methods` |

Start with PR 1. It is zero-risk and signals that you read the codebase carefully before touching logic.
PR 2 is the most technically substantive: a one-line TypeScript change that fixes a real data-quality issue for every non-Chinese user.
PR 3 is a clean Python improvement that makes an already well-designed supervisor easier to debug in production.
