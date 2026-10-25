#!/bin/sh
# Stands in for the GitHub Copilot CLI during Bar captures: set its path as the
# Copilot binary path (Settings > Providers > GitHub Copilot) on an isolated
# fixture server. The mock ACP agent then answers in Copilot's profile, runs a
# tool call and leaves a permission request pending, which is the live approval
# card the baseline needs (seeded requests expire when the server restarts).
# Each LECTURN_ACP_* default can be overridden from the server's environment.
# Start the turn in Supervised mode (Full access never asks), and set
# "enableProviderUpdateChecks": false in settings.json: the mock's version is
# older than the latest CLI, and the update toast covers the capture.
set -eu

if [ "${1-}" = "--version" ]; then
  echo "GitHub Copilot CLI 1.0.88."
  exit 0
fi
if [ "${1-}" = "help" ]; then
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LECTURN_ACP_COPILOT=1
export LECTURN_ACP_EMIT_TOOL_CALLS="${LECTURN_ACP_EMIT_TOOL_CALLS-1}"
export LECTURN_ACP_PERMISSION_TITLE="${LECTURN_ACP_PERMISSION_TITLE-Run rw_simulate baseline}"
export LECTURN_ACP_HANG_AFTER_PERMISSION="${LECTURN_ACP_HANG_AFTER_PERMISSION-1}"
exec "${LECTURN_BAR_NODE:-node}" "$script_dir/../../apps/server/scripts/acp-mock-agent.ts" "$@"
