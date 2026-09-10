# Upstream integration (fork)

Lecturn integrates upstream through sequential, reviewed checkpoint PRs. The
current runbook is [Integrating upstream in reviewable batches](upstream-batches.md).

`t3mirror` remains a pristine reference to `pingdotgg/t3code` main. The mirror
updater never merges into Lecturn main. Local integration uses a fresh Stave
space and new Codex agents for each checkpoint, preserves real merge ancestry,
and automatically merges only after independent review and protected CI pass.

The whole-mirror `integrate-local.sh` driver is retired and exits without changes.
`upstream-integrate.yml` is now a manual informational workflow; it cannot launch
an integration, resolve conflicts, or publish a branch. The launchd template
runs the sequential controller every three hours once the operator has completed
and verified the initial catch-up. Do not reinstall an older nightly template.

Recurring fork decisions live in
[RESOLUTION_GUIDE.md](../../.github/upstream-integration/RESOLUTION_GUIDE.md).
