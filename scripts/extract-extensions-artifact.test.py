import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('extract-extensions-artifact.py')
COMMIT = 'a' * 40
TEAM = 'ABCDE12345'

class Extraction(unittest.TestCase):
    def run_fixture(self, extra=None, wrong_commit=False):
        with tempfile.TemporaryDirectory(prefix='lecturn-extensions-extract-') as folder:
            root = Path(folder)
            archive = root / 'artifact.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                for platform in ['darwin-arm64', 'darwin-x64']:
                    binary = f'Synthetic {platform}'.encode()
                    manifest = dict(protocolVersion=1, buildVersion='b' * 40 if wrong_commit else COMMIT, platform=platform, signerTeamId=TEAM, sha256=hashlib.sha256(binary).hexdigest())
                    output.writestr(f'{platform}/manifest.json', json.dumps(manifest))
                    output.writestr(f'{platform}/lecturn-extensions-helper', binary)
                if extra:
                    output.writestr(extra, 'Private source must never be included')
            result = subprocess.run([sys.executable, str(SCRIPT), '--archive', str(archive), '--output', str(root / 'unpacked'), '--sha256', hashlib.sha256(archive.read_bytes()).hexdigest(), '--commit', COMMIT, '--team', TEAM], capture_output=True, text=True)
            return result.returncode, result.stderr, sorted(str(p.relative_to(root / 'unpacked')) for p in (root / 'unpacked').rglob('*') if p.is_file())

    def test_extracts_only_explicitly_pinned_architectures(self):
        code, _, files = self.run_fixture()
        self.assertEqual(code, 0)
        self.assertEqual(len(files), 4)

    def test_rejects_source_and_path_injection_before_writing(self):
        for path in ['evaluator/private-policy.ts', '../secret']:
            code, message, files = self.run_fixture(extra=path)
            self.assertNotEqual(code, 0)
            self.assertIn('Unexpected artifact contents', message)
            self.assertEqual(files, [])

    def test_rejects_a_different_build_even_with_valid_archive_digest(self):
        code, message, files = self.run_fixture(wrong_commit=True)
        self.assertNotEqual(code, 0)
        self.assertIn('trusted release pin', message)
        self.assertEqual(files, [])

if __name__ == '__main__':
    unittest.main()
