#!/usr/bin/python3
"""Offline guest qualification: real Codex sandbox plus bubblewrap prerequisites."""
import json
import os
from pathlib import Path
import subprocess
import tempfile


PROBE = '''
import errno, os, pathlib, sys
p = pathlib.Path(sys.argv[1])
assert p.read_text() == 'sandbox fixture'
try:
    p.write_text('sandbox failed')
except OSError as e:
    assert e.errno in (errno.EACCES, errno.EPERM, errno.EROFS)
else:
    raise SystemExit('sandbox allowed a denied write')
print('write-denied')
'''


def check():
    if os.getuid() == 0:
        raise RuntimeError('sandbox probe must be nonroot')
    with tempfile.TemporaryDirectory(prefix='symba-sandbox-') as temp:
        root = Path(temp)
        fixture = root / 'fixture'
        fixture.write_text('sandbox fixture')
        (root / 'codex').mkdir()
        env = {'HOME': temp, 'CODEX_HOME': str(root / 'codex'), 'PATH': '/usr/local/bin:/usr/bin:/bin'}
        commands = {
            'bubblewrap': ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
                           '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev'],
            # 0.160.1 selects the host sandbox; it has no 'linux' subcommand.
            'codex': ['/usr/local/bin/codex', 'sandbox', '-c', 'sandbox_mode="read-only"', '--'],
        }
        for name, command in commands.items():
            result = subprocess.run(command + ['/usr/bin/python3', '-c', PROBE, str(fixture)],
                                    cwd=temp, env=env, capture_output=True, text=True, timeout=60, check=True)
            if result.stdout.strip() != 'write-denied' or fixture.read_text() != 'sandbox fixture':
                raise RuntimeError(name + ' sandbox probe failed')
        return {'schemaVersion': 1, 'uid': os.getuid(), 'codexReadOnly': True,
                'bubblewrapReadOnly': True, 'claudeLiveSandbox': 'requires-parent-qualification'}


if __name__ == '__main__':
    print(json.dumps(check()))
