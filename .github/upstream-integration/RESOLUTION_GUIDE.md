# Upstream integration guide

Read by the agent in `.github/workflows/upstream-integrate.yml` every time it
merges `t3mirror` (a pristine mirror of `pingdotgg/t3code` main) into this
fork's `main`. Humans resolving the same merge by hand should follow it too.

Keep this file current. When a resolution decision recurs, write it down here
rather than re-deriving it every night.

## The one rule that matters

The integration is a **real `git merge`**. Resolve conflicts in the working
tree and let the workflow record the merge commit. Never `git merge --abort`,
never rebase, never hand-copy upstream changes into a fresh commit. The merge
commit is what makes "commits since the last sync" an exact, cheap query; if
ancestry stops advancing, every future run re-processes the whole backlog.

If a conflict is genuinely beyond automated resolution, leave that file
conflicted, resolve everything else, and say so in the summary. A partial
merge that a human finishes beats a wrong merge.

## Fork-owned: keep ours

Take the fork's version. Read upstream's side first; if it added real behavior
(a new CI step, a new script), port that behavior into the fork's version by
hand rather than taking the file wholesale.

- `.github/workflows/release.yml` — fork-native pipeline (no Blacksmith, no
  relay/Clerk public config, no AUR, no Vercel, no Discord, no release GitHub
  App). Never take upstream's.
- `.github/workflows/ci.yml` — take upstream's job _content_, then re-apply the
  fork's substitutions: every `blacksmith-*vcpu-*` runner becomes
  `ubuntu-24.04` / `macos-26`, `timeout-minutes` stay at the fork's higher
  values, `feat/thread-forking` stays in the branch triggers.
- `.github/workflows/{deploy-relay,desktop-macos-preview,mobile-eas-preview,mobile-fingerprint-check,publish-aur,web-preview}.yml`
  — same runner and repo-guard edits, keep the fork's lines.
- `.github/workflows/{deploy-auth-email,t3mirror-sync,upstream-integrate}.yml`
  and `.github/upstream-integration/**` — fork-only, upstream cannot touch them.
- Branding assets: `assets/**`, `apps/web/public/lecturn-mark.svg`,
  `apps/marketing/public/**`, `apps/desktop/resources/dmg/dmg-background-*.svg`.
- Legal and attribution: `LICENSE`, `NOTICE.md`, `licenses/Apache-2.0.txt`,
  `apps/web/THIRD_PARTY_NOTICES.md`, `packages/shared/src/legalNotices.ts`,
  `scripts/generate-legal-notices.ts`,
  `apps/web/public/{privacy-policy,security-policy,terms-of-service}/index.html`,
  `apps/marketing/src/pages/{privacy-policy,security-policy,terms-of-service,legal}.astro`,
  `apps/marketing/src/lib/site.ts`, `README.md`.
- Fork infra: `infra/auth-email/**`, `docs/operations/lecturn-release.md`,
  `docs/user/lecturn-installation.md`.
- `scripts/export-lecturn-icons.ts` is the fork's icon exporter;
  `package.json` `icons:export` / `icons:check` point at it. Upstream's
  `scripts/export-brand-icons.ts` is still present and still upstream-owned, so
  take upstream's side there and port any change worth having into the Lecturn
  script by hand.
- Deleted on purpose, do not resurrect: `apps/marketing/src/lib/tweets.ts`,
  `apps/mobile/assets/widget/T3Mark.svg`.

## Upstream-owned: keep theirs

The fork has made no change to these since the merge base, so any conflict is
noise. Take upstream: `native/`, `packaging/`, `oxlint-plugin-t3code/`,
`.devcontainer/`, `.vscode/`, `.vite-hooks/`, `.claude/`, `.agents/`,
`.codex/`, `.cursor/`, `.macroscope/`, `.repos/`, `packages/ssh/`, and
`scripts/lib/brand-assets.ts` (the `BRAND_ASSET_PATHS` contract is unchanged,
only the asset bytes differ).

## Rebrand mapping

The fork is Lecturn. When upstream introduces a new string on this list,
translate it; when a conflict is only about these strings, keep the fork's.

