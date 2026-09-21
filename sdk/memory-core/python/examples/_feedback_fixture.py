"""Invented engineering measurements for the API, never efficacy evidence."""

from copy import deepcopy
import hashlib
from tencentdb_agent_memory.feedback import FEEDBACK_SCHEMA, PolicySnapshot

INTERFACE = "synthetic-feedback-api-v1"
AUTHORITY = ("synthetic_engineering",)
FAMILY = "durable_change_missed"
CHECKS = ("state", "commit", "use")
RISKS = ("wrong_add", "wrong_change", "target_mismatch", "unauthorized_persistence", "stale_active")


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def feedback_fixture():
    rows = []
    for repeat in (1, 2, 3):
        for dialogue in ("D1", "D2"):
            for turn in (1, 2):
                bad_branch = dialogue == "D1" and repeat == 1
                current = bad_branch and turn == 1
                text = ("Always attach a change log to future deliveries." if turn == 1
                        else "Only the main document this time; keep the standing delivery preference.")
                action = "add" if turn == 1 else "noop"
                rows.append(dict(
                    dialogue=dialogue, lineage="synthetic-" + dialogue, turn=turn,
                    repeat=repeat, root=dialogue + "-U01",
                    origin="current" if current else "propagated" if bad_branch else "none",
                    authority=AUTHORITY[0], authority_kind="controlled_author",
                    annotation_sha256=sha("invented-label-" + dialogue + str(turn)),
                    source_sha256=sha(text),
                    trace_sha256=sha("invented-trace-" + dialogue + str(turn) + str(repeat)),
                    text=text, expected={"action": action},
                    predicted={"action": "noop" if current else action}, observed=True,
                    cause="policy_semantic" if current else "none",
                    family=FAMILY if current else None, action=action, probe=turn == 2,
                    checks=dict(state=not bad_branch, commit=not current,
                                use=not bad_branch if turn == 2 else None),
                    risks={k: False for k in RISKS}, cost=dict(tokens=100, latency_ms=10),
                ))
    return dict(schema=FEEDBACK_SCHEMA, policy_sha256=PolicySnapshot().sha256,
                interface_id=INTERFACE, split="train",
                planned=[[r["dialogue"], r["turn"], r["repeat"]] for r in rows], rows=rows)


def scripted_proposal(prepared):
    return dict(
        family=prepared["packet"]["selected_family"],
        support=[[r[k] for k in ("dialogue", "turn", "repeat", "root")]
                 for r in prepared["packet"]["errors"]],
        patch=dict(op="add", rule_id="R1", text=(
            "Distinguish lasting delivery requirements from an explicitly temporary output request."
        )),
    )


def synthetic_comparison(before, candidate, *, state_improved=True):
    after = deepcopy(before)
    after["policy_sha256"] = candidate.sha256
    for row in after["rows"]:
        row.update(origin="none", cause="none", family=None,
                   predicted=deepcopy(row["expected"]))
        row["checks"] = dict(state=True, commit=True, use=True if row["probe"] else None)
        if not state_improved and row["dialogue"] == "D1" and row["repeat"] == 1:
            row["checks"]["state"] = False
        row["risks"] = {k: False for k in RISKS}
        row["trace_sha256"] = sha("candidate-" + row["trace_sha256"])
    return after
