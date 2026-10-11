import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import unittest
from unittest.mock import patch, Mock

HERE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime = load('runtime', HERE / 'controller/runtime_controller.py')
installer = load('installer', HERE / 'provision/install.py')


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.vm = self.root / 'vm'
        self.state.mkdir()
        (self.vm / 'run').mkdir(parents=True)
        for name, value in [('STATE', self.state), ('VM', self.vm)]:
            p = patch.object(runtime, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.record = {'pid': 220, 'starttime': 100, 'bootId': 'boot', 'mountNamespace': 'mnt:[123]'}
        self.life = {'instanceId': '58bce615-c186-4976-b3ea-61d54d32d87f', 'uid': 12001,
                     'qemu': self.record, 'bridge': None}
        self.cfg = json.loads((HERE / 'config.example.json').read_text())

    def test_pid_reuse_refuses_signal_after_pidfd_open(self):
        with patch.object(runtime.os, 'pidfd_open', return_value=7, create=True), \
             patch.object(runtime.os, 'close') as close, \
             patch.object(runtime, 'identity', return_value={**self.record, 'starttime': 101}), \
             patch.object(runtime.signal, 'pidfd_send_signal', create=True) as send:
            with self.assertRaisesRegex(runtime.Fault, 'provenance'):
                runtime.signal_owned(self.record, 15)
            send.assert_not_called()
            close.assert_called_once_with(7)

    def test_proc_stat_handles_spaces_and_parentheses(self):
        proc = self.root / 'proc'
        (proc / '220/ns').mkdir(parents=True)
        (proc / 'sys/kernel/random').mkdir(parents=True)
        (proc / 'sys/kernel/random/boot_id').write_text('boot\n')
        (proc / '220/ns/mnt').symlink_to('mnt:[123]')
        fields = ['S'] + ['0'] * 18 + ['100'] + ['0'] * 3
        (proc / '220/stat').write_text('220 (qemu odd ) name) ' + ' '.join(fields))
        with patch.object(runtime, 'PROC', proc):
            self.assertEqual(runtime.identity(220), self.record)
            (proc / '220/stat').write_text('220 (qemu) Z ' + ' '.join(fields[1:]))
            self.assertIsNone(runtime.identity(220))

    def test_configuration_rejects_scope_expansion_and_bool_numbers(self):
        for cfg in [{**self.cfg, 'command': '/bin/sh'}, {**self.cfg, 'cpus': True},
                    {**self.cfg, 'memoryMiB': 99999}, {**self.cfg, 'package': 'other.app'},
                    {**self.cfg, 'networkBoundary': 'loopback-is-private'}]:
            with self.subTest(cfg=cfg), patch.object(runtime, 'read_json', return_value=cfg):
                with self.assertRaises(runtime.Fault):
                    runtime.config()

    def test_duplicate_config_keys_rejected(self):
        with patch.object(runtime, 'trusted_file', return_value=b'{"cpus":1,"cpus":2}'):
            with self.assertRaisesRegex(runtime.Fault, 'duplicate'):
                runtime.read_json(Path('unused'))

    def test_symlink_state_file_rejected(self):
        target = self.state / 'target'
        target.write_text('untrusted')
        link = self.state / 'runtime.json'
        link.symlink_to(target)
        with self.assertRaises(OSError):
            runtime.trusted_file(link)

    def test_shared_or_nonroot_state_file_rejected(self):
        path = self.state / 'runtime.json'
        path.write_text('{}')
        path.chmod(0o644)
        with self.assertRaises(runtime.Fault):
            runtime.trusted_file(path)

    def test_start_requires_foreground_before_spawning(self):
        with patch.object(runtime, 'config', return_value=self.cfg), \
             patch.object(runtime, 'load_lifecycle', return_value=None), \
             patch.object(runtime, 'spawn_gated') as spawn:
            with self.assertRaisesRegex(runtime.Fault, 'foreground'):
                runtime.transition('start', 12001, False)
            spawn.assert_not_called()

    def test_repeated_start_never_spawns_second_vm(self):
        with patch.object(runtime, 'config', return_value=self.cfg), \
             patch.object(runtime, 'load_lifecycle', return_value=self.life), \
             patch.object(runtime, 'observe', return_value=runtime.answer('starting', self.life)), \
             patch.object(runtime, 'spawn_gated') as spawn:
            result = runtime.transition('start', 12001, True)
            self.assertEqual(result['instanceId'], self.life['instanceId'])
            spawn.assert_not_called()

    def test_each_fresh_start_uses_new_uuid(self):
        with patch.object(runtime, 'config', return_value=self.cfg), \
             patch.object(runtime, 'load_lifecycle', return_value=None), \
             patch.object(runtime, 'prepare_disk'), patch.object(runtime, 'spawn_gated'):
            first = runtime.transition('start', 12001, True)
            second = runtime.transition('start', 12001, True)
            self.assertNotEqual(first['instanceId'], second['instanceId'])

    def test_start_bootstraps_before_health_credential_exists(self):
        with patch.object(runtime, 'config', return_value=self.cfg), \
             patch.object(runtime, 'load_lifecycle', return_value=None), \
             patch.object(runtime, 'prepare_disk'), patch.object(runtime, 'spawn_gated') as spawn, \
             patch.object(runtime, 'lecturn_health') as health:
            self.assertFalse((self.state / 'runtime.json').exists())
            self.assertEqual(runtime.transition('start', 12001, True)['status'], 'starting')
            spawn.assert_called_once()
            health.assert_not_called()

    def test_missing_health_token_does_not_connect_or_ack_ready(self):
        with patch.object(runtime, 'read_json', side_effect=FileNotFoundError), \
             patch.object(runtime.http.client, 'HTTPConnection') as connect:
            self.assertFalse(runtime.lecturn_health())
            connect.assert_not_called()

    def test_guest_provisioning_failure_is_error_not_starting(self):
        with patch.object(runtime, 'ssh_args', return_value=['ssh']), \
             patch.object(runtime.subprocess, 'run', return_value=Mock(returncode=20)), \
             patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'spawn_gated') as spawn:
            with self.assertRaisesRegex(runtime.Fault, 'guest provisioning failed'):
                runtime.observe(self.life, 12001, True)
            spawn.assert_not_called()

    def test_guest_pending_or_ssh_unavailable_is_not_ready(self):
        for code in [21, 255, 1]:
            with self.subTest(code=code), patch.object(runtime, 'ssh_args', return_value=['ssh']), \
                 patch.object(runtime.subprocess, 'run', return_value=Mock(returncode=code)):
                self.assertFalse(runtime.guest_health())

    def test_gate_opens_only_after_durable_capture(self):
        events = []
        child = Mock(pid=220)
        child.stdin.write.side_effect = lambda _: events.append('release')
        with patch.object(runtime.subprocess, 'Popen', return_value=child) as popen, \
             patch.object(runtime, 'identity', return_value=self.record), \
             patch.object(runtime, 'atomic_json', side_effect=lambda *_: events.append('persist')):
            runtime.spawn_gated(['/fixed/helper'], self.life, 'qemu')
            self.assertEqual(events, ['persist', 'release'])
            self.assertTrue(popen.call_args.kwargs['close_fds'])
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
            self.assertIsNotNone(popen.call_args.kwargs['stdout'])

    def test_persistence_failure_kills_only_unreleased_direct_child(self):
        child = Mock(pid=220)
        with patch.object(runtime.subprocess, 'Popen', return_value=child), \
             patch.object(runtime, 'identity', return_value=self.record), \
             patch.object(runtime, 'atomic_json', side_effect=OSError('disk')):
            with self.assertRaises(OSError):
                runtime.spawn_gated(['/fixed/helper'], self.life, 'qemu')
            child.stdin.write.assert_not_called()
            child.kill.assert_called_once()
            child.wait.assert_called_once()

    def test_foreign_qmp_peer_rejected_before_command(self):
        sock = Mock()
        sock.__enter__ = Mock(return_value=sock)
        sock.__exit__ = Mock(return_value=False)
        sock.getsockopt.return_value = struct.pack('3i', 999, 12001, 12001)
        with patch.object(runtime.socket, 'SO_PEERCRED', 17, create=True), \
             patch.object(runtime.socket, 'socket', return_value=sock), patch.object(runtime, 'alive', return_value=True):
            with self.assertRaisesRegex(runtime.Fault, 'foreign QMP'):
                runtime.qmp(self.record, 'system_powerdown')
            sock.makefile.assert_not_called()

    def test_untracked_socket_does_not_ack_stopped(self):
        (self.vm / 'run/qmp.sock').touch()
        with self.assertRaisesRegex(runtime.Fault, 'untracked'):
            runtime.stop(None)

    def test_shutdown_timeout_preserves_state_and_does_not_kill_vm(self):
        (self.state / 'lifecycle.json').write_text('retained')
        with patch.object(runtime, 'alive', return_value=True), patch.object(runtime, 'qmp'), \
             patch.object(runtime.time, 'monotonic', side_effect=[0, 18]), \
             patch.object(runtime, 'signal_owned') as signal_owned:
            with self.assertRaisesRegex(runtime.Fault, 'shutdown deadline'):
                runtime.stop(self.life)
            self.assertTrue((self.state / 'lifecycle.json').exists())
            signal_owned.assert_not_called()

    def test_stop_waits_for_bridge_and_cleans_state_only_after_exit(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        (self.state / 'lifecycle.json').write_text('retained')
        (self.vm / 'run/qmp.sock').touch()
        with patch.object(runtime, 'alive', side_effect=[False, True, False, False]), \
             patch.object(runtime, 'signal_owned') as terminate:
            self.assertEqual(runtime.stop(self.life)['status'], 'stopped')
            terminate.assert_called_once_with(self.life['bridge'], runtime.signal.SIGTERM)
            self.assertFalse((self.state / 'lifecycle.json').exists())
            self.assertFalse((self.vm / 'run/qmp.sock').exists())

    def test_bridge_timeout_is_error(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', side_effect=[False, True, True, True]), \
             patch.object(runtime, 'signal_owned'), patch.object(runtime.time, 'monotonic', side_effect=[0, 3]):
            with self.assertRaisesRegex(runtime.Fault, 'bridge exit deadline'):
                runtime.stop(self.life)

    def test_cached_apk_cannot_be_ready(self):
        with patch.object(runtime, 'alive', return_value=True), patch.object(runtime, 'qmp') as qmp:
            result = runtime.observe(self.life, 12001, False)
            self.assertEqual(result['status'], 'error')
            qmp.assert_not_called()

    def test_dead_recorded_bridge_errors_before_guest_health_without_restart(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', side_effect=[True, False]) as alive, \
             patch.object(runtime, 'qmp') as qmp, \
             patch.object(runtime, 'guest_health', return_value=False) as guest, \
             patch.object(runtime, 'lecturn_health', return_value=True) as health, \
             patch.object(runtime, 'spawn_gated') as spawn:
            result = runtime.observe(self.life, 12001, True)
            self.assertEqual(result['status'], 'error')
            self.assertIn('agent bridge exited', result['message'])
            self.assertEqual([call.args[0] for call in alive.call_args_list], [self.record, self.life['bridge']])
            qmp.assert_not_called()
            guest.assert_not_called()
            health.assert_not_called()
            spawn.assert_not_called()

    def test_first_missing_bridge_starts_once_after_guest_ready(self):
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'guest_health', return_value=True) as guest, \
             patch.object(runtime, 'lecturn_health') as health, \
             patch.object(runtime, 'spawn_gated') as spawn:
            result = runtime.observe(self.life, 12001, True)
            self.assertEqual(result['status'], 'starting')
            guest.assert_called_once_with(require_bridge=False)
            spawn.assert_called_once_with(['/usr/bin/python3', '-I', runtime.__file__, '--bridge'], self.life, 'bridge')
            health.assert_not_called()

    def test_missing_bridge_waits_for_guest_without_spawning(self):
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'guest_health', return_value=False) as guest, \
             patch.object(runtime, 'spawn_gated') as spawn:
            self.assertEqual(runtime.observe(self.life, 12001, True)['status'], 'starting')
            guest.assert_called_once_with(require_bridge=False)
            spawn.assert_not_called()

    def test_healthy_vm_without_authenticated_shell_is_not_ready(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'guest_health', return_value=True), \
             patch.object(runtime.os.path, 'samefile', return_value=True), \
             patch.object(runtime, 'lecturn_health', return_value=False) as health:
            self.assertEqual(runtime.observe(self.life, 12001, True)['status'], 'starting')
            health.assert_called_once()

    def test_bridge_before_exec_does_not_report_ready(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'guest_health', return_value=True), \
             patch.object(runtime.os.path, 'samefile', return_value=False), \
             patch.object(runtime, 'lecturn_health') as health:
            self.assertEqual(runtime.observe(self.life, 12001, True)['status'], 'starting')
            health.assert_not_called()

    def test_changed_apk_uid_refuses_reuse(self):
        with self.assertRaisesRegex(runtime.Fault, 'UID changed'):
            runtime.observe(self.life, 12002, True)

    def test_credential_url_rejected_before_network(self):
        descriptor = {'schemaVersion': 1, 'uiUrl': 'http://127.0.0.1:3773/?token=secret', 'lecturnBearerToken': 'x' * 64}
        with patch.object(runtime, 'read_json', return_value=descriptor), \
             patch.object(runtime.http.client, 'HTTPConnection') as connect:
            with self.assertRaisesRegex(runtime.Fault, 'descriptor'):
                runtime.lecturn_health()
            connect.assert_not_called()

    def test_http_redirect_does_not_become_readiness(self):
        descriptor = {'schemaVersion': 1, 'uiUrl': 'http://127.0.0.1:3773', 'lecturnBearerToken': 'x' * 64}
        connection = Mock()
        connection.getresponse.return_value.status = 302
        with patch.object(runtime, 'read_json', return_value=descriptor), \
             patch.object(runtime.http.client, 'HTTPConnection', return_value=connection):
            self.assertFalse(runtime.lecturn_health())
            self.assertEqual(connection.request.call_count, 1)
            connection.close.assert_called_once()

    def test_lock_overlap_fails_before_transition(self):
        fake_stat = Mock(st_uid=0, st_mode=0o100600, st_nlink=1)
        with patch.object(runtime.os, 'getuid', return_value=0), \
             patch.object(runtime.sys, 'argv', ['controller', 'start', '12001', 'active']), \
             patch.object(runtime.os, 'fstat', return_value=fake_stat), \
             patch.object(runtime.fcntl, 'flock', side_effect=BlockingIOError), \
             patch.object(runtime, 'transition') as transition:
            with self.assertRaisesRegex(runtime.Fault, 'busy'):
                runtime.main()
            transition.assert_not_called()

    def test_ready_requires_every_fresh_health_check(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}) as qmp, \
             patch.object(runtime, 'guest_health', return_value=True) as guest, \
             patch.object(runtime.os.path, 'samefile', return_value=True), \
             patch.object(runtime, 'lecturn_health', return_value=True) as health:
            self.assertEqual(runtime.observe(self.life, 12001, True)['status'], 'ready')
            qmp.assert_called_once()
            guest.assert_called_once_with(require_bridge=True)
            health.assert_called_once()

    def test_guest_ssh_failure_clears_ready_without_cached_success(self):
        self.life['bridge'] = {**self.record, 'pid': 221}
        with patch.object(runtime, 'alive', return_value=True), \
             patch.object(runtime, 'qmp', return_value={'status': 'running'}), \
             patch.object(runtime, 'guest_health', return_value=False), \
             patch.object(runtime, 'lecturn_health') as health:
            self.assertEqual(runtime.observe(self.life, 12001, True)['status'], 'starting')
            health.assert_not_called()

    def test_qmp_ack_is_not_a_shutdown_ack(self):
        (self.state / 'lifecycle.json').write_text('retained')
        with patch.object(runtime, 'alive', side_effect=[True, False, False]), \
             patch.object(runtime, 'qmp', return_value={}) as qmp:
            self.assertEqual(runtime.stop(self.life)['status'], 'stopped')
            qmp.assert_called_once_with(self.record, 'system_powerdown')

    def test_invalid_lifecycle_cannot_signal_arbitrary_pid(self):
        for record in [{**self.record, 'pid': 1}, {**self.record, 'pid': '220'}, {'pid': 220}]:
            with patch.object(runtime, 'read_json', return_value={**self.life, 'qemu': record}):
                with self.assertRaises(runtime.Fault):
                    runtime.load_lifecycle()

    def test_bundle_forbids_guest_and_android_data_paths(self):
        import tarfile
        for name in ['../data/data/app/file', '/data/data/file', 'host/etc/shadow', 'state/runtime.json']:
            with self.subTest(name=name):
                archive = self.root / 'bad.tar'
                with tarfile.open(archive, 'w') as tar:
                    info = tarfile.TarInfo(name)
                    info.mode = 0o600
                    info.size = 1
                    tar.addfile(info, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    installer.validate_bundle(archive)


if __name__ == '__main__':
    unittest.main()