| upstream                                                                  | fork                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `T3 Code`, `T3 Code (Alpha)`, `T3 Code (Nightly)`                         | `Lecturn`, `Lecturn (Alpha)`, `Lecturn (Nightly)`                |
| `T3 Code Dev` / `Preview` / `Desktop` / `Mobile`                          | `Lecturn Dev` / `Preview` / `Desktop` / `Mobile`                 |
| URL schemes `t3code`, `t3code-dev`, `t3code-preview`                      | `lecturn`, `lecturn-dev`, `lecturn-preview`                      |
| desktop app id `com.t3tools.t3code[.dev]`                                 | `com.cloudgatherer.lecturn[.dev]`                                |
| iOS/Android id `com.t3tools.t3code{,.dev,.preview}`                       | `com.cloudgatherer.lecturn{,.dev,.preview}`                      |
| Expo `slug: "t3-code"`                                                    | `slug: "lecturn"`                                                |
| Expo updates url `u.expo.dev/d763fcb8-…`                                  | `u.expo.dev/28b6b009-1a3e-4b67-94f9-1153621531ae`                |
| `appleTeamId: "ARK85ZXQ4Z"`                                               | `"BA887884R2"`                                                   |
| `clerk.t3.codes`                                                          | `clerk.lecturn.cloudgatherer.net`                                |
| `app.t3.codes`, `nightly.app.t3.codes`, `latest.app.t3.codes`, `t3.codes` | `lecturn.cloudgatherer.net`, `nightly.lecturn.cloudgatherer.net` |
| relay host                                                                | `relay.cloudgatherer.net`                                        |
| repo `pingdotgg/t3code`                                                   | `Nurozen/lecturn`                                                |
| server bin `"t3": "./dist/bin.mjs"`                                       | `"lecturn": "./dist/bin.mjs"`                                    |
| `~/.t3code`, `t3code.service`, `cwdBaseName: "t3code"`                    | `~/.lecturn`, `lecturn.service`, `"lecturn"`                     |
| `/Applications/T3 Code.app`, `C:\Program Files\T3 Code\`                  | `/Applications/Lecturn.app`, `C:\Program Files\Lecturn\`         |
| Android icon bg `#00639B`/`#111533`/`#000000`, notif `#7565C7`/`#FFFFFF`  | bg `#061522`, notif `#C89954`                                    |
| App Store / Play links, `MARKETING_STATS`                                 | removed, do not reintroduce                                      |
| Clerk `appleSignIn: !isIosPersonalTeamBuild`                              | hardcoded `false` (fork uses email auth)                         |

**Deliberately not renamed.** Leave these alone; upstream diffs touching them
apply cleanly: npm scope `@t3tools/*`, `oxlint-plugin-t3code`, env vars
`T3CODE_*` and `T3_*`, `packages/contracts/src/t3ProjectFile.ts`, and the
workspace package name `t3` (only the published manifest is rewritten, by
`release.yml` passing `--package-name lecturn --bin-name lecturn`).

Versions diverge on purpose. The fork releases independently, so keep the
fork's version number on conflict, never upstream's.

## Fork features and where they collide

**Thread forking** is the largest fork-only surface (~130 files). Fork-only
files, which upstream can never conflict with:
`apps/server/src/orchestration/threadFork.ts` (+ `.test.ts`),
`apps/server/src/orchestration/{Normalizer,decider,projector}.fork.test.ts`,
`apps/server/src/persistence/Migrations/*_ProjectionThreadForkLineage.ts`,
`apps/web/src/hooks/useForkThread.ts`,
`apps/mobile/src/features/threads/thread-fork-menu.ts`,
`packages/shared/src/uuid.ts`, `docs/internals/thread-forking.md`,
`docs/user/forking-threads.md`.

Upstream files the feature edits, where conflicts are expected and should
usually resolve as the **union** of both sides:

