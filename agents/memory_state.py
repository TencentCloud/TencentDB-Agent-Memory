"""Local configuration and durable conversation-to-memory routing."""
import hashlib
import json
import sqlite3
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "workspace/subscription-memory/hooks.sqlite"
SCOPE_KEYS = ("service_id", "team_id", "agent_id", "user_id")


def client_options():
    deployment = ROOT / "deploy/global-images"
    env = dotenv_values(deployment / ".env")
    isolation = json.loads((deployment / ".env.memory-mcp.json").read_text())
    return dict(endpoint=f"http://127.0.0.1:{env['MEMORY_CORE_PORT']}",
                api_key=env["MEMORY_CORE_GATEWAY_API_KEY"], service_id="default", **isolation)


def scope(options):
    return {key: options[key] for key in SCOPE_KEYS}


def open_state(path, defaults):
    db = sqlite3.connect(path, timeout=2)
    try:
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS prompts (session TEXT PRIMARY KEY, turn TEXT, prompt TEXT)")
        db.execute("CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT, payload TEXT, sent INTEGER DEFAULT 0)")
        db.execute("CREATE TABLE IF NOT EXISTS sessions (session TEXT PRIMARY KEY, scope TEXT NOT NULL)")
        encoded = json.dumps(scope(defaults))
        for table in ("prompts", "outbox"):
            if "scope" not in {row[1] for row in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN scope TEXT")
                # Pin legacy records before any conversation can switch agents.
                db.execute(f"UPDATE {table} SET scope=?", (encoded,))
        db.execute("INSERT OR IGNORE INTO sessions SELECT session,scope FROM prompts")
        db.commit()
        return db
    except Exception:
        db.close()
        raise


def session_scope(db, session, defaults):
    db.execute("INSERT OR IGNORE INTO sessions VALUES(?,?)", (session, json.dumps(scope(defaults))))
    db.commit()
    return json.loads(db.execute("SELECT scope FROM sessions WHERE session=?", (session,)).fetchone()[0])


def session_options(session, path=STATE):
    """MCP must name an existing hook session; never silently use a global agent."""
    with sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True) as db:
        row = db.execute("SELECT scope FROM sessions WHERE session=?", (session,)).fetchone()
    if row is None:
        raise ValueError("Unknown memory session; use the exact session_id from the current hook context")
    return {**client_options(), **json.loads(row[0])}


def storage_session(session, selected):
    suffix = hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest()[:16]
    return f"{session}:memory:{suffix}"
