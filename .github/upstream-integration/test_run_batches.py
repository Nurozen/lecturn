"""Hermetic controller safety/recovery tests; no agents, network or GitHub writes."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('batches', Path(__file__).with_name('run-batches.py'))
batches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batches)


class GitSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'repo'
        self.repo.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'base').write_text('base\n')
        self.git('add', 'base')
        self.git('commit', '-m', 'base')
        self.accepted = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-b', 'upstream')
        (self.repo / 'upstream').write_text('upstream\n')
        self.git('add', 'upstream')
        self.git('commit', '-m', 'upstream')
        self.target = self.git('rev-parse', 'HEAD')
        self.git('checkout', 'main')
        (self.repo / 'fork').write_text('fork\n')
        self.git('add', 'fork')
        self.git('commit', '-m', 'fork')
        self.base = self.git('rev-parse', 'HEAD')
        self.folder = Path(self.temp.name) / 'reports'
        self.folder.mkdir()

    def git(self, *args):
        return batches.git(self.repo, *args)

    def merged(self):
        self.git('merge', '--no-commit', '--no-ff', self.target)
        return batches.staged_tree(self.repo, self.base, self.target)

    def runner_manifest(self):
        runner = batches.Runner.__new__(batches.Runner)
        runner.repo = self.repo
        runner.args = SimpleNamespace(github_repo='example/fork')
        m = {'worktree': str(self.repo), 'expected_head': self.base, 'merge_parent': self.target,
             'target': self.target, 'tree': self.merged(), 'phase': 'reviewed'}
        return runner, m

    def test_checkpoint_counts_all_reachable_history(self):
        result = batches.check_selection(self.repo, self.base, self.accepted, self.target, self.target, 1, 100)
        self.assertEqual(result, (self.accepted, 1, 1))
        with self.assertRaisesRegex(batches.Blocked, 'commits'):
            batches.check_selection(self.repo, self.base, self.accepted, self.target, self.target, 0, 100)

    def test_resumed_builder_receives_local_branch_and_accepted_provenance(self):
        self.git('branch', '-m', 'stave/example/lecturn')
        runner = batches.Runner.__new__(batches.Runner)
        runner.args = SimpleNamespace(max_rounds=8)
        runner.progress = {'bootstrap_note': 'Prior PR merged', 'accepted_receipt': '/prior/manifest'}
        m = dict(worktree=str(self.repo), round=1, space='example', accepted=self.accepted,
                 base=self.base, expected_head=self.base, merge_parent=self.target,
                 branch='upstream/batch-example')
        (self.folder / 'BATCH_PROMPT.md').write_text('Verify the assigned branch and accepted provenance.')

        def builder(repo, folder, name, prompt, output_schema):
            manifest = json.loads((folder / 'manifest.json').read_text())
            self.assertEqual(manifest['local_branch'], self.git('branch', '--show-current'))
            self.assertNotEqual(manifest['local_branch'], manifest['branch'])
            self.assertEqual(manifest['accepted_provenance']['prior_accepted_batch'], '/prior/manifest')
            self.assertIn('only the eventual REMOTE PR destination', prompt)
            return {'ready': False, 'summary': 'Stopped after checking the handoff'}

        runner.agent = Mock(side_effect=builder)
        with self.assertRaisesRegex(batches.Blocked, 'Stopped after checking the handoff'):
            runner.build_review(self.folder, m)
        runner.agent.assert_called_once()
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)

    def test_rewritten_accepted_ancestry_is_rejected(self):
        with self.assertRaisesRegex(batches.Blocked, 'Accepted ancestry'):
            batches.check_selection(self.repo, self.base, self.base, self.target, self.target, 10, 100)

    def test_target_on_merged_side_branch_is_rejected(self):
        self.git('checkout', 'upstream')
        self.git('checkout', '-b', 'side')
        (self.repo / 'side').write_text('side\n')
        self.git('add', 'side')
        self.git('commit', '-m', 'side')
        side = self.git('rev-parse', 'HEAD')
        self.git('checkout', 'upstream')
        (self.repo / 'firstparent').write_text('mainline\n')
        self.git('add', 'firstparent')
        self.git('commit', '-m', 'firstparent')
        self.git('merge', '--no-ff', 'side', '-m', 'merge side')
        mirror = self.git('rev-parse', 'HEAD')
        with self.assertRaisesRegex(batches.Blocked, 'first-parent'):
            batches.check_selection(self.repo, self.base, self.accepted, side, mirror, 10, 100)

    def test_atomic_large_commit_requires_explicit_rationale(self):
        with self.assertRaisesRegex(batches.Blocked, 'source lines'):
            batches.check_selection(self.repo, self.base, self.accepted, self.target, self.target, 10, 0)
        batches.check_selection(self.repo, self.base, self.accepted, self.target, self.target, 10, 0,
                                'Single indivisible change; split subsystem reviewers')

    def test_unstaged_human_edit_invalidates_tree(self):
        self.merged()
        (self.repo / 'fork').write_text('human edit\n')
        with self.assertRaisesRegex(batches.Blocked, 'Unstaged'):
            batches.staged_tree(self.repo, self.base, self.target)

    def test_stale_review_cannot_commit_edited_tree(self):
        runner, m = self.runner_manifest()
        (self.repo / 'fork').write_text('changed after review\n')
        self.git('add', 'fork')
        with self.assertRaisesRegex(batches.Blocked, 'Tree changed'):
            runner.commit(self.folder, m)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)

    def test_commit_crash_recovery_preserves_exact_merge(self):
        runner, m = self.runner_manifest()
        # Simulate git commit completing just before manifest persistence failed.
        self.git('commit', '-m', 'integration')
        head = self.git('rev-parse', 'HEAD')
        runner.commit(self.folder, m)
        self.assertEqual(m['head'], head)
        self.assertEqual(self.git('show', '-s', '--format=%P', head), f'{self.base} {self.target}')
        self.assertEqual(json.loads((self.folder / 'manifest.json').read_text())['phase'], 'committed')

    def test_same_tree_with_wrong_parents_is_not_adopted(self):
        runner, m = self.runner_manifest()
        wrong = self.git('commit-tree', m['tree'], '-p', self.base, '-m', 'squashed')
        self.git('update-ref', 'HEAD', wrong)
        with self.assertRaisesRegex(batches.Blocked, 'parents'):
            runner.commit(self.folder, m)

    def test_unexpected_remote_head_stops_before_push(self):
        runner, m = self.runner_manifest()
        runner.commit(self.folder, m)
        remote = Path(self.temp.name) / 'remote.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
        self.git('remote', 'add', 'origin', str(remote))
        m['branch'] = 'upstream/batch-test'
        self.git('push', 'origin', f"{self.accepted}:refs/heads/{m['branch']}")
        with self.assertRaisesRegex(batches.Blocked, 'Remote branch changed'):
            runner.publish(self.folder, m)
        self.assertTrue(self.git('ls-remote', 'origin', m['branch']).startswith(self.accepted))

    def test_cleanup_does_not_follow_external_dependency_symlink(self):
        runner = batches.Runner.__new__(batches.Runner)
        spaces = Path(self.temp.name)
        runner.args = SimpleNamespace(spaces_dir=str(spaces))
        owned = spaces / 'owned' / 'lecturn'
        owned.mkdir(parents=True)
        external = spaces / 'external'
        external.mkdir()
        (external / 'keep').write_text('user data')
        (owned / 'node_modules').symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(batches.Blocked, 'escaped'):
            runner.cleanup_dependencies(self.folder, {'worktree': str(owned), 'space': 'owned',
                'owned_space': True, 'owned_dependencies': ['node_modules']})
        self.assertEqual((external / 'keep').read_text(), 'user data')

    def test_cleanup_failure_keeps_active_batch_and_resume_finishes_it(self):
        runner, m = self.runner_manifest()
        runner.commit(self.folder, m)
        runner.args = SimpleNamespace(github_repo='example/fork', ci_timeout=30, target=None, once=True)
        runner.progress_path = Path(self.temp.name) / 'progress.json'
        runner.progress = {'accepted': self.accepted, 'active': str(self.folder)}
        runner.save_progress()
        m.update(pr=1, phase='published')
        runner.gh = Mock(return_value=json.dumps({'state': 'MERGED', 'headRefOid': m['head'], 'baseRefName': 'main'}))
        runner.fetch = Mock(return_value=(m['head'], self.target))
        runner.cleanup_dependencies = Mock(side_effect=OSError('interrupted cleanup'))
        with self.assertRaisesRegex(OSError, 'interrupted cleanup'):
            runner.wait_merge(self.folder, m)
        self.assertEqual(runner.progress['active'], str(self.folder))
        self.assertEqual(json.loads((self.folder / 'manifest.json').read_text())['phase'], 'accepted')
        runner.cleanup_dependencies = Mock()
        runner.run()
        runner.cleanup_dependencies.assert_called_once()
        self.assertIsNone(runner.progress['active'])
        self.assertEqual(runner.progress['accepted'], self.target)
        self.assertEqual(runner.progress['accepted_receipt'], str(self.folder))

    def test_verified_no_source_ci_repair_reuses_head_and_reruns_failed_jobs(self):
        runner, m = self.runner_manifest()
        runner.commit(self.folder, m)
        head = m['head']
        m.update(phase='reviewed', expected_head=head, merge_parent=None, failed_run=123,
                 build={'ci_retry': True}, reviews=[{'ci_retry_safe': True}, {'ci_retry_safe': True}])
        runner.gh = Mock(side_effect=[json.dumps({'headSha': head, 'status': 'completed', 'conclusion': 'failure'}), ''])
        runner.commit(self.folder, m)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        runner.gh.assert_any_call('run', 'rerun', '123', '--repo', 'example/fork', '--failed')
        self.assertEqual(m['phase'], 'committed')

    def test_no_source_ci_repair_requires_independent_infrastructure_verdict(self):
        runner, m = self.runner_manifest()
        runner.commit(self.folder, m)
        m.update(phase='reviewed', expected_head=m['head'], merge_parent=None, failed_run=123,
                 build={'ci_retry': True}, reviews=[{'ci_retry_safe': True}, {'ci_retry_safe': False}])
        runner.gh = Mock()
        with self.assertRaisesRegex(batches.Blocked, 'independently verified'):
            runner.commit(self.folder, m)
        runner.gh.assert_not_called()

    def test_feedback_changed_during_final_review_prevents_merge(self):
        runner, m = self.runner_manifest()
        runner.commit(self.folder, m)
        m.update(pr=1, phase='published', review_base=self.base,
                 remote_review={'feedback_digest': 'old'})
        runner.args = SimpleNamespace(github_repo='example/fork', ci_timeout=30)
        success = {'__typename': 'CheckRun', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}
        pr = {'state': 'OPEN', 'headRefOid': m['head'], 'baseRefName': 'main', 'statusCheckRollup': [success],
              'mergeable': 'MERGEABLE', 'reviewDecision': ''}
        pr_calls = 0
        def gh(*args):
            nonlocal pr_calls
            if args[:2] == ('pr', 'view'):
                pr_calls += 1
                return json.dumps(pr | ({'reviewDecision': 'CHANGES_REQUESTED'} if pr_calls >= 3 else {}))
            if args[:2] == ('run', 'list'):
                return json.dumps([{'databaseId': 1, 'headSha': m['head'], 'status': 'completed', 'conclusion': 'success'}])
            self.fail('Unexpected GitHub mutation: ' + repr(args))
        runner.gh = Mock(side_effect=gh)
        runner.fetch = Mock(return_value=(self.base, self.target))
        runner.review_remote_feedback = Mock(return_value=True)
        runner.remote_feedback = Mock(return_value=({}, 'new'))
        remote = Path(self.temp.name) / 'remote.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
        self.git('remote', 'add', 'origin', str(remote))
        self.git('push', 'origin', f'{self.base}:refs/heads/main')
        with self.assertRaisesRegex(batches.Blocked, 'review requests changes'):
            runner.wait_merge(self.folder, m)
        runner.remote_feedback.assert_called_once()

    def test_failed_command_preserves_streamed_output(self):
        log = self.folder / 'failed.log'
        with self.assertRaisesRegex(batches.Blocked, 'retained evidence'):
            batches.command([sys.executable, '-c', 'print("retained evidence", flush=True); raise SystemExit(3)'],
                            self.repo, log=log)
        self.assertIn('retained evidence', log.read_text())


class CIGates(unittest.TestCase):
    def check(self, conclusion, status='COMPLETED'):
        return {'__typename': 'CheckRun', 'status': status, 'conclusion': conclusion}

    def test_empty_and_skipped_only_are_not_green(self):
        self.assertEqual(batches.ci_status([]), 'pending')
        self.assertEqual(batches.ci_status([self.check('SKIPPED')]), 'pending')

    def test_failed_cancelled_and_unknown_checks_are_not_green(self):
        for result in ['FAILURE', 'CANCELLED', 'TIMED_OUT', None, 'UNKNOWN']:
            self.assertEqual(batches.ci_status([self.check(result)]), 'failed')

    def test_running_test_blocks_successful_short_job(self):
        self.assertEqual(batches.ci_status([self.check('SUCCESS'), self.check(None, 'IN_PROGRESS')]), 'pending')

    def test_legacy_status_failure_blocks_successful_checks(self):
        self.assertEqual(batches.ci_status([self.check('SUCCESS'),
            {'__typename': 'StatusContext', 'state': 'FAILURE'}]), 'failed')

    def test_full_ci_workflow_must_finish_on_exact_head(self):
        checks = [self.check('SUCCESS')]
        run = {'databaseId': 10, 'headSha': 'expected', 'status': 'completed', 'conclusion': 'success'}
        self.assertEqual(batches.workflow_ci_status(checks, [], 'expected'), 'pending')
        self.assertEqual(batches.workflow_ci_status(checks, [run | {'status': 'in_progress'}], 'expected'), 'pending')
        self.assertEqual(batches.workflow_ci_status(checks, [run | {'headSha': 'other'}], 'expected'), 'pending')
        self.assertEqual(batches.workflow_ci_status(checks, [run | {'conclusion': 'failure'}], 'expected'), 'failed')
        self.assertEqual(batches.workflow_ci_status(checks, [run], 'expected'), 'green')

    def test_conditional_skips_allow_successful_real_suite(self):
        self.assertEqual(batches.ci_status([self.check('SUCCESS'), self.check('SKIPPED')]), 'green')


if __name__ == '__main__':
    unittest.main()
