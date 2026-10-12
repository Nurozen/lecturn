#!/usr/bin/env python3
"""Candidate parent-operated installer. Merely building this package never uses ADB."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

EXPECTED_FILES = {
    'bin/runtime-control', 'host/usr/local/libexec/runtime-helper',
    'host/usr/local/libexec/runtime_controller.py',
    'host/usr/local/share/symba-runtime/fwmark.c',
    'host/usr/local/share/symba-runtime/host-setup.sh',
    'host/usr/local/share/symba-runtime/pins.json', 'manifest.json',
    'host/usr/local/share/symba-runtime/guest-seed.py',
    'host/usr/local/share/symba-runtime/guest/setup.sh',
    'host/usr/local/share/symba-runtime/guest/lecturn.service',
    'host/usr/local/share/symba-runtime/guest/sshd.conf',
    'host/usr/local/share/symba-runtime/guest/package.json',
    'host/usr/local/share/symba-runtime/guest/package-lock.json',
    'host/usr/local/share/symba-runtime/guest/verify-npm.py',
    'host/usr/local/share/symba-runtime/guest/60-symba-userns.conf',
    'host/usr/local/share/symba-runtime/guest/provision-status.py',
    'host/usr/local/share/symba-runtime/guest/check-sandbox.py',
}


def validate_bundle(path):
    raw = path.read_bytes()
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)):
            raise ValueError('duplicate archive entry')
        files = set()
        for m in members:
            if m.name.startswith('/') or '..' in Path(m.name).parts or m.uid != 0 or m.gid != 0 or m.mode & 0o7022:
                raise ValueError('unsafe archive metadata')
            if m.isdir():
                if not any(name.startswith(m.name + '/') for name in EXPECTED_FILES):
                    raise ValueError('out-of-scope directory')
            elif m.isfile() and m.name in EXPECTED_FILES:
                files.add(m.name)
            else:
                raise ValueError('out-of-scope archive member')
        if files != EXPECTED_FILES:
            raise ValueError('incomplete bundle')
        manifest = json.load(tar.extractfile('manifest.json'))
        if set(manifest) != EXPECTED_FILES - {'manifest.json'}:
            raise ValueError('invalid bundle manifest')
        for name, digest in manifest.items():
            if hashlib.sha256(tar.extractfile(name).read()).hexdigest() != digest:
                raise ValueError('bundle checksum mismatch')
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--expected-fingerprint', required=True)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--adoption-descriptor', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9._:-]+', args.serial):
        raise SystemExit('invalid explicit serial')
    digest = validate_bundle(args.bundle)
    descriptor = json.loads(args.adoption_descriptor.read_text())
    if descriptor.get('operation') != 'parent-owned-cold-move' or descriptor.get('destination') != '/data/local/symba-runtime/host' or descriptor.get('requiresNoProcessesOrMountsBelowSource') is not True or descriptor.get('requiresStoppedProbeVM') is not True:
        raise SystemExit('invalid cold adoption descriptor')
    # Reuse runtime schema validation against the supplied candidate, without root/device I/O.
    import importlib.util
    spec = importlib.util.spec_from_file_location('runtime_controller', Path(__file__).parents[1] / 'controller/runtime_controller.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.read_json = lambda _: json.loads(args.config.read_text())
    module.config()
    def adb(*parts, input=None):
        return subprocess.run(['adb', '-s', args.serial, *parts], input=input, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=60, check=True).stdout.decode().strip()
    if adb('get-state') != 'device' or adb('shell', 'getprop ro.product.device') != 'kodiak' or adb('shell', 'getprop ro.product.cpu.abi') != 'arm64-v8a' or adb('shell', 'getprop ro.build.fingerprint') != args.expected_fingerprint:
        raise SystemExit('serial/model/ABI/fingerprint mismatch')
    if adb('shell', 'id -u') != '0':
        raise SystemExit('parent must provide an already authorized root transport')
    # No adoption/move here: the parent owns shutting down probes and moving the rootfs.
    check = '''set -eu
[ -d /data/local/symba-runtime/host ]
[ ! -L /data/local/symba-runtime ]
[ ! -L /data/local/symba-runtime/host ]
[ ! -e /data/local/symba-runtime/bin/runtime-control ]
[ ! -e /data/local/symba-runtime/state/lifecycle.json ]
[ ! -e /data/local/symba-runtime/host/opt/vm/qemu.pid ]
[ ! -e /data/local/symba-runtime/host/opt/vm/qmp.sock ]
[ ! -e /data/local/symba-runtime/host/opt/vm/run/qmp.sock ]
[ "$(stat -c %u /data/local/symba-runtime)" = 0 ]
[ "$(stat -c %a /data/local/symba-runtime)" = 700 ]
'''
    # Check every extraction ancestor before tar can follow an adopted rootfs link.
    ancestors = set()
    for target in EXPECTED_FILES:
        for parent in Path(target).parents:
            if str(parent) != '.':
                ancestors.add(str(parent))
    for parent in sorted(ancestors):
        absolute = '/data/local/symba-runtime/' + parent
        check += f'if [ -e {absolute} ] || [ -L {absolute} ]; then [ -d {absolute} ] && [ ! -L {absolute} ] && [ "$(stat -c %u {absolute})" = 0 ] && [ $((8#$(stat -c %a {absolute}) & 8#22)) = 0 ]; fi\n'
    for target in sorted(EXPECTED_FILES):
        absolute = '/data/local/symba-runtime/' + target
        check += f'[ ! -e {absolute} ] && [ ! -L {absolute} ]\n'
    adb('shell', check)
    # Stage in the root-only destination; no guest/app-writable /data/local/tmp input.
    adb('push', str(args.bundle), '/data/local/symba-runtime/install.tar')
    actual = adb('shell', 'sha256sum /data/local/symba-runtime/install.tar').split()[0]
    if actual != digest:
        raise SystemExit('uploaded bundle checksum mismatch')
    adb('push', str(args.config), '/data/local/symba-runtime/config.candidate.json')
    adb('shell', '''set -eu
cd /data/local/symba-runtime
umask 077
mkdir -p bin state host/run/symba-state
chmod 700 bin state host/run/symba-state
# Fresh install only. Parent must audit the adopted rootfs for root ownership and links first.
tar -xf install.tar
cp config.candidate.json state/config.json
chown 0:0 state/config.json
chmod 600 state/config.json
rm install.tar config.candidate.json
''')
    print('Candidate installed cold; host glibc setup, guest setup, authentication and live qualification remain parent-owned.')


if __name__ == '__main__':
    main()
