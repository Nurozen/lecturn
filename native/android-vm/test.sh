#!/usr/bin/env bash
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
python3 -m unittest discover -s "$here/tests" -v
python3 - "$here" <<'PY'
from pathlib import Path
import sys
for directory in ['guest', 'provision', 'controller']:
    for path in (Path(sys.argv[1]) / directory).glob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
PY
for script in "$here/build.sh" "$here/guest/setup.sh" "$here/provision/host-setup.sh"; do
  bash -n "$script"
done
