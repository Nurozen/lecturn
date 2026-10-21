#!/usr/bin/env bash

set -euo pipefail

usage() {
  {
    echo "Usage:"
    echo "  $0 <server-port> <base-dir> <mobile-origin> <agent-device-command> <target-args...>"
    echo "  $0 <ios|android> <device-id> <server-port> <base-dir> [url-scheme]"
  } >&2
  exit 2
}

[[ $# -ge 4 ]] || usage

url_scheme="lecturn-dev"
app_id="com.cloudgatherer.lecturn.dev"
mode="agent-device"

case "$1" in
  ios | android)
    # Fallback for hosts without Lecturn's device tools: drive simctl/adb directly.
    [[ $# -le 5 ]] || usage
    mode="$1"
    device_id="$2"
    server_port="$3"
    base_dir="$4"
    url_scheme="${5:-lecturn-dev}"
    if [[ "$mode" == "ios" ]]; then
      mobile_origin="http://127.0.0.1:${server_port}"
    else
      mobile_origin="http://10.0.2.2:${server_port}"
    fi
    ;;
  *)
    [[ $# -ge 5 ]] || usage
    server_port="$1"
    base_dir="$2"
    mobile_origin="$3"
    agent_device_command="$4"
    shift 4
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! pairing_output="$({
  LECTURN_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "$mobile_origin" \
    --ttl 15m \
    --label "agent-mobile"
} 2>&1)"; then
  echo "Could not mint a mobile pairing credential." >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
if [[ -z "$pairing_url" ]]; then
  echo "Could not parse the mobile pairing URL." >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" URL_SCHEME="$url_scheme" node - <<'NODE'
const query = new URLSearchParams({
  pairingUrl: process.env.PAIRING_URL,
  autoConnect: "1",
});
process.stdout.write(`${process.env.URL_SCHEME}://connections/new?${query}`);
NODE
)"

case "$mode" in
  agent-device)
    if ! "$agent_device_command" open "$app_id" "$deep_link" "$@" >/dev/null 2>&1; then
      echo "AgentDevice could not open the pairing route. Check the Device panel and retry with a fresh credential." >&2
      exit 1
    fi
    ;;
  ios)
    xcrun simctl openurl "$device_id" "$deep_link"
    ;;
  android)
    # adb shell re-joins its arguments and evaluates them through the device
    # shell, so the deep link's `?`/`&` must be quoted once more for that shell.
    adb -s "$device_id" shell \
      "am start -W -a android.intent.action.VIEW -d '$deep_link' $app_id" \
      >/dev/null
    ;;
esac

echo "Opened the existing Add Environment route with a fresh pairing credential."
