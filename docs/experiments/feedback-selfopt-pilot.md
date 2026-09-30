# Controlled pilot: historical rule transfer

This is a descriptive account of a completed real-provider research pilot on
2026-09-07, not an execution of the newly packaged SDK. The independently
implemented research runtime used the same single-root selection/adoption
design; the candidate in this comparison came from an earlier automatic run.
The public engineering examples are separate, deterministic tests.

## Setup

Two author-controlled Chinese dialogues had 24 turns each and three fresh-store
repeats per arm: 144 planned turns and 24 no-history probes per arm. One dialogue
changed project database/retry settings; the other changed personal response
language/caption preferences. Both included ADD, temporary/quoted NOOP, UPDATE
and explicit retirement, with probes at turns 6, 12, 18 and 24. These are bounded
multi-turn dialogues, not a public long-context benchmark or natural user study.

Both arms used MiniMax-M3, temperature 0, maximum completion 4096, adaptive
thinking, identical source/target interfaces, SQLite/FTS storage, retrieval k=5,
six-message intent history and four-message answer history. Probes had no answer
history. The single rule was generated in an earlier Qwen experiment and reused
verbatim. It had not passed that earlier adoption gate:

> 当提及长期记忆时，应明确指出其为持续使用的规则或信息，避免与当前回合的临时回答混淆。

The comparison added that rule versus empty rules. Both arms retained the same
compiler and storage guards. This is **not a comparison against the raw upstream
extractor**. Candidate runs preceded baseline runs, so provider/time effects were
not counterbalanced. No new candidate was generated, no model was changed
between arms, and no result was used to edit the candidate.

## Results and denominators

| Paired observable measure | Empty rules | Historical rule | Net difference |
|---|---:|---:|---:|
| Primary: correct fact state and, on probes, valid correct probe | 110/121 | 121/121 | +9.09 pp |
| Correct active fact state | 110/122 | 122/122 | +9.84 pp |
| Correct actual commit | 119/122 | 122/122 | +2.46 pp |
| Probe content under the registered output contract | 17/18 | 18/18 | +5.56 pp |

The primary paired counts are **11 improvements, 0 regressions, 110 unchanged,
23 unknown** out of the planned 144. The fully covered project-setting dialogue
alone was 68/72 versus 72/72. The observed candidate run completed 137/144 turns;
baseline completed 129/144. One further candidate probe format error leaves its
content score unknown. Unknowns are retained in the
[aggregate JSON](feedback-selfopt-pilot.json), not silently counted as successes.

Two originating failures produced the improvements:

- Baseline incorrectly updated the language entry while adding the independent
  caption preference. The lost language persisted through eight state checks;
  the candidate correctly added a separate memory. Its extra-prose probe output
  leaves one primary pair unknown, producing seven known primary improvements.
- Baseline generated a retirement intent with a non-null replacement selection.
  Parsing blocked the commit, despite the answer claiming deletion. The stale
  retry limit survived four turns; the candidate actually retired the entry.

These are two roots, not eleven independent discoveries. Per-repeat primary
gains were 7/32 known pairs, 4/48 and 0/41; the first and third repeats were
incomplete. The complete-plan adoption result remains **inconclusive**, with no
statistical confidence interval or independent held-out confirmation claimed.

## Regressions and cost

The candidate had an extra prose prefix before one otherwise factually correct
probe JSON. Its output violated the JSON-only contract; the score remained
unknown. Baseline's JSON there was valid but its language value was wrong, so
this is a format regression, not a fully correct baseline answer becoming a
fully wrong candidate answer.

Thirty coordinates had at least one diagnostic regression, with overlapping
dimensions. They include an empty source selection rejected to NOOP, extra
operation text stored alongside a correct retry value (eleven propagated strict
text mismatches), and ordinary queries routed to long-term memory rather than
the registered answer/current-turn route. These are retained diagnostics; they
do not mean thirty newly wrong stored facts. Candidate observed states and
actual commits were correct on its 137 completed turns.

There were two real execution interruptions: the candidate reached the 4096
completion limit at personal-dialogue repeat 3 turn 18 (seven turns unobserved);
baseline had HTTP 200 with no formal answer content at repeat 1 turn 10 (fifteen
turns unobserved). Only never-started baseline branches were later completed.
Failed branches were not replayed. These availability losses cannot be hidden
inside accuracy; one occurrence does not establish that the rule caused it.

The long pilot used 535 model requests, four provider metadata requests and
733,823 known tokens, with zero retries/fallback and zero new generation calls.
The 122 matched completed turns used 325,828 versus 335,613 tokens (+3.00%);
mean end-to-end time was 25.29 versus 26.09 seconds. Those times include pacing
and integrity work and are not a clean causal estimate of rule overhead.

The preceding six-turn-chain pilot completed 48/54 turns, with 45/48 correct
states and 47/48 correct commits. Its 36 preselected learning rows contained no
eligible current policy error, so it generated no candidate. It used 99 model
requests and 132,266 tokens, separately from the long comparison.

Full-plan write recall/F1, calibrated confidence, independent generalization and
production value are unestablished. Historical raw conversations, labels and
provider traces remain private and are not packaged as a public benchmark. Use
the [public reproduction instructions](../design/feedback-self-optimization.md)
to verify code behavior, and the documented host contract to design a separately
registered study with reviewed data and accounted provider costs.
