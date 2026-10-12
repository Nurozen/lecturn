#!/usr/bin/python3
"""Parent-invoked, first-install-only seed builder INSIDE the ARM64 host chroot.
Never imports old SSH/provider credentials. Refuses to replace persistent disks.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import tempfile
import uuid


def run(args):
    subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=60,
                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sources', type=Path, required=True, help='root-owned android-vm source package')
    parser.add_argument('--downloads', type=Path, required=True, help='root-owned pinned ARM64 artifacts')
    parser.add_argument('--allow-guest-sudo', action='store_true')
    args = parser.parse_args()
    if os.getuid() != 0 or platform.machine() != 'aarch64' or not Path('/run/symba-state/config.json').is_file():
        raise SystemExit('requires prepared ARM64 host chroot and root controller state')
    os.umask(0o077)
    vm, state = Path('/opt/vm'), Path('/run/symba-state')
    for path in [vm / 'guest.qcow2', vm / 'base.qcow2', vm / 'seed.iso', state / 'ssh-key', state / 'agent-token']:
        if path.exists() or path.is_symlink():
            raise SystemExit('fresh seed only; parent must reconcile existing media explicitly')
    pins = json.loads((args.sources / 'pins.json').read_text())
    for name in ['rootfs', 'cloud', 'node']:
        pin = pins[name]
        with (args.downloads / pin['file']).open('rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != pin['sha256']:
                raise SystemExit('artifact checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='symba-seed-', dir=state) as temp:
        stage = Path(temp)
        payload = stage / 'payload'
        payload.mkdir()
        for name in ['setup.sh', 'lecturn.service', 'sshd.conf', 'package.json', 'package-lock.json', 'verify-npm.py', '60-symba-userns.conf', 'provision-status.py', 'check-sandbox.py']:
            shutil.copyfile(args.sources / 'guest' / name, payload / name)
        shutil.copyfile(args.sources / 'pins.json', payload / 'pins.json')
        shutil.copyfile(args.downloads / pins['node']['file'], payload / pins['node']['file'])
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(stage / 'ssh-key')])
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(stage / 'guest-host-key')])
        agent_token = secrets.token_hex(32) + '\n'
        (payload / 'agent-token').write_text(agent_token)
        # Restrict forwarding independently of any optional guest sudo permission.
        public_key = (stage / 'ssh-key.pub').read_text().strip()
        (payload / 'authorized_keys').write_text('no-agent-forwarding,no-X11-forwarding,no-pty,permitlisten="127.0.0.1:18769" ' + public_key + '\n')
        if args.allow_guest_sudo:
            (payload / 'allow-guest-sudo').touch()
        host_private = base64.b64encode((stage / 'guest-host-key').read_bytes()).decode()
        host_public = (stage / 'guest-host-key.pub').read_text().strip()
        # JSON is valid YAML; only the generated guest host key enters cloud-init.
        userdata = {
            'users': [{'name': 'lecturn', 'lock_passwd': True, 'shell': '/bin/bash',
                       **({'sudo': 'ALL=(ALL) NOPASSWD:ALL'} if args.allow_guest_sudo else {}),
                       'ssh_authorized_keys': [(payload / 'authorized_keys').read_text().strip()]}],
            'disable_root': True, 'ssh_pwauth': False, 'ssh_deletekeys': False,
            'write_files': [{'path': '/etc/ssh/ssh_host_ed25519_key', 'permissions': '0600',
                             'encoding': 'b64', 'content': host_private},
                            {'path': '/etc/ssh/ssh_host_ed25519_key.pub', 'permissions': '0644', 'content': host_public + '\n'},
                            {'path': '/usr/local/libexec/symba-provision-status', 'permissions': '0755',
                             'content': (payload / 'provision-status.py').read_text()}],
            'runcmd': [['bash', '-ceu',
                        'mkdir -p /mnt/symba-seed /opt/symba-bootstrap; '
                        'mount -o ro /dev/disk/by-label/cidata /mnt/symba-seed; '
                        'cp -a /mnt/symba-seed/payload/. /opt/symba-bootstrap/; '
                        'exec bash /opt/symba-bootstrap/setup.sh']]
        }
        (stage / 'user-data').write_text('#cloud-config\n' + json.dumps(userdata))
        (stage / 'meta-data').write_text(json.dumps({'instance-id': 'symba-' + str(uuid.uuid4()), 'local-hostname': 'lecturn-guest'}))
        # Only payload + cloud-init files go onto guest media; host admin key stays outside.
        run(['/usr/bin/genisoimage', '-quiet', '-output', str(stage / 'seed.iso'), '-volid', 'cidata',
             '-joliet', '-rock', '-graft-points', 'user-data=' + str(stage / 'user-data'),
             'meta-data=' + str(stage / 'meta-data'), 'payload=' + str(payload)])
        shutil.copyfile(args.downloads / pins['cloud']['file'], vm / 'base.qcow2')
        run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', '/opt/vm/base.qcow2', str(vm / 'guest.qcow2'), '24G'])
        shutil.copyfile(stage / 'seed.iso', vm / 'seed.iso')
        (vm / 'console.log').touch()
        shutil.copyfile(stage / 'ssh-key', state / 'ssh-key')
        (state / 'known_hosts').write_text('[127.0.0.1]:18722 ' + host_public + '\n')
        (state / 'agent-token').write_text(agent_token)
        (vm / 'base.qcow2').chmod(0o444)
    print('Fresh seed staged. No VM started; no provider credentials imported.')


if __name__ == '__main__':
    main()
