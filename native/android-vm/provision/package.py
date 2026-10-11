"""Make an inspectable package; no downloads, keys, device access or execution."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile


def build(here, out):
    root = out / 'package'
    if root.exists():
        shutil.rmtree(root)
    files = {
        out / 'runtime-control': 'bin/runtime-control',
        out / 'runtime-helper': 'host/usr/local/libexec/runtime-helper',
        here / 'controller/runtime_controller.py': 'host/usr/local/libexec/runtime_controller.py',
        here / 'native/fwmark.c': 'host/usr/local/share/symba-runtime/fwmark.c',
        here / 'provision/host-setup.sh': 'host/usr/local/share/symba-runtime/host-setup.sh',
        here / 'pins.json': 'host/usr/local/share/symba-runtime/pins.json',
    }
    for name in ['setup.sh', 'lecturn.service', 'sshd.conf', 'package.json', 'package-lock.json', 'verify-npm.py', '60-symba-userns.conf', 'provision-status.py', 'check-sandbox.py']:
        files[here / 'guest' / name] = 'host/usr/local/share/symba-runtime/guest/' + name
    files[here / 'provision/guest-seed.py'] = 'host/usr/local/share/symba-runtime/guest-seed.py'
    for source, target in files.items():
        dest = root / target
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        dest.chmod(0o755 if source.name in ('runtime-control', 'runtime-helper', 'host-setup.sh') else 0o644)
    manifest = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(root.rglob('*')) if p.is_file()}
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with tarfile.open(out / 'runtime-package.tar', 'w') as archive:
        for p in sorted(root.rglob('*')):
            info = archive.gettarinfo(p, arcname=str(p.relative_to(root)))
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.mtime = 0
            if p.is_dir():
                info.mode = 0o755
            if p.is_file():
                with p.open('rb') as f:
                    archive.addfile(info, f)
            else:
                archive.addfile(info)
    (out / 'runtime-package.sha256').write_text(hashlib.sha256((out / 'runtime-package.tar').read_bytes()).hexdigest() + '  runtime-package.tar\n')


if __name__ == '__main__':
    build(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
