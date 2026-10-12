import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, HERE / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provision = load('provision_status', 'guest/provision-status.py')
npm = load('verify_npm', 'guest/verify-npm.py')
sandbox = load('check_sandbox', 'guest/check-sandbox.py')
package = load('package', 'provision/package.py')
installer = load('installer', 'provision/install.py')


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_cloud_init_done_without_marker_is_failure(self):
        self.assertEqual(provision.status(self.root), 21)
        done = self.root / 'var/lib/cloud/instance/boot-finished'
        done.parent.mkdir(parents=True)
        done.touch()
        self.assertEqual(provision.status(self.root), 20)

    def test_failed_package_setup_clears_old_ready_and_records_failure(self):
        # Run the actual shell with guest paths mapped to this fixture. The first
        # apt invocation fails; no package installation or privileged I/O occurs.
        state = self.root / 'state'
        state.mkdir()
        (state / 'ready').touch()
        bootstrap = self.root / 'bootstrap'
        bootstrap.mkdir()
        commands = self.root / 'bin'
        commands.mkdir()
        stubs = {'id': 'echo 0', 'uname': 'echo aarch64',
                 'systemd-detect-virt': 'echo qemu', 'apt-get': 'exit 37'}
        for name, body in stubs.items():
            path = commands / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        install = commands / 'install'
        install.write_text('#!' + sys.executable + '\n' + '''
import pathlib, sys
p = pathlib.Path(sys.argv[-1])
if '-d' in sys.argv:
    p.mkdir(parents=True, exist_ok=True)
else:
    p.touch()
''')
        install.chmod(0o755)
        script = (HERE / 'guest/setup.sh').read_text().replace(
            'export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'export PATH="' + str(commands) + ':/usr/bin:/bin"')
        script = script.replace('/var/lib/symba-provision', str(state)).replace('/opt/symba-bootstrap', str(bootstrap))
        result = subprocess.run(['/bin/bash', '-c', script], capture_output=True)
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertFalse((state / 'ready').exists())
        self.assertTrue((state / 'failed').is_file())

    def test_only_trusted_ready_marker_completes_setup(self):
        state = self.root / 'var/lib/symba-provision'
        state.mkdir(parents=True)
        ready = state / 'ready'
        ready.touch()
        # Tests need no root permission; exercise ownership independently below.
        with patch.object(provision, 'trusted', return_value=True):
            self.assertEqual(provision.status(self.root), 0)
            (state / 'failed').touch()
            self.assertEqual(provision.status(self.root), 20)
            (state / 'failed').unlink()
        with patch.object(provision, 'trusted', return_value=False):
            self.assertEqual(provision.status(self.root), 20)

    def test_guest_writable_symlink_or_nonroot_marker_is_untrusted(self):
        path = self.root / 'ready'
        for mode, uid, links in [(0o100666, 0, 1), (0o100644, 1000, 1),
                                 (0o120777, 0, 1), (0o100644, 0, 2)]:
            with patch.object(Path, 'lstat', return_value=Mock(st_mode=mode, st_uid=uid, st_nlink=links)):
                self.assertFalse(provision.trusted(path))

    def test_lock_and_installed_versions_must_match_pins(self):
        pins = json.loads((HERE / 'pins.json').read_text())
        for name in ['package.json', 'package-lock.json']:
            (self.root / name).write_bytes((HERE / 'guest' / name).read_bytes())
        lock = json.loads((self.root / 'package-lock.json').read_text())
        for key, value in lock['packages'].items():
            if key:
                directory = self.root / key
                directory.mkdir(parents=True, exist_ok=True)
                (directory / 'package.json').write_text(json.dumps({'version': value['version']}))
        npm.verify(self.root, pins)
        shared = self.root / 'node_modules/@effect/platform-node-shared/package.json'
        shared.write_text('{"version":"4.0.3"}')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            npm.verify(self.root, pins)

    def test_lock_retains_arm64_provider_payloads_and_integrities(self):
        packages = json.loads((HERE / 'guest/package-lock.json').read_text())['packages']
        for name in ['@openai/codex-linux-arm64', '@anthropic-ai/claude-code-linux-arm64']:
            entry = packages['node_modules/' + name]
            self.assertIn('arm64', entry['cpu'])
            self.assertIn('linux', entry['os'])
            self.assertTrue(entry['integrity'].startswith('sha512-'))
        for key, value in packages.items():
            if key:
                self.assertTrue(value['resolved'].startswith('https://registry.npmjs.org/'))
                self.assertTrue(value['integrity'].startswith('sha512-'))

    def test_sandbox_probe_rejects_successful_unsandboxed_execution(self):
        fixture = self.root / 'fixture'
        fixture.write_text('sandbox fixture')
        result = subprocess.run([sys.executable, '-c', sandbox.PROBE, str(fixture)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'sandbox allowed a denied write', result.stderr)

    def test_sandbox_launch_failure_never_becomes_success(self):
        with patch.object(sandbox.os, 'getuid', return_value=1000), \
             patch.object(sandbox.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'bwrap')):
            with self.assertRaises(subprocess.CalledProcessError):
                sandbox.check()

    def test_sandbox_probe_does_not_accept_empty_success(self):
        with patch.object(sandbox.os, 'getuid', return_value=1000), \
             patch.object(sandbox.subprocess, 'run', return_value=Mock(stdout='')):
            with self.assertRaisesRegex(RuntimeError, 'probe failed'):
                sandbox.check()

    def test_built_bundle_contains_complete_guest_policy_and_lock(self):
        (self.root / 'runtime-control').write_bytes(b'test binary')
        (self.root / 'runtime-helper').write_bytes(b'test binary')
        package.build(HERE, self.root)
        self.assertEqual(len(installer.validate_bundle(self.root / 'runtime-package.tar')), 64)


if __name__ == '__main__':
    unittest.main()
