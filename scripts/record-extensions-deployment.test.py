import copy
import importlib.util
import pathlib
import os
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('record', pathlib.Path(__file__).with_name('record-extensions-deployment.py'))
record = importlib.util.module_from_spec(spec)
spec.loader.exec_module(record)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 40
        self.workflow = dict(id=123, head_sha=self.sha, head_repository={'full_name': 'Nurozen/lecturn'},
                             path='.github/workflows/deploy-relay.yml', head_branch='main', event='push',
                             conclusion='success', status='completed')
        self.jobs = {'jobs': [dict(name='Deploy production relay', conclusion='success',
                                  steps=[dict(name='Deploy production relay stage', conclusion='success')])]}

    def test_exact_successful_deployment(self):
        record.validate_evidence(self.workflow, self.jobs, self.sha, '123')

    def test_rejects_unrelated_failed_and_wrong_source_runs(self):
        for key, value in [('id', 124), ('head_sha', 'b' * 40), ('head_repository', {'full_name': 'fork/lecturn'}),
                           ('path', '.github/workflows/ci.yml'), ('head_branch', 'feature'),
                           ('event', 'pull_request'), ('conclusion', 'failure'), ('status', 'in_progress')]:
            with self.subTest(key=key):
                workflow = dict(self.workflow, **{key: value})
                with self.assertRaises(ValueError):
                    record.validate_evidence(workflow, self.jobs, self.sha, '123')

    def test_rejects_skipped_deployment_and_duplicate_jobs(self):
        for jobs in [{'jobs': []}, {'jobs': self.jobs['jobs'] * 2}]:
            with self.assertRaises(ValueError):
                record.validate_evidence(self.workflow, jobs, self.sha, '123')
        jobs = copy.deepcopy(self.jobs)
        jobs['jobs'][0]['steps'][0]['conclusion'] = 'skipped'
        with self.assertRaises(ValueError):
            record.validate_evidence(self.workflow, jobs, self.sha, '123')


@unittest.skipUnless(shutil.which('initdb') and shutil.which('pg_ctl') and shutil.which('psql'), 'Local PostgreSQL tools unavailable')
class LedgerTests(unittest.TestCase):
    def test_idempotency_conflict_and_promotion_fence(self):
        with tempfile.TemporaryDirectory(prefix='extensions-record-') as directory:
            root = pathlib.Path(directory).resolve()
            data = root / 'data'
            env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
            subprocess.run(['initdb', '-D', str(data), '-A', 'trust', '--no-locale'], env=env, check=True, capture_output=True)
            subprocess.run(['pg_ctl', '-D', str(data), '-l', str(root / 'log'), '-o', f"-h '' -k {root}", '-w', 'start'], env=env, check=True, capture_output=True)
            def execute(sql, success=True):
                result = subprocess.run(['psql', '-X', '-h', str(root), '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, env=env, capture_output=True)
                self.assertEqual(result.returncode == 0, success, result.stderr)
                return result.stdout.strip()
            try:
                execute('CREATE TABLE relay_extensions_schema(id integer PRIMARY KEY, phase integer, compatibility_deployments integer, rollback_floor text); INSERT INTO relay_extensions_schema VALUES(1,0,0,NULL);')
                first = record.record_sql('1', 'a' * 40, 'a' * 40, 'operator', 1)
                execute(first)
                execute(first)
                self.assertEqual(execute('SELECT compatibility_deployments FROM relay_extensions_schema'), '1')
                execute(record.record_sql('1', 'b' * 40, 'a' * 40, 'operator', 2), False)
                execute(record.record_sql('2', 'a' * 40, 'a' * 40, 'operator', 1), False)
                self.assertEqual(execute('SELECT count(*) FROM lecturn_operations.extensions_compatibility_deployments'), '1')
                execute(record.record_sql('2', 'b' * 40, 'a' * 40, 'operator', 1))
                self.assertEqual(execute('SELECT compatibility_deployments FROM relay_extensions_schema'), '2')
                execute('UPDATE relay_extensions_schema SET phase=1')
                execute(record.record_sql('3', 'c' * 40, 'a' * 40, 'operator', 1), False)
                self.assertEqual(execute('SELECT compatibility_deployments FROM relay_extensions_schema'), '2')
            finally:
                subprocess.run(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'], env=env, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
