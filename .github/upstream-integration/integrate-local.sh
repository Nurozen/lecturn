#!/usr/bin/env bash
# Retired deliberately: never let an old launchd job invoke the whole-mirror resolver.
set -euo pipefail
printf '%s\n' 'The whole-mirror integration driver is retired.' \
  'Use run-batches.py with an external state directory; see docs/operations/upstream-batches.md.' >&2
exit 64
