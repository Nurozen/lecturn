#!/bin/sh
# Stand-in for the `stave` binary in StaveCli's real-process test.
#
# Reads stdin first: the server always writes "" and ends the pipe, so any
# byte on stdin means the spawn discipline broke (exit 99). Then records argv
# (one per line) to $FAKE_STAVE_ARGV_FILE when set, and answers according to
# $FAKE_STAVE_MODE:
#   json  - print $FAKE_STAVE_STDOUT, exit 0
#   error - print $FAKE_STAVE_STDOUT, exit 1
#   prose - print "hello" to stderr, exit 1
if [ -n "$(cat)" ]; then
  exit 99
fi

if [ -n "${FAKE_STAVE_ARGV_FILE:-}" ]; then
  : > "$FAKE_STAVE_ARGV_FILE"
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$FAKE_STAVE_ARGV_FILE"
  done
fi

case "${FAKE_STAVE_MODE:-json}" in
  json)
    printf '%s' "${FAKE_STAVE_STDOUT:-}"
    exit 0
    ;;
  error)
    printf '%s' "${FAKE_STAVE_STDOUT:-}"
    exit 1
    ;;
  prose)
    echo "hello" >&2
    exit 1
    ;;
  *)
    echo "unknown FAKE_STAVE_MODE: $FAKE_STAVE_MODE" >&2
    exit 2
    ;;
esac
