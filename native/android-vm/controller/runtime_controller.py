"""Root-only host controller. No guest input becomes a host command or path."""
import fcntl
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

STATE = Path('/run/symba-state')
VM = Path('/opt/vm')
PROC = Path('/proc')
SSH = '/usr/bin/ssh'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/root',
       'LD_PRELOAD': '/usr/local/lib/libsymba-fwmark.so'}


class Fault(Exception):
    pass


def trusted_file(path, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        s = os.fstat(f.fileno())
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o600 or s.st_nlink != 1:
            raise Fault('untrusted state file')
        data = f.read(limit + 1)
        if len(data) > limit:
            raise Fault('oversized state file')
        return data


def read_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Fault('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(trusted_file(path), object_pairs_hook=pairs)


def atomic_json(path, value):
    temp = path.with_suffix('.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def config():
    cfg = read_json(STATE / 'config.json')
    if set(cfg) != {'schemaVersion', 'memoryMiB', 'cpus', 'package', 'networkBoundary'} or type(cfg['schemaVersion']) is not int or cfg['schemaVersion'] != 1:
        raise Fault('invalid configuration fields')
    for key, low, high in [('memoryMiB', 512, 8192), ('cpus', 1, 8)]:
        if type(cfg[key]) is not int or not low <= cfg[key] <= high:
            raise Fault('invalid resource limit')
    if cfg['package'] != 'com.cloudgatherer.lecturn.symba':
        raise Fault('invalid package scope')
    if cfg['networkBoundary'] != 'authenticated-loopback-with-slirp-host-access':
        raise Fault('network boundary acknowledgement required')
    return cfg


def identity(pid):
    try:
        raw = (PROC / str(pid) / 'stat').read_text()
        fields = raw[raw.rindex(')') + 2:].split()
        if fields[0] == 'Z':
            return None
        return {'pid': pid, 'starttime': int(fields[19]),
                'bootId': (PROC / 'sys/kernel/random/boot_id').read_text().strip(),
                'mountNamespace': os.readlink(PROC / str(pid) / 'ns/mnt')}
    except (FileNotFoundError, ProcessLookupError):
        return None


def alive(record):
    current = identity(record['pid'])
    if current is None:
        return False
    if current != record:
        raise Fault('process provenance mismatch; refusing PID reuse')
    return True


def signal_owned(record, sig):
    # pidfd closes the identity-check/kill race. Never fall back to kill(pid).
    try:
        fd = os.pidfd_open(record['pid'])
    except ProcessLookupError:
        return
    try:
        if alive(record):
            signal.pidfd_send_signal(fd, sig)
    finally:
        os.close(fd)


def ssh_args():
    trusted_file(STATE / 'ssh-key', 16384)
    trusted_file(STATE / 'known_hosts', 16384)
    return [SSH, '-F', '/dev/null', '-p', '18722', '-i', str(STATE / 'ssh-key'),
            '-o', 'UserKnownHostsFile=' + str(STATE / 'known_hosts'),
            '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=2',
            '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=3',
            '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes',
            '-o', 'RequestTTY=no', '-o', 'ControlMaster=no', '-o', 'LogLevel=QUIET']


def qmp(record, command):
    if not alive(record):
        raise Fault('QEMU exited')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        sock.connect(str(VM / 'run/qmp.sock'))
        peer = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if peer[0] != record['pid'] or not alive(record):
            raise Fault('stale or foreign QMP socket')
        with sock.makefile('rwb', buffering=0) as stream:
            def receive():
                line = stream.readline(65537)
                if not line or len(line) > 65536:
                    raise Fault('invalid QMP response')
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise Fault('invalid QMP object')
                return value
            if 'QMP' not in receive():
                raise Fault('invalid QMP greeting')
            for name in ['qmp_capabilities', command]:
                stream.write(json.dumps({'execute': name, 'id': name}).encode() + b'\n')
                for _ in range(32):
                    reply = receive()
                    if reply.get('id') == name:
                        if 'return' not in reply:
                            raise Fault('QMP rejected command')
                        break
                else:
                    raise Fault('QMP response missing')
            if not isinstance(reply['return'], dict):
                raise Fault('invalid QMP result')
            return reply['return']


def load_lifecycle():
    try:
        value = read_json(STATE / 'lifecycle.json')
    except FileNotFoundError:
        return None
    if set(value) != {'instanceId', 'uid', 'qemu', 'bridge'}:
        raise Fault('invalid lifecycle state')
    if not isinstance(value['instanceId'], str):
        raise Fault('invalid runtime instance')
    uuid.UUID(value['instanceId'])
    if type(value['uid']) is not int or not 10000 <= value['uid'] < 100000:
        raise Fault('invalid lifecycle UID')
    for name in ['qemu', 'bridge']:
        record = value[name]
        if record is None and name == 'bridge':
            continue
        if not isinstance(record, dict) or set(record) != {'pid', 'starttime', 'bootId', 'mountNamespace'}:
            raise Fault('invalid process provenance')
        if type(record['pid']) is not int or record['pid'] <= 1 or type(record['starttime']) is not int:
            raise Fault('invalid process identity')
    return value


def spawn_gated(args, lifecycle, name):
    # Children inherit neither broker pipes nor the controller lock. No daemonize.
    with open('/dev/null', 'r+b', buffering=0) as null:
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=null, stderr=null,
                                 env=ENV, close_fds=True, start_new_session=True)
    try:
        record = identity(child.pid)
        if record is None:
            raise Fault('child exited before capture')
        lifecycle[name] = record
        atomic_json(STATE / 'lifecycle.json', lifecycle)
        child.stdin.write(b'G')
        child.stdin.flush()
    except BaseException:
        # This is our still-gated direct child; its PID cannot be reused before wait.
        child.kill()
        child.wait(timeout=2)
        raise
    finally:
        child.stdin.close()
    return child


def prepare_disk(uid):
    # QEMU gets writable media and its socket directory only, never the state dir.
    base = (VM / 'base.qcow2').lstat()
    if not stat.S_ISREG(base.st_mode) or base.st_uid != 0 or base.st_mode & 0o222 or base.st_nlink != 1:
        raise Fault('invalid immutable base image')
    for name in ['guest.qcow2', 'seed.iso', 'console.log']:
        path = VM / name
        fd = os.open(path, os.O_NOFOLLOW | os.O_CLOEXEC | os.O_RDWR)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid not in (0, uid):
                raise Fault('invalid VM media')
            os.fchown(fd, uid, uid)
            os.fchmod(fd, 0o400 if name == 'seed.iso' else 0o600)
        finally:
            os.close(fd)
    run = VM / 'run'
    run.mkdir(mode=0o700, exist_ok=True)
    s = run.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0, uid) or s.st_mode & 0o077:
        raise Fault('invalid QMP directory')
    os.chown(run, uid, uid)
    # A leftover socket without provenance is ambiguous. Never delete it automatically.
    if (run / 'qmp.sock').exists():
        raise Fault('stale QMP socket requires cold reconciliation')


def guest_health(require_bridge=False):
    command = ('test "$(id -u)" -ne 0 || exit 20; '
               'if [ -f /usr/local/libexec/symba-provision-status ]; then '
               'python3 /usr/local/libexec/symba-provision-status || exit $?; '
               'elif [ -e /var/lib/cloud/instance/boot-finished ]; then exit 20; '
               'else exit 21; fi; '
               'test "$(systemctl show lecturn.service -p User --value)" = lecturn && '
               'systemctl is-active --quiet lecturn.service')
    if require_bridge:
        command += " && python3 -c \"import socket; s=socket.create_connection(('127.0.0.1',18769),1); s.close()\""
    result = subprocess.run(ssh_args() + ['lecturn@127.0.0.1', command],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=ENV, timeout=4, check=False)
    if result.returncode == 20:
        raise Fault('guest provisioning failed; inspect guest /var/lib/symba-provision and cloud-init')
    return result.returncode == 0


def lecturn_health():
    try:
        value = read_json(STATE / 'runtime.json')
    except FileNotFoundError:
        # First boot must run the server before the parent can mint a real token.
        return False
    if set(value) != {'schemaVersion', 'uiUrl', 'lecturnBearerToken'} or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['uiUrl'] != 'http://127.0.0.1:3773':
        raise Fault('invalid broker runtime descriptor')
    token = value['lecturnBearerToken']
    if not isinstance(token, str) or not 16 <= len(token) <= 8192 or not token.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in token):
        raise Fault('invalid Lecturn credential shape')
    connection = http.client.HTTPConnection('127.0.0.1', 3773, timeout=2)
    try:
        connection.request('GET', '/api/orchestration/shell', headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        if response.status != 200:
            return False
        data = response.read(1048577)
        if len(data) > 1048576:
            return False
        shell = json.loads(data)
        return isinstance(shell, dict) and isinstance(shell.get('threads'), list) and isinstance(shell.get('projects'), list)
    finally:
        connection.close()


def answer(status, lifecycle=None, message=None):
    result = {'schemaVersion': 1, 'status': status}
    if lifecycle:
        result['instanceId'] = lifecycle['instanceId']
    if message:
        result['message'] = message
    return result


def observe(lifecycle, uid, active):
    if not lifecycle:
        if (VM / 'run/qmp.sock').exists():
            raise Fault('untracked QMP socket; cold reconciliation required')
        return answer('stopped')
    if lifecycle['uid'] != uid:
        raise Fault('APK UID changed; cold reconciliation required')
    if not alive(lifecycle['qemu']):
        return answer('error', lifecycle, 'VM exited; explicit stop then start required')
    if lifecycle['bridge'] is not None and not alive(lifecycle['bridge']):
        return answer('error', lifecycle, 'agent bridge exited; explicit stop then start required')
    if not active:
        return answer('error', lifecycle, 'APK foreground service required for network')
    try:
        if qmp(lifecycle['qemu'], 'query-status').get('status') != 'running':
            return answer('starting', lifecycle, 'VM is not running')
        if not guest_health(require_bridge=lifecycle['bridge'] is not None):
            return answer('starting', lifecycle, 'guest SSH or service is not ready')
        if lifecycle['bridge'] is None:
            spawn_gated(['/usr/bin/python3', '-I', __file__, '--bridge'], lifecycle, 'bridge')
            return answer('starting', lifecycle, 'agent bridge starting')
        # Separate mount namespaces can expose the host-prefixed /proc exe path.
        # Compare the executable inode rather than its rendered path.
        if not os.path.samefile(PROC / str(lifecycle['bridge']['pid']) / 'exe', SSH):
            return answer('starting', lifecycle, 'agent bridge handshake pending')
        if not lecturn_health():
            return answer('starting', lifecycle, 'authenticated Lecturn health pending')
        return answer('ready', lifecycle)
    except (OSError, subprocess.TimeoutExpired, ValueError, http.client.HTTPException):
        return answer('starting', lifecycle, 'fresh VM health pending')


def stop(lifecycle):
    if not lifecycle:
        return observe(None, 0, False)
    qemu = lifecycle['qemu']
    if alive(qemu):
        qmp(qemu, 'system_powerdown')
        deadline = time.monotonic() + 17
        while alive(qemu) and time.monotonic() < deadline:
            time.sleep(0.1)
        if alive(qemu):
            raise Fault('clean shutdown deadline; VM retained, no stopped acknowledgement')
    bridge = lifecycle['bridge']
    if bridge and alive(bridge):
        signal_owned(bridge, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while alive(bridge) and time.monotonic() < deadline:
            time.sleep(0.05)
        if alive(bridge):
            raise Fault('bridge exit deadline')
    # Only after ALL captured processes exit may the owned socket/state be removed.
    (VM / 'run/qmp.sock').unlink(missing_ok=True)
    (STATE / 'lifecycle.json').unlink()
    return answer('stopped')


def transition(command, uid, active):
    cfg = config()
    lifecycle = load_lifecycle()
    if command == 'stop':
        return stop(lifecycle)
    if command == 'start' and not lifecycle:
        if not active:
            raise Fault('APK foreground service required before start')
        prepare_disk(uid)
        lifecycle = {'instanceId': str(uuid.uuid4()), 'uid': uid, 'qemu': None, 'bridge': None}
        spawn_gated(['/usr/local/libexec/runtime-helper', '--qemu', str(uid),
                     str(cfg['memoryMiB']), str(cfg['cpus'])], lifecycle, 'qemu')
        return answer('starting', lifecycle)
    return observe(lifecycle, uid, active)


def main():
    if os.getuid() != 0:
        raise Fault('root controller required')
    if sys.argv[1:] == ['--bridge']:
        if sys.stdin.buffer.read(1) != b'G':
            raise Fault('bridge gate closed')
        fd = os.open('/dev/null', os.O_RDONLY)
        os.dup2(fd, 0)
        os.close(fd)
        args = ssh_args() + ['-N', '-R', '127.0.0.1:18769:127.0.0.1:18769', 'lecturn@127.0.0.1']
        os.execve(SSH, args, ENV)
    if len(sys.argv) != 4 or sys.argv[1] not in ('start', 'stop', 'status') or sys.argv[3] not in ('active', 'inactive'):
        raise Fault('invalid controller arguments')
    uid = int(sys.argv[2])
    if not (10000 <= uid < 100000 or (uid == 0 and sys.argv[1] == 'stop')):
        raise Fault('invalid application UID')
    fd = os.open(STATE / 'control.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        s = os.fstat(fd)
        if s.st_uid or stat.S_IMODE(s.st_mode) != 0o600 or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
            raise Fault('invalid lock file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Fault('runtime transition busy; retry') from None
        return transition(sys.argv[1], uid, sys.argv[3] == 'active')
    finally:
        os.close(fd)


def deadline(_signal, _frame):
    raise Fault('controller deadline')


if __name__ == '__main__':
    signal.signal(signal.SIGALRM, deadline)
    try:
        result = main()
    except Fault as error:
        result = answer('error', message=str(error))
    except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError,
            http.client.HTTPException, subprocess.SubprocessError):
        # Diagnostics are fixed and never include SSH output, URLs, or token content.
        result = answer('error', message='runtime validation or transition failed; reconcile local state')
    print(json.dumps(result, separators=(',', ':')), flush=True)
    sys.exit(1 if result['status'] == 'error' else 0)
