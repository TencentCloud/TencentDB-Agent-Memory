import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from scoped_memory import Denied, Store, context, management_action, parser, runtime_action


class OverlayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / 'overlay.sqlite'
        self.store = Store(self.path)
        self.addCleanup(self.store.db.close)
        self.projects = [str(uuid4()) for _ in range(3)]
        self.scope = 'project:' + self.projects[0]
        self.config = dict(workspace_id=str(uuid4()), agent_id=str(uuid4()),
                           owner_id=str(uuid4()), projects=self.projects)
        self.issue = dict(id=str(uuid4()), workspace_id=self.config['workspace_id'],
                          project_id=self.projects[0])
        self.env = dict(MULTICA_TOKEN='mat_fixture',
                        MULTICA_WORKSPACE_ID=self.config['workspace_id'],
                        MULTICA_AGENT_ID=self.config['agent_id'], MULTICA_TASK_ID=str(uuid4()))
        self.marker = dict(managed_by='multica-daemon-task', agent_id=self.config['agent_id'],
                           issue_id=self.issue['id'])
        self.agent = dict(owner_id=self.config['owner_id'], visibility='private', permission_mode='private')
        (self.root / '.multica/project').mkdir(parents=True)
        (self.root / '.multica/project/resources.json').write_text(
            json.dumps(dict(project_id=self.projects[0])))
        self.save_marker()

    def save_marker(self):
        (self.root / '.multica/daemon_task_context.json').write_text(json.dumps(self.marker))

    def lookup(self, kind, action, identity):
        return self.agent if kind == 'agent' else self.issue

    def action(self, *args, scope=None, source='issue:fixture'):
        return runtime_action(self.store, scope or self.scope, source, self.projects,
                              parser().parse_args(args))

    def text(self, content):
        path = self.root / 'input.txt'
        path.write_text(content)
        return str(path)

    def test_real_project_and_nested_checkout(self):
        child = self.root / 'checkout'
        child.mkdir()
        self.assertEqual(context(self.config, child, self.env, self.lookup),
                         (self.scope, 'issue:' + self.issue['id']))

    def test_missing_auth_wrong_owner_and_shared_agent_fail_closed(self):
        for changed in [dict(MULTICA_TOKEN=''), dict(MULTICA_AGENT_ID=str(uuid4())),
                        dict(MULTICA_WORKSPACE_ID=str(uuid4()))]:
            with self.assertRaises(Denied):
                context(self.config, self.root, self.env | changed, self.lookup)
        for changed in [dict(owner_id=str(uuid4())), dict(visibility='workspace'),
                        dict(permission_mode='public_to')]:
            original = self.agent.copy()
            self.agent.update(changed)
            with self.assertRaises(Denied):
                context(self.config, self.root, self.env, self.lookup)
            self.agent = original

    def test_unknown_project_and_missing_resources_are_not_daily(self):
        self.issue['project_id'] = str(uuid4())
        with self.assertRaises(Denied):
            context(self.config, self.root, self.env, self.lookup)
        self.issue['project_id'] = self.projects[0]
        (self.root / '.multica/project/resources.json').unlink()
        with self.assertRaises(Denied):
            context(self.config, self.root, self.env, self.lookup)

    def test_no_project_and_chat_have_distinct_sources(self):
        self.issue['project_id'] = None
        self.assertEqual(context(self.config, self.root, self.env, self.lookup)[0], 'daily')
        self.marker.pop('issue_id')
        self.marker['chat_session_id'] = str(uuid4())
        self.save_marker()
        scope, source = context(self.config, self.root, self.env, self.lookup)
        self.assertEqual(scope, 'daily')
        self.assertTrue(source.startswith('chat:'))
        self.marker['issue_id'] = self.issue['id']
        self.save_marker()
        with self.assertRaises(Denied):
            context(self.config, self.root, self.env, self.lookup)

    def test_scope_pinning_rejects_all_moves(self):
        self.store.pin('source', self.scope)
        for scope in ['daily', 'project:' + self.projects[1]]:
            with self.assertRaises(Denied):
                self.store.pin('source', scope)
        self.store.pin('daily-source', 'daily')
        with self.assertRaises(Denied):
            self.store.pin('daily-source', self.scope)

    def test_combined_recall_has_no_other_project_or_private_daily(self):
        self.store.write('public', 'format', 'preference', 'public preference', 'confirmed', 'human')
        self.store.write('daily', 'private', 'raw', 'private original', 'confirmed', 'chat')
        for index, project in enumerate(self.projects):
            self.store.write('project:' + project, 'fact', 'fact', str(index), 'confirmed', 'test')
        rows = self.action('query')
        self.assertEqual({r['text'] for r in rows}, {'public preference', '0'})
        rows = self.action('query', scope='daily', source='daily-source')
        self.assertEqual({r['text'] for r in rows}, {'public preference', 'private original'})

    def test_raw_archive_and_candidate_and_public_recall_are_separate(self):
        self.action('archive', '--name', 'raw', '--text-file', self.text('private raw'), scope='daily')
        candidate = self.action('propose', '--name', 'style', '--kind', 'preference',
                                '--text-file', self.text('summary only'), scope='daily')
        self.assertEqual(self.action('query', scope=self.scope, source='project-new'), [])
        published = self.store.publish(candidate)
        rows = self.action('query', scope=self.scope, source='project-new')
        self.assertEqual([r['text'] for r in rows], ['summary only'])
        self.assertEqual(published['source'], 'human-approved:' + candidate['id'])
        with self.assertRaises(Denied):
            self.store.publish(candidate)

    def test_runtime_cannot_publish_or_correct_public_records(self):
        public = self.store.write('public', 'style', 'preference', 'value', 'confirmed', 'human')
        for action in ['revoke', 'revise']:
            args = [action, '--id', public['id']]
            if action == 'revise':
                args += ['--text-file', self.text('wrong')]
            with self.assertRaises(Denied):
                self.action(*args)
        with patch.dict(os.environ, MULTICA_TOKEN='mat_fixture'):
            for action in ['inspect', 'publish']:
                with self.assertRaises(Denied):
                    management_action(self.store, argparse.Namespace(action=action), self.projects)

    def test_task_update_correction_and_revocation_preserve_history(self):
        old = self.action('remember', '--name', 'task', '--kind', 'task',
                          '--text-file', self.text('in progress'))
        new = self.action('revise', '--id', old['id'], '--text-file', self.text('completed'))
        self.assertEqual(new['previous_id'], old['id'])
        self.assertEqual([r['text'] for r in self.action('query')], ['completed'])
        with self.assertRaises(Denied):
            self.action('revoke', '--id', old['id'])
        self.action('revoke', '--id', new['id'])
        self.assertEqual(self.action('query'), [])
        self.assertEqual(self.store.get(old['id'])['text'], 'in progress')

    def test_skills_and_explicit_comparison_are_scope_limited(self):
        self.store.write('public', 'common', 'skill', 'common method', 'confirmed', 'human')
        for project in self.projects:
            self.store.write('project:' + project, 'local', 'skill', project, 'confirmed', 'test')
        rows = self.action('query', '--kind', 'skill')
        self.assertEqual({r['text'] for r in rows}, {'common method', self.projects[0]})
        args = ['compare', '--kind', 'skill', '--project', self.projects[0],
                '--project', self.projects[1]]
        with self.assertRaises(Denied):
            self.action(*args)
        rows = self.action(*args, scope='daily', source='daily-comparison')
        self.assertEqual({r['scope'] for r in rows}, {'project:' + p for p in self.projects[:2]})
        with self.assertRaises(Denied):
            self.action('compare', '--project', str(uuid4()), scope='daily', source='daily-comparison')

    def test_two_parallel_projects_and_shared_name_revision_serialization(self):
        def worker(index):
            store = Store(self.path)
            try:
                scope = 'project:' + self.projects[index % 2]
                store.pin('parallel-' + str(index), scope)
                return store.write(scope, 'same', 'fact', str(index), 'confirmed', str(index))
            finally:
                store.db.close()
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(worker, range(20)))
        for project in self.projects[:2]:
            self.assertEqual(sorted(r['revision'] for r in records if r['scope'] == 'project:' + project),
                             list(range(1, 11)))
        self.assertEqual(len(self.store.query(['project:' + self.projects[0]])), 1)

    def test_public_correction_and_revocation_require_exact_confirmation(self):
        candidate = self.store.write('daily', 'style', 'preference', 'old', 'candidate', 'chat')
        with patch.dict(os.environ, {}, clear=True), patch('sys.stdin.isatty', return_value=True):
            with patch('builtins.input', return_value='wrong'):
                with self.assertRaises(Denied):
                    management_action(self.store, parser().parse_args(['publish', '--id', candidate['id']]),
                                      self.projects)
            with patch('builtins.input', return_value='PUBLISH ' + candidate['id']):
                public = management_action(self.store, parser().parse_args(['publish', '--id', candidate['id']]),
                                           self.projects)
            args = ['correct-public', '--id', public['id'], '--text-file', self.text('corrected')]
            with patch('builtins.input', return_value='CORRECT-PUBLIC ' + public['id']):
                corrected = management_action(self.store, parser().parse_args(args), self.projects)
            self.assertEqual(self.store.query(['public'])[0]['text'], 'corrected')
            with patch('builtins.input', return_value='REVOKE-PUBLIC ' + corrected['id']):
                management_action(self.store, parser().parse_args(['revoke-public', '--id', corrected['id']]),
                                  self.projects)
            self.assertEqual(self.store.query(['public']), [])


if __name__ == '__main__':
    unittest.main()
