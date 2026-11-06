#!/usr/bin/env python3
"""Opt-in local memory overlay. Not a replacement for Memory Hub's L0/L1 pipeline."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from uuid import UUID, uuid4


class Denied(Exception):
    pass


def uid(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise Denied('Invalid runtime UUID') from None


def cli(*args):
    result = subprocess.run(['multica', *args, '--output', 'json'],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise Denied('Multica identity lookup failed; no fallback scope')
    return json.loads(result.stdout)


def context(config, cwd, env, lookup=cli):
    if not env.get('MULTICA_TOKEN', '').startswith('mat_'):
        raise Denied('A task-scoped Multica credential is required')
    workspace, agent = uid(env.get('MULTICA_WORKSPACE_ID')), uid(env.get('MULTICA_AGENT_ID'))
    uid(env.get('MULTICA_TASK_ID'))
    if workspace != config['workspace_id'] or agent != config['agent_id']:
        raise Denied('Workspace or agent is not enabled')
    identity = lookup('agent', 'get', agent)
    if (identity.get('owner_id') != config['owner_id'] or
            identity.get('visibility') != 'private' or
            identity.get('permission_mode', 'private') != 'private'):
        raise Denied('Overlay requires the configured owner and a private agent')
    for root in (cwd, *cwd.parents):
        marker_path = root / '.multica/daemon_task_context.json'
        if marker_path.is_file():
            marker = json.loads(marker_path.read_text())
            break
    else:
        raise Denied('No Multica runtime marker')
    if marker.get('managed_by') != 'multica-daemon-task' or marker.get('agent_id') != agent:
        raise Denied('Runtime marker disagrees with identity')
    issue_id, chat_id = marker.get('issue_id'), marker.get('chat_session_id')
    if chat_id and issue_id:
        raise Denied('Ambiguous chat/issue runtime')
    if chat_id:
        return 'daily', 'chat:' + uid(chat_id)
    issue = lookup('issue', 'get', uid(issue_id))
    if issue.get('id') != issue_id or issue.get('workspace_id') != workspace:
        raise Denied('Issue disagrees with runtime')
    project = issue.get('project_id')
    if not project:
        return 'daily', 'issue:' + issue_id
    project = uid(project)
    resource_path = root / '.multica/project/resources.json'
    if (project not in config['projects'] or not resource_path.is_file() or
            json.loads(resource_path.read_text()).get('project_id') != project):
        raise Denied('Unknown or changed project; start a new project task')
    return 'project:' + project, 'issue:' + issue_id


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=15, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS pins(source TEXT PRIMARY KEY, scope TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records(
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL,
                kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
                source TEXT NOT NULL, created_at TEXT NOT NULL,
                revision INTEGER NOT NULL, previous_id TEXT,
                UNIQUE(scope, name, revision));
            CREATE INDEX IF NOT EXISTS records_scope ON records(scope, name, revision);
        ''')

    def pin(self, source, scope):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute('SELECT scope FROM pins WHERE source=?', (source,)).fetchone()
            if row and row['scope'] != scope:
                raise Denied('Scope changed; start a new issue/session')
            self.db.execute('INSERT OR IGNORE INTO pins VALUES(?,?)', (source, scope))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def get(self, record_id):
        row = self.db.execute('SELECT * FROM records WHERE id=?', (record_id,)).fetchone()
        if not row:
            raise Denied('Record unavailable')
        return dict(row)

    def latest(self, scope, name):
        row = self.db.execute('SELECT * FROM records WHERE scope=? AND name=? '
                              'ORDER BY revision DESC LIMIT 1', (scope, name)).fetchone()
        return dict(row) if row else None

    def write(self, scope, name, kind, text, state, source, expected=None):
        if (not name.strip() or len(name) > 200 or not text.strip() or len(text) > 16000 or
                kind not in ('raw', 'fact', 'preference', 'skill', 'task') or
                state not in ('confirmed', 'candidate', 'published', 'revoked')):
            raise Denied('Invalid record')
        owns_transaction = not self.db.in_transaction
        if owns_transaction:
            self.db.execute('BEGIN IMMEDIATE')
        self.db.execute('SAVEPOINT record_write')
        try:
            old = self.latest(scope, name)
            if expected and (not old or old['id'] != expected):
                raise Denied('Record changed; review the latest revision first')
            record = dict(id=str(uuid4()), scope=scope, name=name, kind=kind, text=text,
                          state=state, source=source,
                          created_at=datetime.now(timezone.utc).isoformat(),
                          revision=old['revision'] + 1 if old else 1,
                          previous_id=old['id'] if old else None)
            self.db.execute('INSERT INTO records VALUES(:id,:scope,:name,:kind,:text,:state,'
                            ':source,:created_at,:revision,:previous_id)', record)
            self.db.execute('RELEASE record_write')
            if owns_transaction:
                self.db.commit()
            return record
        except Exception:
            self.db.execute('ROLLBACK TO record_write')
            self.db.execute('RELEASE record_write')
            if owns_transaction:
                self.db.rollback()
            raise

    def publish(self, candidate):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.write(candidate['scope'], candidate['name'], candidate['kind'],
                       candidate['text'], 'published', 'human-reviewed:' + candidate['id'],
                       candidate['id'])
            result = self.write('public', candidate['name'], candidate['kind'], candidate['text'],
                                'confirmed', 'human-approved:' + candidate['id'])
            self.db.commit()
            return result
        except Exception:
            self.db.rollback()
            raise

    def query(self, scopes, query='', kind=None, all_states=False):
        marks = ','.join('?' for _ in scopes)
        rows = self.db.execute(f'''SELECT r.* FROM records r
            WHERE scope IN ({marks}) AND NOT EXISTS (
                SELECT 1 FROM records newer WHERE newer.scope=r.scope AND newer.name=r.name
                AND newer.revision>r.revision) ORDER BY created_at DESC''', scopes).fetchall()
        return [dict(r) for r in rows if (all_states or r['state'] == 'confirmed')
                and (not kind or r['kind'] == kind)
                and query.casefold() in (r['name'] + '\n' + r['text']).casefold()]


def runtime_action(store, scope, source, projects, args):
    store.pin(source, scope)
    if args.action == 'query':
        return store.query(['public', scope], args.query, args.kind)[:args.limit]
    if args.action == 'compare':
        selected = list(dict.fromkeys(args.project))
        if scope != 'daily' or not selected or any(uid(p) not in projects for p in selected):
            raise Denied('Comparison requires a no-project session and explicit allowed project UUIDs')
        return store.query(['project:' + p for p in selected], args.query,
                           args.kind)[:args.limit]
    if args.action in ('archive', 'remember', 'propose'):
        text = Path(args.text_file).read_text()
        kind = 'raw' if args.action == 'archive' else args.kind
        if args.action == 'propose' and kind not in ('preference', 'skill'):
            raise Denied('Only preference/skill summaries can become public candidates')
        state = 'candidate' if args.action == 'propose' else 'confirmed'
        return store.write(scope, args.name, kind, text, state, source)
    old = store.get(args.id)
    if old['scope'] != scope:
        raise Denied('Only records in the current scope can be changed')
    return store.write(scope, old['name'], old['kind'],
                       Path(args.text_file).read_text() if args.action == 'revise' else old['text'],
                       old['state'] if args.action == 'revise' else 'revoked', source, old['id'])


def management_action(store, args, projects):
    # A local human entry point, not a public-publishing tool exposed to model runs.
    if os.environ.get('MULTICA_TOKEN') or not sys.stdin.isatty():
        raise Denied('Management requires the local owner terminal outside a Multica run')
    if args.action == 'inspect':
        return store.query(['public', 'daily', *('project:' + p for p in projects)],
                           args.query, args.kind, all_states=True)[:args.limit]
    old = store.get(args.id)
    if args.action == 'publish' and (old['state'] != 'candidate' or
                                     old['kind'] not in ('preference', 'skill')):
        raise Denied('Only a reviewed preference/skill candidate may be published')
    print(json.dumps(old, ensure_ascii=False, indent=2))
    confirmation = args.action.upper() + ' ' + old['id']
    if input('Type ' + confirmation + ' to confirm: ') != confirmation:
        raise Denied('Confirmation did not match')
    if args.action == 'publish':
        return store.publish(old)
    if old['scope'] != 'public':
        raise Denied('Use the current project task to revise/revoke project records')
    return store.write('public', old['name'], old['kind'],
                       Path(args.text_file).read_text() if args.action == 'correct-public' else old['text'],
                       'revoked' if args.action == 'revoke-public' else 'confirmed',
                       'human-reviewed:' + old['id'], old['id'])


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    for action in ('query', 'compare', 'inspect'):
        command = sub.add_parser(action)
        command.add_argument('--query', default='')
        command.add_argument('--kind', choices=('raw', 'fact', 'preference', 'skill', 'task'))
        command.add_argument('--limit', type=int, choices=range(1, 101), default=20)
        if action == 'compare':
            command.add_argument('--project', action='append', required=True)
    for action in ('archive', 'remember', 'propose'):
        command = sub.add_parser(action)
        command.add_argument('--name', required=True)
        command.add_argument('--text-file', required=True)
        if action != 'archive':
            command.add_argument('--kind', required=True,
                                 choices=('fact', 'task', 'preference', 'skill'))
    for action in ('revise', 'revoke', 'publish', 'correct-public', 'revoke-public'):
        command = sub.add_parser(action)
        command.add_argument('--id', required=True)
        if action in ('revise', 'correct-public'):
            command.add_argument('--text-file', required=True)
    return p


def main():
    os.umask(0o077)
    args = parser().parse_args()
    home = Path(__file__).resolve().parent
    try:
        config_path = home / 'scope-config.json'
        if config_path.stat().st_mode & 0o077:
            raise Denied('Scope config permissions must be 0600')
        config = json.loads(config_path.read_text())
        if args.action in ('inspect', 'publish', 'correct-public', 'revoke-public'):
            if os.environ.get('MULTICA_TOKEN') or not sys.stdin.isatty():
                raise Denied('Management requires the local owner terminal outside a Multica run')
            store = Store(home / 'overlay.sqlite')
            result = management_action(store, args, config['projects'])
        else:
            scope, source = context(config, Path.cwd().resolve(), os.environ)
            store = Store(home / 'overlay.sqlite')
            result = runtime_action(store, scope, source, config['projects'], args)
        print(json.dumps(result, ensure_ascii=False))
        store.db.close()
        return 0
    except (Denied, OSError, ValueError, KeyError, sqlite3.Error, subprocess.TimeoutExpired) as error:
        print(str(error) if isinstance(error, Denied) else 'Scoped memory failed; no fallback',
              file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