- `apps/server/src/orchestration/{decider,projector,Normalizer,Schemas}.ts`
- `apps/server/src/orchestration/Layers/{ProjectionPipeline,ProjectionSnapshotQuery,ProviderCommandReactor,ProviderRuntimeIngestion,CheckpointReactor}.ts`
- `apps/server/src/persistence/{Layers,Services}/Projection{Threads,Turns}.ts`
- `apps/server/src/{ws.ts,config.ts,cli/config.ts}` (`threadForkingEnabled`)
- `apps/server/src/vcs/{GitVcsDriver,VcsDriver}.ts` (worktree ref-counting)
- `apps/server/src/provider/Layers/*Adapter.ts`, `*Provider.ts` (session
  set/resume plumbing)
- `packages/contracts/src/{orchestration,server,environment,provider,keybindings}.ts`
- `packages/client-runtime/src/state/{threadCommands,threadDetail,entities}.ts`,
  `packages/client-runtime/src/operations/commands.ts`
- `apps/web/src/components/{ChatView*,Sidebar,LegacySidebar,CommandPalette}.tsx`,
  `chat/{ChatHeader,MessagesTimeline*}`, `threadActionMenu.logic.ts`,
  `apps/web/src/hooks/useThreadActionMenu.ts`
- `apps/mobile/src/features/{home,threads,layout}/**`

**Managed services**: `infra/auth-email/**`, `infra/relay/src/{db,observability}.ts`,
`infra/relay/scripts/alchemy-output.test.ts`, plus the alchemy patch pinned
through `patches/alchemy@2.0.0-beta.65.patch` and `pnpm-workspace.yaml`.

## Recurring mechanical conflicts

**Migration numbering is the single most common one.** The fork's
`*_ProjectionThreadForkLineage` migration has already been renumbered once
(045 → 048) because upstream added migrations underneath it. On a conflict in
`apps/server/src/persistence/Migrations.ts`: keep upstream's numbers as-is,
renumber the fork's migration to the next free slot, rename the file, and
update the paired `.test.ts`.

**Test fixtures.** Upstream fixtures hardcode `T3 Code` and `t3.codes`; the
fork's copies expect Lecturn strings. Take upstream's assertion _logic_, keep
the fork's expected strings. Files:
`apps/server/src/cli/{config.test.ts,triagePrompt.ts}`,
`apps/mobile/src/lib/mobileTheme.test.ts`, `.github/triage/PLAYBOOK.md`,
`apps/web/src/components/desktopUpdate.toast.test.tsx`,
`apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx`,
`apps/desktop/src/app/*.test.ts`.

**`pnpm-lock.yaml`.** Do not hand-merge. Take upstream's version wholesale
(`git checkout --theirs pnpm-lock.yaml`). The only fork-intentional entries are
the alchemy patch and the pinned Expo version, and both come back from
`pnpm-workspace.yaml` and `package.json` on the next `pnpm install`. The CI
workflow that runs the integration cannot install dependencies, so say in the
summary that the lockfile needs regenerating before the PR merges.

**Generated files.** Never hand-resolve these; they are regenerated from
source. Take upstream's version and say in the summary that they need
regenerating: `apps/web/src/routeTree.gen.ts`,
`apps/desktop/src/preview/AnnotationStyles.generated.ts`,
`apps/mobile/generated-uniwind-*`, `packages/*/src/_generated/*.gen.ts`.

## Verifying

The resolving agent has no package manager, test runner or network in its tool
allowlist, in either driver. It is reading upstream content that anyone can
author, so nothing it reads can become code that runs. It verifies by reading:
grep for the symbols upstream renamed or re-signed and check the fork's call
sites still match, then state in the summary what was reasoned about rather
than run.

The caller does the executing. `integrate-local.sh` runs `pnpm install` and
`vp run -r typecheck` on the merged tree and puts the result in the PR body;
the Actions fallback has no dependencies installed and skips it. CI runs
`check`, `test` and `test_server` on the PR either way.

A human resolving the same merge locally should run `vp run -r typecheck`
scoped to the affected package and `vp test run <files>` for the adjacent
tests. Repo-wide checks are CI's job.

Leave a clean tree either way: no conflict markers, no scratch files, nothing
staged that is not part of the merge.
