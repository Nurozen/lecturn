#!/usr/bin/env python3
"""Harness checks only: no provider sessions, credentials, UI, or device calls."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
import qualify


class QualificationChecks(unittest.TestCase):
    def test_permission_drift_is_fatal(self):
        for mode, (policy, _, reviewer, sandbox) in qualify.MODES.items():
            result = {'approvalPolicy': policy, 'approvalsReviewer': reviewer,
                      'sandbox': {'type': sandbox}, 'thread': {'id': 'synthetic-unit-only'}}
            qualify.verify_thread(result, mode)
            for field in ('approvalPolicy', 'approvalsReviewer', 'sandbox', 'thread'):
                broken = copy.deepcopy(result)
                del broken[field]
                with self.assertRaises(RuntimeError):
                    qualify.verify_thread(broken, mode)
            broken = copy.deepcopy(result)
            broken['approvalsReviewer'] = 'silently-replaced'
            with self.assertRaises(RuntimeError):
                qualify.verify_thread(broken, mode)
            if sandbox != 'dangerFullAccess':
                result['sandbox']['networkAccess'] = True
                with self.assertRaises(RuntimeError):
                    qualify.verify_thread(result, mode)

    def test_environment_excludes_credentials_and_overrides(self):
        with tempfile.TemporaryDirectory() as root:
            env = qualify.isolated_env(Path(root) / 'home')
            for key in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HTTP_PROXY',
                        'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_SQLITE_HOME'):
                self.assertNotIn(key, env)
            self.assertTrue(Path(env['CODEX_HOME']).is_dir())
            self.assertEqual(Path(env['HOME']).parent, Path(root))

    def test_real_subprocess_timeout_is_reaped_and_logged(self):
        with tempfile.TemporaryDirectory() as root:
            suite = qualify.Suite(Path(root))
            with self.assertRaises(subprocess.TimeoutExpired):
                suite.command('deadline', [sys.executable, '-c', 'import time; time.sleep(30)'], timeout=0.1)
            self.assertFalse(qualify.ACTIVE)
            entry = json.loads((Path(root) / 'processes.jsonl').read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(entry['pid'], 0)

    def test_nonzero_command_cannot_pass(self):
        with tempfile.TemporaryDirectory() as root:
            suite = qualify.Suite(Path(root))
            with self.assertRaisesRegex(RuntimeError, 'exit 7'):
                suite.command('nonzero', [sys.executable, '-c', 'raise SystemExit(7)'])
            self.assertFalse(qualify.ACTIVE)

    def test_registration_is_print_only_by_default(self):
        # Execute the local script, never either command it prints.
        with tempfile.TemporaryDirectory() as root:
            suite = qualify.Suite(Path(root))
            text = suite.command('registration-plan', [sys.executable, str(qualify.HERE / 'register-mcp.py')])
            self.assertEqual(len(text.strip().splitlines()), 2)
            self.assertIn('--scope user --transport stdio', text)
            self.assertEqual(text.count('/home/lecturn/.config/symba/agent-token'), 2)
            self.assertNotIn('Bearer', text)


if __name__ == '__main__':
    unittest.main()
