# Upstream integration (fork)

Lecturn is a fork of [T3 Code](https://github.com/pingdotgg/t3code) that has
diverged far enough that a plain `git merge` of upstream is no longer safe to
land unreviewed. The old auto-merging `upstream-sync.yml` is gone. In its place
the mirror is kept fresh in GitHub Actions and the integration itself runs on
your machine, inside a Stave space, as a PR you review.

## Where each half runs

**`t3mirror-sync.yml`, in GitHub Actions.** Nightly at 09:23 UTC (01:23
Anchorage), plus manual dispatch. Fetches `pingdotgg/t3code` main with
`--no-tags` and force-updates the `t3mirror` branch. It never touches `main`.
It stays in Actions because it has to be reliable, has no agent in it, and
costs nothing. Upstream tags are kept out because an upstream `v*` tag would
trigger this fork's release pipeline.

**`integrate-local.sh`, on your machine.** launchd fires it at 08:12 local. It
provisions a long-lived Stave space, merges `t3mirror` in, hands conflicts to
`claude -p`, then commits, pushes and opens the PR.

It runs locally for two reasons. Your Claude subscription covers it, where
nightly Opus on ~30 conflicted files through the API does not. More important,
the space has `node_modules`, so the merged tree gets `pnpm install` and
`vp run -r typecheck` before the PR opens and the result lands in the PR body.
The Actions job cannot do that; nothing installs dependencies there, so a
semantic break sits undetected until CI reports it the next morning.

The agent itself never executes anything, in either driver. Package managers,
test runners and network are outside its tool allowlist, because it spends the
whole run reading upstream content that anyone can author. The script does the
installing and typechecking, after the agent has finished and the merge state
has been checked.

**`upstream-integrate.yml`, in Actions, disabled.** The same flow using
`anthropics/claude-code-action@v1`. Keep it disabled in repository settings and
enable it when you are travelling and the laptop will not wake. It needs
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` before it will resolve
anything.

Both drivers hand the agent the same two files, which is where correctness
lives: [`PROMPT.md`](../../.github/upstream-integration/PROMPT.md) for the task
and [`RESOLUTION_GUIDE.md`](../../.github/upstream-integration/RESOLUTION_GUIDE.md)
for the fork's policy. The bash around them is duplicated between the workflow
and the script; the policy is not.

## The Stave space

The space is `lecturn-upstream`, kind `sync`, holding one editable `t3code`
worktree at `~/stave/agent-work/lecturn-upstream/t3code` on branch
`stave/lecturn-upstream/t3code`. The script creates it on first run:

```
stave space create --json -k sync \
  -e t3code:refs/remotes/fork/main lecturn-upstream
```

The base ref is fully qualified on purpose. Stave prefixes a bare base with
`origin/`, and on the shared bare repo `origin` is upstream `pingdotgg/t3code`
while the fork is the `fork` remote. `-e t3code:fork/main` would silently
resolve to `origin/fork/main` and fail. Anything starting with `refs/` is
passed through untouched.

The space is long-lived rather than created per night. A fresh one would re-pay
a full `pnpm install` every time, and those installed dependencies are the
entire reason the integration runs locally.

The local branch and the remote branch differ by design. Stave owns
`stave/lecturn-upstream/t3code`; the PR head is `upstream-integration`, pushed
with an explicit refspec. That keeps the remote branch name stable across
nights while leaving the local branch Stave-native.

`stave space sync` is safe to run against this space: it fetches the bare repo
and probes drift, and it never checks out or resets an editable worktree.

Interactive rescue, when a run leaves something for you:

```
stave summon lecturn-upstream --with claude
```

Note that `--summon` does nothing under launchd. It detects a non-TTY stdin and
prints the command instead of running it, which is why the script invokes
`claude -p` itself.

## Why it is a real merge

The agent resolves conflicts in a working tree that `git merge` already set up,
and the caller records the merge commit afterwards. The agent is blocked from
committing, pushing, rebasing or aborting, and both drivers fail the run if
`MERGE_HEAD` disappears or `HEAD` moves during resolution.

This matters because the merge commit is the only durable record of what has
been integrated. If the agent hand-wrote a diff instead, `git merge-base` would
never advance and every subsequent night would re-consider the entire backlog.

## One PR at a time

While an integration PR is open, the next night's run merges the newer mirror
onto that same branch instead of resetting it. Resolutions already on the
branch, whether the agent's or yours, survive, and only genuinely new upstream
commits can conflict. Do not force-push `upstream-integration` by hand.

Merge the PR promptly. A stale integration PR means the next night's batch is
larger, which makes conflicts worse.

## Reviewing an integration PR

The PR body carries the agent's account of every resolution and the call it
made. Read that first, then:

- Check anything the summary flagged as uncertain, and anything it says it
  could not verify.
- Check that fork features survived. The most common bad resolution is
  silently taking upstream's side of a file that the thread-forking feature or
  the Lecturn rebrand had modified.
- Check migration numbering if `apps/server/src/persistence/Migrations.ts`
  appears in the diff.
- CI (`check`, `test`, `test_server`) gates the PR. A red CI on an integration
  PR usually means a semantic break that git merged cleanly, not a conflict.

When a resolution decision recurs, add it to the resolution guide so the next
run gets it right without being told again.

## Configuration

Local, the primary path:

- `stave`, `claude`, `gh`, `jq` and GNU `timeout` on PATH. The script sets PATH
  explicitly because launchd hands over a minimal one and resolves the nvm
  Node installation at startup.
- `gh` authenticated as the repository owner. The push uses the `fork` remote
  and the local git credential helper.
- Everything else is an env var with a default at the top of the script:
  `SPACE_ID`, `CLAUDE_MODEL`, `AGENT_TIMEOUT`, the branch names. `CLAUDE_MODEL`
  defaults to `claude-opus-5`; `claude-sonnet-5` is the cheaper dial.
- Schedule a wake so the job is not permanently deferred by a sleeping laptop:
  `sudo pmset repeat wakeorpoweron MTWRFSU 08:10:00`.

Actions, the disabled fallback:

- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` as a repository secret.
  Without one, clean merges still open a PR and conflicted merges fail the run
  rather than pushing anything.
- `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` are required to mint the push
  token. The workflow stops before integration if it cannot mint one, because
  the default `GITHUB_TOKEN` cannot trigger the required PR checks.

## Failure modes

- **Files still conflicted after the agent runs.** The script stops and names
  them, leaving the merge in place in the Stave space. The agent is instructed
  to leave a conflict rather than guess. Finish it by hand in
  `~/stave/agent-work/lecturn-upstream/t3code`, or `stave summon
lecturn-upstream --with claude` and work it interactively.
- **A left-over conflicted tree blocks the next run.** The dirty check refuses
  to start on an unclean worktree, by design, so an abandoned merge stops the
  schedule until you deal with it. Clear it with `git merge --abort` in the
  space.
- **The laptop was asleep.** launchd runs a missed job on the next wake, so a
  skipped night self-corrects, but each skipped night makes the batch bigger.
  If you will be away, enable `upstream-integrate.yml` in Actions instead.
- **The mirror branch does not exist.** The script exits with a message naming
  `t3mirror-sync.yml`. Dispatch that workflow once.
- **Scheduled workflows suspended.** GitHub suspends them after 60 days without
  repository activity, which would silently stop the mirror. Any push re-arms
  it, and manual dispatch always works.
- **A huge first batch.** Run the script by hand and expect to help; the
  nightly cadence exists to keep each batch small.

Logs are at `~/Library/Logs/lecturn-upstream-integrate.log`. A finished run
posts a macOS notification with the PR URL.

## What a normal night looks like

Measured on 2026-09-08 with `git merge-tree --write-tree --name-only`, against
a fork `main` last synced on 2026-09-03:

| upstream commits in the batch | conflicted files |
| ----------------------------- | ---------------- |
| 158 (one night)               | 32               |
| 386 (three nights)            | 51               |
| 661 (five nights)             | 114              |

Upstream lands roughly 150 commits a day, so a healthy nightly run is about 30
conflicted files. Conflicts grow sublinearly with backlog because they cluster
in the same fork-owned files, but the resolutions get harder, not just more
numerous. If a run reports far more than 30, the previous PR probably sat
unmerged.
