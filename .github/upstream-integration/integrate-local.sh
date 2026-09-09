#!/usr/bin/env bash
#
# Local upstream integration, run unattended from launchd.
#
# The hybrid model: `t3mirror-sync.yml` keeps the `t3mirror` branch current in
# GitHub Actions (cheap, reliable, no agent). This script does the integration
# on your machine, inside a Stave space, so the merge can be typechecked before
# the PR opens. `upstream-integrate.yml` is the same flow in Actions, kept
# disabled as a fallback for when this machine is away.
#
# It performs a real `git merge` and only then hands the conflicted working
# tree to Claude. The agent reads and edits; it never executes anything and
# never touches git history. This script commits, pushes, and runs the
# verification, and refuses to push if the merge state was disturbed.
#
# Install: see com.lecturn.upstream-integrate.plist in this directory.
# Run by hand any time: bash .github/upstream-integration/integrate-local.sh
#
set -euo pipefail

# launchd hands over a minimal PATH, so everything is named explicitly. The
# Node bin directory is resolved rather than pinned: `corepack` lives only
# under nvm here, and pinning a version silently loses it on the next bump.
node_bin=""
if [ -f "${HOME}/.nvm/alias/default" ]; then
  nvm_default="$(cat "${HOME}/.nvm/alias/default")"
  node_bin="$(ls -d "${HOME}/.nvm/versions/node/v${nvm_default#v}"*/bin 2>/dev/null | tail -1 || true)"
fi
[ -n "$node_bin" ] || node_bin="$(ls -d "${HOME}"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin${node_bin:+:$node_bin}:${PATH:-}"

SPACE_ID=${SPACE_ID:-lecturn-upstream}
SPACE_KIND=${SPACE_KIND:-sync}
REPO_NAME=${REPO_NAME:-t3code}
FORK_REMOTE=${FORK_REMOTE:-fork}
FORK_SLUG=${FORK_SLUG:-Nurozen/lecturn}
TARGET_BRANCH=${TARGET_BRANCH:-main}
MIRROR_BRANCH=${MIRROR_BRANCH:-t3mirror}
INTEGRATION_BRANCH=${INTEGRATION_BRANCH:-upstream-integration}
CLAUDE_MODEL=${CLAUDE_MODEL:-claude-opus-5}
AGENT_TIMEOUT=${AGENT_TIMEOUT:-5400}
SUMMARY_FILE=.upstream-integration-summary.md
LOCK_DIR=${LOCK_DIR:-${TMPDIR:-/tmp}/lecturn-upstream-integrate.lock}

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
notify() {
  osascript -e "display notification \"${2//\"/}\" with title \"${1//\"/}\"" \
    >/dev/null 2>&1 || true
}
die() { log "ERROR: $*"; notify "Upstream integration failed" "$*"; exit 1; }

# ------------------------------------------------------------------- the lock
# macOS has no flock. `mkdir` is atomic; the pid file is written immediately
# after. A lock with no pid file yet belongs to a process still starting up, so
# it is respected rather than stolen.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -z "$lock_pid" ]; then
    log "A run is starting up (lock has no pid yet). Exiting."
    exit 0
  fi
  if kill -0 "$lock_pid" 2>/dev/null; then
    lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
    if [ "$lock_age" -gt $(( AGENT_TIMEOUT * 2 )) ]; then
      die "A run (pid $lock_pid) has been going for ${lock_age}s. Something is wedged; kill it and re-run."
    fi
    log "Another run (pid $lock_pid) is in progress. Exiting."
    exit 0
  fi
  log "Clearing a stale lock from dead pid $lock_pid."
  rm -rf "$LOCK_DIR" || die "could not clear the stale lock at $LOCK_DIR"
  mkdir "$LOCK_DIR" || die "could not take the lock at $LOCK_DIR"
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

for tool in stave claude gh jq git timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
done

# ---------------------------------------------------------------- Stave space
# The space is long-lived on purpose. A fresh one every night would re-pay a
# full `pnpm install`, and the installed dependencies are the whole reason the
# integration runs here rather than in Actions.
first_run=false
if ! stave space status "$SPACE_ID" --json >/dev/null 2>&1; then
  log "Creating Stave space $SPACE_ID."
  # `stave` prefixes a bare base with `origin/`, and `origin` is upstream on the
  # shared bare repo. A fully-qualified ref is passed through untouched.
  stave space create --json -k "$SPACE_KIND" \
    -e "${REPO_NAME}:refs/remotes/${FORK_REMOTE}/${TARGET_BRANCH}" \
    "$SPACE_ID" >/dev/null \
    || die "stave space create failed"
  first_run=true
fi

# `space sync` fetches the bare repo with --all --prune, which is what refreshes
# refs/remotes/fork/*. It never touches an editable worktree's checkout.
stave space sync "$SPACE_ID" --json >/dev/null || die "stave space sync failed"

status="$(stave space status "$SPACE_ID" --json)" || die "stave space status failed"
repo_dir="$(jq -r --arg n "$REPO_NAME" \
  '.repos[] | select(.name==$n and .mode=="edit") | .path' <<<"$status")"
[ -n "$repo_dir" ] && [ -d "$repo_dir" ] || die "no editable $REPO_NAME worktree in space $SPACE_ID"
cd "$repo_dir"
export PATH="${repo_dir}/node_modules/.bin:${PATH}"

# Preserve unfinished resolutions, including any work a human added after failure.
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  die "An unfinished merge remains in $repo_dir. Resolve or abort it manually before re-running."
fi

if [ -n "$(git status --porcelain=v1)" ]; then
  git status --short | head -20 | sed 's/^/    /'
  die "$repo_dir has uncommitted changes that are not an in-progress merge. Refusing to touch it."
fi
log "Working in $repo_dir"

# --------------------------------------------------------------- merge set-up
git fetch --no-tags --prune "$FORK_REMOTE" >/dev/null 2>&1 || die "fetch $FORK_REMOTE failed"

mirror_ref="refs/remotes/${FORK_REMOTE}/${MIRROR_BRANCH}"
target_ref="refs/remotes/${FORK_REMOTE}/${TARGET_BRANCH}"
integration_ref="refs/remotes/${FORK_REMOTE}/${INTEGRATION_BRANCH}"

git rev-parse -q --verify "$mirror_ref" >/dev/null \
  || die "${FORK_REMOTE}/${MIRROR_BRANCH} does not exist. Has t3mirror-sync.yml run yet?"

mirror_sha="$(git rev-parse "$mirror_ref")"
if git merge-base --is-ancestor "$mirror_sha" "$target_ref"; then
  log "${TARGET_BRANCH} already contains upstream ${mirror_sha:0:12}. Nothing to do."
  exit 0
fi

# An *open* PR is the signal to continue a branch, not the mere existence of the
# ref: a merged PR whose branch was not auto-deleted would otherwise have runs
# stacking onto dead history forever.
existing_pr="$(gh pr list --repo "$FORK_SLUG" --head "$INTEGRATION_BRANCH" \
  --base "$TARGET_BRANCH" --state open --json number --jq '.[0].number // empty')" \
  || die "gh pr list failed"

branch="stave/${SPACE_ID}/${REPO_NAME}"
if [ -n "$existing_pr" ] && git rev-parse -q --verify "$integration_ref" >/dev/null; then
  log "Continuing the branch behind open PR #${existing_pr}."
  git checkout -B "$branch" "$integration_ref" >/dev/null
  if ! git merge-base --is-ancestor "$target_ref" HEAD; then
    if ! git merge --no-edit "$target_ref" \
        -m "chore: merge ${TARGET_BRANCH} into ${INTEGRATION_BRANCH}" >/dev/null; then
      git merge --abort || true
      die "${TARGET_BRANCH} conflicts with the open ${INTEGRATION_BRANCH}. Resolve by hand in $repo_dir."
    fi
  fi
else
  git checkout -B "$branch" "$target_ref" >/dev/null
fi

count="$(git rev-list --count "HEAD..${mirror_sha}")"
log "Integrating $count upstream commits at ${mirror_sha:0:12}."

# Dependencies must exist for the verification below to mean anything. Cheap
# when warm. A failure is not fatal: a merge PR is still worth opening, it just
# arrives unverified and says so.
deps_note=""
if [ "$first_run" = "true" ] || [ ! -d node_modules ]; then
  log "Installing dependencies (first run in this space, this takes a while)."
  if ! corepack pnpm install >/dev/null 2>&1; then
    deps_note="\`pnpm install\` failed, so nothing below was verified."
    log "WARNING: $deps_note"
  fi
fi

# ------------------------------------------------------------------- the merge
pre_head="$(git rev-parse HEAD)"
conflicted=false
if git merge --no-commit --no-ff "$mirror_sha" >/dev/null 2>&1; then
  log "Merged cleanly. No agent needed."
else
  conflicted=true
  log "Conflicts in:"
  git diff --name-only --diff-filter=U | sed 's/^/    /'
fi

if [ "$conflicted" = "true" ]; then
  log "Handing the tree to Claude ($CLAUDE_MODEL)."
  # The agent gets no execution: no package manager, no test runner, no network,
  # no git history verbs. It is reading attacker-authorable upstream content, so
  # everything it could turn into code execution stays out of its hands. This
  # script runs the verification afterwards instead.
  set +e
  timeout -k 60 "$AGENT_TIMEOUT" claude -p \
    "Read \`.github/upstream-integration/PROMPT.md\` and follow it exactly. It is the whole task. A \`git merge\` is already in progress in this working tree and has left conflicts; discover the context from git as that file describes.

Context for this run, for your summary: this is an unattended local run in the Stave space \`${SPACE_ID}\`, integrating ${count} upstream commits at \`${mirror_sha:0:12}\`. You cannot build or test: take the no-build path in PROMPT.md and reason by reading. The calling script runs typecheck after you finish and puts the result in the PR." \
    --model "$CLAUDE_MODEL" \
    --permission-mode acceptEdits \
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git rev-parse:*),Bash(git merge-base:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git ls-files:*),Bash(git add:*),Bash(git mv:*),Bash(git checkout --ours:*),Bash(git checkout --theirs:*),Bash(rg:*),Bash(ls:*),Bash(cat:*)" \
    --disallowedTools "Bash(git commit:*),Bash(git push:*),Bash(git reset:*),Bash(git merge:*),Bash(git rebase:*),Bash(git cherry-pick:*),Bash(git config:*),Bash(gh:*),Bash(curl:*),Bash(ssh:*),Bash(pnpm:*),Bash(corepack:*),Bash(npm:*),Bash(node:*),Bash(vp:*)"
  agent_rc=$?
  set -e
  [ "$agent_rc" -eq 0 ] || log "WARNING: the agent exited $agent_rc$([ "$agent_rc" -eq 124 ] && echo ' (timeout)')."

  # The agent is not trusted to have respected the hard rules. Check.
  # Note: this is a linked worktree, so `.git` is a file and `.git/MERGE_HEAD`
  # does not exist. Ask git, not the filesystem.
  git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 \
    || die "MERGE_HEAD is gone: the agent committed or aborted the merge (agent exit ${agent_rc}). Nothing pushed. Inspect $repo_dir."
  [ "$(git rev-parse HEAD)" = "$pre_head" ] \
    || die "HEAD moved during resolution: the agent committed (agent exit ${agent_rc}). Nothing pushed. Inspect $repo_dir."

  unmerged="$(git diff --name-only --diff-filter=U)"
  if [ -n "$unmerged" ]; then
    echo "$unmerged" | sed 's/^/    /'
    die "$(printf '%s file(s) still need a human (agent exit %s). The merge is left in place at %s' \
            "$(grep -c '' <<<"$unmerged")" "$agent_rc" "$repo_dir")"
  fi

  markers="$(git grep -lE '^(<{7}|>{7}) ' -- . || true)"
  [ -z "$markers" ] || { echo "$markers" | sed 's/^/    /'; die "conflict markers remain (agent exit ${agent_rc})"; }
fi

# ---------------------------------------------------------------- verification
# Run by this script, never by the agent. Advisory: a failure annotates the PR
# rather than blocking it, because CI is the real gate and a merge PR that says
# "typecheck is red here" is more useful than no PR.
verify_note=""
if [ -n "$deps_note" ]; then
  verify_note="$deps_note"
elif [ -d node_modules ]; then
  log "Installing any dependencies upstream added, then typechecking."
  if ! corepack pnpm install >/dev/null 2>&1; then
    verify_note="\`pnpm install\` failed after the merge; typecheck did not run."
  else
    typecheck_log="$(mktemp)"
    if vp run -r typecheck >"$typecheck_log" 2>&1; then
      verify_note="\`vp run -r typecheck\` passed on the merged tree."
      log "Typecheck passed."
    else
      verify_note="$(printf '`vp run -r typecheck` **failed** on the merged tree:\n\n```\n%s\n```' \
        "$(tail -40 "$typecheck_log")")"
      log "WARNING: typecheck failed on the merged tree."
    fi
    rm -f "$typecheck_log"
  fi
else
  verify_note="No \`node_modules\` in the space, so nothing was verified locally."
fi

# ------------------------------------------------------------- commit and push
summary=""
if [ -f "$SUMMARY_FILE" ]; then summary="$(cat "$SUMMARY_FILE")"; rm -f "$SUMMARY_FILE"; fi

untracked="$(git ls-files --others --exclude-standard)"
[ -z "$untracked" ] || { log "The agent created files not on either side of the merge:"; echo "$untracked" | sed 's/^/    /'; }

git add -A
if [ "$conflicted" = "true" ]; then
  trailer="Conflicts resolved by Claude (${CLAUDE_MODEL}) in Stave space ${SPACE_ID}; review before merging."
else
  trailer="Merged cleanly with no conflicts."
fi
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 || ! git diff --cached --quiet; then
  git commit --no-verify -q \
    -m "chore: merge upstream pingdotgg/t3code@${mirror_sha:0:12}" -m "$trailer"
fi

push_err="$(mktemp)"
if ! git push --force-with-lease "$FORK_REMOTE" "HEAD:${INTEGRATION_BRANCH}" >"$push_err" 2>&1; then
  err="$(tail -5 "$push_err")"; rm -f "$push_err"
  die "push to ${FORK_REMOTE}/${INTEGRATION_BRANCH} failed: ${err}"
fi
rm -f "$push_err"
log "Pushed to ${FORK_REMOTE}/${INTEGRATION_BRANCH}."

# ------------------------------------------------------------------------- PR
body="$(mktemp)"
{
  echo "Integrates ${count} commits from [\`pingdotgg/t3code\`](https://github.com/pingdotgg/t3code) up to \`${mirror_sha:0:12}\` into \`${TARGET_BRANCH}\`."
  echo
  if [ "$conflicted" = "true" ]; then
    echo "Resolved locally by Claude (\`${CLAUDE_MODEL}\`) in the Stave space \`${SPACE_ID}\`, against [\`RESOLUTION_GUIDE.md\`](https://github.com/${FORK_SLUG}/blob/${TARGET_BRANCH}/.github/upstream-integration/RESOLUTION_GUIDE.md). **Read the summary below before merging.**"
  else
    echo "The merge was clean. No agent involved, no conflicts resolved."
  fi
  echo
  printf '## Verification\n\n%s\n\n' "$verify_note"
  if [ -n "$summary" ]; then printf '## Resolution summary\n\n%s\n\n' "$summary"; fi
  if [ -n "$untracked" ]; then
    printf '## Files the agent created\n\nNot present on either side of the merge. Check these are intentional (a renumbered migration is; scratch files are not).\n\n```\n%s\n```\n\n' "$untracked"
  fi
  printf '## Upstream commits\n\n```\n%s\n```\n\n' \
    "$(git log --oneline --no-merges "${target_ref}..${mirror_sha}" | head -100 || true)"
  echo "<sub>Opened by \`integrate-local.sh\`. Do not force-push this branch by hand: the next run merges onto it.</sub>"
} > "$body"

title="chore: integrate upstream pingdotgg/t3code@${mirror_sha:0:12}"
if [ -n "$existing_pr" ]; then
  gh pr edit "$existing_pr" --repo "$FORK_SLUG" --title "$title" --body-file "$body" >/dev/null \
    || die "gh pr edit #${existing_pr} failed; the branch was already pushed"
  url="$(gh pr view "$existing_pr" --repo "$FORK_SLUG" --json url --jq .url)" \
    || die "gh pr view #${existing_pr} failed; the branch was already pushed"
  log "Updated $url"
else
  url="$(gh pr create --repo "$FORK_SLUG" --head "$INTEGRATION_BRANCH" \
    --base "$TARGET_BRANCH" --title "$title" --body-file "$body")" \
    || die "gh pr create failed; the branch was already pushed to ${INTEGRATION_BRANCH}"
  gh pr edit "$url" --repo "$FORK_SLUG" --add-assignee "${FORK_SLUG%%/*}" >/dev/null 2>&1 \
    || log "WARNING: could not assign ${FORK_SLUG%%/*}."
  log "Opened $url"
fi
rm -f "$body"

notify "Upstream integration ready for review" "${count} commits, conflicts: ${conflicted}. ${url}"
log "Done."
