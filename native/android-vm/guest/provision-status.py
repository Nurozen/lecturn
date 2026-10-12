#!/usr/bin/python3
"""Fixed SSH health predicate. Exit 20 means failed; 21 means still pending."""
import os
from pathlib import Path
import stat
import sys


def trusted(path, directory=False):
    s = path.lstat()
    return (s.st_uid == 0 and not s.st_mode & 0o022 and
            (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1))


def status(root=Path('/')):
    directory = root / 'var/lib/symba-provision'
    if directory.exists():
        if not trusted(directory, directory=True):
            return 20
        if (directory / 'failed').exists():
            return 20
        if (directory / 'ready').exists():
            return 0 if trusted(directory / 'ready') else 20
    # cloud-init completion is never proof that the provisioning command succeeded.
    if (root / 'var/lib/cloud/instance/boot-finished').exists():
        return 20
    return 21


if __name__ == '__main__':
    sys.exit(status() if os.getuid() != 0 else 20)
