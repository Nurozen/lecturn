# Integrating upstream in reviewable batches

`run-batches.py` is the local sequential controller. It creates one Stave space
per coherent checkpoint, launches fresh integration and review agents, opens a
PR, waits for review and hosted CI, and merges it before selecting the next
checkpoint. By default it continues until Lecturn main contains the captured
mirror tip. The independent `t3mirror-sync.yml` updater remains available.

## Start or resume

Use a stable checkout of the controller, authenticated `gh` and `codex` CLIs,
Stave with repository `lecturn` configured, Python 3, and the repository's Node
and package-manager tools on PATH. The controller inherits configured Codex
model selection and authentication. It does not install or change credentials.
Builder execution uses the explicitly authorized local host access; worktrees
isolate source and application state, not credentials or execution. Reviewers
run read-only. Approval prompts are disabled for these unattended sessions.

Bootstrap accepted upstream ancestry explicitly after inspecting the prior real
integration merge and its acceptance on fork main:

```bash
python3 .github/upstream-integration/run-batches.py \
  --repo /absolute/path/to/lecturn \
  --state-dir /absolute/external/path/upstream-runs \
  --spaces-dir /absolute/stave/agent-work \
  --accepted FULL_PREVIOUSLY_ACCEPTED_UPSTREAM_SHA \
  --bootstrap-note 'Verified target ancestry in the merge of PR NUMBER' \
  --refresh-mirror
```

Resume with the same paths and omit the bootstrap arguments. `progress.json`
points to the active manifest, so interrupted builds, commits, pushes and PR
merges resume the same batch. Do not delete state to retry a failure. `--once`
accepts at most one batch; `--target FULL_SHA` selects one explicit checkpoint.
Neither means a dry run: these commands publish and merge when all gates pass.
The operator must authorize unattended publication before invoking them.

The controller holds a nonblocking exclusive lock in Git's shared common
directory. Child agent/check processes inherit it, preventing a second controller
from taking over while a surviving child still runs. New batches also reject an
already-open integration PR, including the retired `upstream-integration` branch.

## Checkpoints and ancestry

Each external manifest pins fork base, accepted upstream SHA, merge base, target,
and captured mirror. The target must be on the captured first-parent history;
all newly reachable ancestors count toward batch size. Accepted ancestry must
remain reachable from fork main, target and mirror. Rewritten or ambiguous
history stops the run rather than resetting progress.

A fresh read-only planner examines upstream history, paths and fork overlap in
the next 30 first-parent candidates. It selects a coherent scope, generally
10–30 commits when that keeps related changes together. Defaults bound the
batch to 50 newly reachable commits and 15,000 changed source lines excluding
`.repos/`. The next single atomic commit may exceed the line cap only with an
explicit rationale and subsystem review plan. An explicit oversized target uses
`--oversized-reason`; the exception never admits multiple reachable commits.
Caps and candidate window are configurable for a documented scope decision.

Stave receives a fully qualified immutable local base ref and owns the branch
and `.stave.yaml`. The controller checks the resulting clean HEAD. Every
initial integration commit has exactly the pinned fork base and upstream target
as parents. Later repairs are normal commits; movement of main requires a real
merge followed by checks and fresh review. No reset, rebase, cherry-pick or force
push is used. A PR must merge with a merge commit; squash/rebase would destroy
this progress protocol.

## Fresh review and validation

The controller snapshots `BATCH_PROMPT.md` and `RESOLUTION_GUIDE.md` outside the
checkout. Upstream text is source evidence, not permission to change the task.
The builder inspects clean merges and conflicts, preserves fork behavior,
regenerates affected artifacts, and runs focused checks. Published migration
collisions require an upgrade design with existing-fork, upstream and fresh
DB evidence; mechanical renumbering is insufficient.

After staging, the builder returns an exact tree SHA and structured focused
check commands. The controller reruns those commands and checks that no source
changed. Two new independent agent sessions inspect the whole diff across
correctness, security, testing, performance, collateral effects and API/migration
compatibility. A separate fresh adversarial verifier assesses candidate findings.
Confirmed findings return to a new builder session; repairs invalidate previous
checks and both reviews. Refuted findings receive a fresh holistic assessment.
A bounded repair limit prevents an unattended loop from silently running forever.

UI behavior changes require authorized isolated client validation and real
before/after GitHub attachment URLs. The current operator has authorized browser
and computer use. Follow `test-t3-app`; never write live T3 state. Screenshots
are PR evidence, not repository assets. An upload failure leaves the batch
blocked with evidence retained; the controller cannot substitute a local path
or claim an image was attached. Reviewers judge whether UI evidence applies.

The controller binds the commit to the approved tree and exact parent list.
It publishes one unique branch, creates or updates its one PR, and waits for
both nonempty successful check results and a completed successful `ci.yml` run
for the exact head. A short early job cannot stand in for the complete workflow.
CI failures return to source repair and fresh review; missing checks and timeouts
retain the open PR for resumption. Checks must not be weakened to manufacture a
successful result. GitHub reviews requesting changes block merging.

After hosted CI, another fresh holistic/outside reviewer checks the complete
result and current human/bot feedback, including adversarial verification of
comments. The controller uses GitHub's expected-head merge guard. Main must have
strict up-to-date nonempty required checks enforced for administrators; startup
verifies this protection. GitHub provides a head compare-and-swap, not a base
compare-and-swap, so strict protection is also required to close the main-update
race. No admin override is used. Acceptance requires the resulting fork main
to contain both the reviewed branch head and upstream target.

## Recovery and storage

External manifests, prompt snapshots, JSON verdicts, command logs, PR bodies and
CI receipts survive failures. A recovered commit must have the reviewed tree and
expected parents. A recovered remote branch must match the controller's known
head; unrelated remote edits stop publication. Closed unmerged PRs are never
silently reopened. Resolve the stated blocker in the existing worktree/state,
then invoke the same controller command. Do not discard an in-progress merge.

After acceptance, only ignored `node_modules` directories owned by the newly
created Stave space are removed. The worktree, application state and all external
review records remain. Dependency caches can be reused across installs; writable
`node_modules` and application state are never shared between spaces. No `git
clean`, broad process kill or user-data cleanup is performed.

A failure exits nonzero and retains the active batch. Unattended scheduling is
not a promise that ambiguous engineering decisions can always resolve without
operator intervention. An active orchestrating agent should inspect the evidence,
repair the problem and resume until the ancestry check proves catch-up.

## Schedule after catch-up

Only after a successful run writes `caught-up.json`, render
`com.lecturn.upstream-integrate.plist` into `~/Library/LaunchAgents/` using
absolute paths for `__PYTHON__`, `__REPO__`, `__STATE__`, `__SPACES__`, `__PATH__`
and `__LOGS__`. XML-escape substituted values. Preserve the same state directory.
Inspect the rendered plist with `plutil -lint` before `launchctl bootstrap`.

The template uses `StartInterval=10800` (three hours), no RunAtLoad, and no restart
loop. Each invocation fast-forwards the pristine mirror, resumes pending work,
and processes sequential PRs until caught up. A sleeping/offline Mac cannot run
on time; launchd interval scheduling is not a hosted availability guarantee.
Never activate the retired whole-mirror driver in parallel.

Verify controller safety changes with:

```bash
python3 -m unittest discover -s .github/upstream-integration -p 'test_run_batches.py' -v
```
