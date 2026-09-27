"""Extract an explicitly pinned helper artifact without copying private source or paths."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--commit', required=True)
parser.add_argument('--team', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{64}', args.sha256) or not re.fullmatch(r'[a-f0-9]{40}', args.commit) or not re.fullmatch(r'[A-Z0-9]{10}', args.team):
    raise SystemExit('Invalid immutable helper artifact pin.')
if args.archive.stat().st_size > 256 * 1024 * 1024 or hashlib.sha256(args.archive.read_bytes()).hexdigest() != args.sha256:
    raise SystemExit('Private helper artifact digest mismatch.')
allowed = {'LICENSE.txt', 'NOTICE.txt'} | {f'{platform}/{name}' for platform in ['darwin-arm64', 'darwin-x64'] for name in ['manifest.json', 'lecturn-extensions-helper']}
with zipfile.ZipFile(args.archive) as archive:
    files = [entry for entry in archive.infolist() if not entry.is_dir()]
    if len({entry.filename for entry in files}) != len(files) or any(entry.filename not in allowed for entry in files):
        raise SystemExit('Unexpected artifact contents; private source must never be packaged.')
    if sum(entry.file_size for entry in files) > 256 * 1024 * 1024:
        raise SystemExit('Unpacked artifact too large.')
    for entry in files:
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise SystemExit('Symlinks are not permitted in helper artifacts.')
    for platform in ['darwin-arm64', 'darwin-x64']:
        manifest = json.loads(archive.read(f'{platform}/manifest.json'))
        binary = archive.read(f'{platform}/lecturn-extensions-helper')
        if manifest.get('protocolVersion') != 1 or manifest.get('platform') != platform or manifest.get('buildVersion') != args.commit or manifest.get('signerTeamId') != args.team or manifest.get('sha256') != hashlib.sha256(binary).hexdigest():
            raise SystemExit('Helper manifest does not match the trusted release pin.')
    args.output.mkdir(parents=True, exist_ok=False)
    for entry in files:
        destination = args.output / entry.filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(archive.read(entry))
        destination.chmod(0o755 if destination.name == 'lecturn-extensions-helper' else 0o644)
