"""Verify the pinned install and retained lock, without executing package code."""
import json
from pathlib import Path


def verify(root, pins):
    package = json.loads((root / 'package.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    if package['dependencies'] != pins['npm'] or package['overrides'] != pins['npmOverrides']:
        raise ValueError('npm manifest does not match pins')
    if lock['lockfileVersion'] != 3 or lock['packages']['']['dependencies'] != pins['npm']:
        raise ValueError('npm lock does not match pins')
    versions = {**pins['npm'], **pins['npmOverrides'], 'effect': '4.0.0-beta.103',
                '@effect/platform-node': '4.0.0-beta.103', '@effect/platform-bun': '4.0.0-beta.103',
                '@openai/codex-linux-arm64': pins['npm']['@openai/codex'] + '-linux-arm64',
                '@anthropic-ai/claude-code-linux-arm64': pins['npm']['@anthropic-ai/claude-code']}
    for name, version in versions.items():
        key = 'node_modules/' + name
        installed = json.loads((root / key / 'package.json').read_text())
        if installed['version'] != version or lock['packages'][key]['version'] != version:
            raise ValueError('npm installed version or lock mismatch: ' + name)
    for key, value in lock['packages'].items():
        if key.endswith('/@effect/platform-node-shared') and value['version'] != pins['npmOverrides']['@effect/platform-node-shared']:
            raise ValueError('incompatible nested Effect platform package')


if __name__ == '__main__':
    verify(Path('/opt/lecturn-tools'), json.loads(Path('/opt/symba-bootstrap/pins.json').read_text()))
