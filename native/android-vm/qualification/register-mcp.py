#!/usr/bin/env python3
"""Print later guest registration commands; --apply is for the parent in the fresh guest only."""
import argparse
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys

HOME = Path('/home/lecturn')
CLIENT = str(HOME / '.config/symba/mobile_mcp.py')
TOKEN = str(HOME / '.config/symba/agent-token')
COMMANDS = [
    ['/usr/local/bin/codex', 'mcp', 'add', 'symba-mobile', '--', '/usr/bin/python3', CLIENT, '--token-file', TOKEN],
    ['/usr/local/bin/claude', 'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
     'symba-mobile', '--', '/usr/bin/python3', CLIENT, '--token-file', TOKEN],
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    for command in COMMANDS:
        print(shlex.join(command), flush=True)
    if not args.apply:
        return
    if sys.platform != 'linux' or os.getuid() != 1000 or os.geteuid() != 1000:
        raise SystemExit('Apply only as guest UID 1000, never root')
    # Existence-only guard; never read credentials. Stop instead of merging an existing profile.
    for path in [HOME / '.codex/config.toml', HOME / '.codex/auth.json',
                 HOME / '.claude.json', HOME / '.claude/.credentials.json',
                 HOME / '.claude/settings.json', HOME / '.claude/settings.local.json']:
        if path.exists():
            raise SystemExit(f'Requires fresh normal-user provider configuration; already exists: {path}')
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(HOME),
           'CODEX_HOME': str(HOME / '.codex'),
           'XDG_CONFIG_HOME': str(HOME / '.config'), 'DISABLE_AUTOUPDATER': '1',
           'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    os.umask(0o077)
    (HOME / '.codex').mkdir(exist_ok=True)
    for command in COMMANDS:
        process = subprocess.Popen(command, cwd=HOME, env=env, start_new_session=True)
        print(f'Captured registration PID {process.pid}', flush=True)
        def cancel(signum, _frame):
            raise SystemExit(128 + signum)
        signal.signal(signal.SIGTERM, cancel)
        signal.signal(signal.SIGINT, cancel)
        try:
            process.wait(timeout=20)
            if process.returncode:
                raise SystemExit(f'Registration failed with {process.returncode}; no fallback; inspect partial config')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=2)


if __name__ == '__main__':
    main()
