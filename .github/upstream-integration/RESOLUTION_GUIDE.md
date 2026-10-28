# Upstream integration guide

Read by fresh integration and review agents launched by `run-batches.py`.
Each run pins one coherent upstream checkpoint from pristine `upstream-mirror` and
merges it into the fork through its own reviewed PR. Keep recurring resolution
decisions here. The controller snapshots this guide before loading upstream code.

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
  AUR publishing, no Vercel, no Discord, no release GitHub App). Keep the
  Lecturn public configuration bindings. Never take upstream's.
- `.github/workflows/ci.yml` — take upstream's job _content_, then re-apply the
  fork's substitutions: every `blacksmith-*vcpu-*` runner becomes
  `ubuntu-24.04` / `macos-26`, `timeout-minutes` stay at the fork's higher
  values, `feat/thread-forking` stays in the branch triggers.
- `.github/workflows/{deploy-relay,desktop-macos-preview,mobile-eas-preview,mobile-fingerprint-check,publish-aur,web-preview}.yml`
  — same runner and repo-guard edits, keep the fork's lines.
- `.github/workflows/{deploy-auth-email,upstream-mirror-sync,upstream-integrate}.yml`
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
  `apps/mobile/assets/widget/LecturnMark.svg`.

## Shared implementation: preserve behavior and Lecturn identity

Review incoming implementation changes in `native/`, `packaging/`,
`oxlint-plugin-lecturn/`, editor and agent configuration, `packages/ssh/`, and
`scripts/lib/brand-assets.ts`. These paths contain Lecturn package names, paths,
commands, and branding, so do not take the upstream version wholesale.
Vendored `.repos/` references remain read-only context.

## Lecturn identity

When upstream introduces product names or identifiers, translate them to the
Lecturn identity below. Preserve upstream copyright and license notices required
by the MIT license in the legal files. Do not restore upstream product branding
elsewhere, including test fixtures, package names, environment variables, paths,
comments, and documents.

| Surface                                               | Lecturn value                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Product names                                         | `Lecturn`, `Lecturn (Alpha)`, `Lecturn (Nightly)`, `Lecturn Dev`, `Lecturn Preview` |
| URL schemes                                           | `lecturn`, `lecturn-dev`, `lecturn-preview`                                         |
| Desktop and mobile application IDs                    | `com.cloudgatherer.lecturn` with the appropriate development or preview suffix      |
| Expo slug                                             | `lecturn`                                                                           |
| Expo updates project                                  | `28b6b009-1a3e-4b67-94f9-1153621531ae`                                              |
| Apple team                                            | `BA887884R2`                                                                        |
| Clerk host                                            | `clerk.lecturn.cloudgatherer.net`                                                   |
| Web hosts                                             | `lecturn.cloudgatherer.net`, `nightly.lecturn.cloudgatherer.net`                    |
| Relay host                                            | `relay.cloudgatherer.net`                                                           |
| Repository                                            | `Nurozen/lecturn`                                                                   |
| npm scope and lint plugin                             | `@lecturn/*`, `oxlint-plugin-lecturn`                                               |
| Server workspace, published package, and binary       | `lecturn`                                                                           |
| Runtime environment variables                         | `LECTURN_*`                                                                         |
| Project configuration                                 | `lecturn.json`, `lecturnProjectFile.ts`                                             |
| State and service                                     | `~/.lecturn`, `lecturn.service`                                                     |
| Install paths                                         | `/Applications/Lecturn.app`, `C:\Program Files\Lecturn\`                            |
| Android icon background and notification color        | `#061522`, `#C89954`                                                                |
| App Store / Play links and inherited usage statistics | Keep removed until independently established for Lecturn                            |
| Clerk Apple sign-in                                   | `false` (fork uses email auth)                                                      |

Configure the original repository with the `UPSTREAM_REPOSITORY` Actions variable
for the mirror workflow. The local controller accepts `--upstream-repository` or
the `UPSTREAM_REPOSITORY` environment variable when using `--refresh-mirror`.
The upstream must differ from this fork; neither tool defaults to self-mirroring.

Versions diverge on purpose. The fork releases independently, so keep the
fork's version number on conflict, never upstream's.

The release stage is fork-owned too. Upstream #20032 renamed its product
stage from Alpha to Beta; Lecturn keeps `Lecturn (Alpha)` on desktop and web,
and mobile production builds show no stage badge. The `"Beta"` literal that
upstream added to the desktop stage type in `packages/contracts` is harmless
because the fork never emits it.

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
`infra/relay/scripts/alchemy-output.test.ts` (guards the alchemy output fixes
that beta.76 ships upstream; the former beta.65 patch is gone), and the alchemy
pin in `pnpm-workspace.yaml`.

**Connect multiple accounts** sits behind the `connectMultiAccount` constant in
`apps/web/src/cloud/publicConfig.ts`. Fork-only files:
`apps/web/src/components/clerk/{ConnectAccountMenu.tsx,ConnectAccountMenu.logic.ts,connectProfilePages.tsx,useConnectSignOut.logic.ts}`,
`apps/web/src/components/clerk/{useConnectSignIn.ts,SidebarSignInAgainButton.tsx}`,
`apps/web/src/components/sidebar/{AccountMark,SidebarAccountBar,SidebarSegments}.tsx`,
`apps/web/src/components/sidebar/{sidebarSegments.logic,useSidebarSegments,accountProjectGroups}.ts`,
`apps/web/src/cloud/{connectAccounts,knownAccounts,accountTokens,relayTokenCache,singleAccountGuard,useAccountEmailWhenSeveral}.ts`,
`apps/web/src/cloud/{withActiveAccount,accountPicker,accountRelayClients,cloudLinkAccount,accountGone}.ts`,
`apps/web/src/components/clerk/{ConnectAccountPicker,ConnectAccountCommandsHost,AccountGoneNotice,useConnectAccountPaletteItems}.tsx`,
`apps/web/src/components/clerk/connectAccountCommands.ts`,
`packages/client-runtime/src/relay/{connectAccounts,singleAccountGuard}.ts`, and
their tests.

Call sites in upstream files, which must survive a merge:

- `apps/web/src/components/Sidebar.tsx` (very high churn): one import and one
  `<AccountMark environmentId={thread.environmentId} />` line before
  `{pinIndicator}` in each visible `SidebarThreadRow` layout, slim and card.
  If upstream reshapes a row, re-add the single line; never the tooltip.
- `apps/web/src/components/Sidebar.tsx`, segmented sidebar. Wrap, never
  extract: upstream's list body stays where it is. Nine sites, all small:
  1. the `./sidebar/*` imports next to `AccountMark`;
  2. `const sidebarSegmentation = useSidebarSegmentation();` before
     `unsortedProjectGroups`, whose memo calls
     `snapshotsPerAccount(sidebarSegmentation, buildSidebarProjectSnapshots)({...})`
     and lists `sidebarSegmentation` in its deps;
  3. the `useSidebarSegments({...})` call right before `orderedThreads`. It
     takes the partition's lists, the two shelf flags, and the three shelf
     actions (`toggleSnoozedShelf`, `toggleSettledShelf`, `showMoreSettled`) by
     name. A list upstream adds to the body has to be added to
     `SidebarListScope` and passed here;
  4. `orderedThreads` starts with the
     `flattenSegmentsForNavigation(sidebarSegments.segments)` early return and
     lists `sidebarSegments.segments` in its deps. Keyboard order, jump hints,
     and range select all derive from `orderedThreads`, so nothing else changes;
  5. the list `<ul ref={attachListAutoAnimateRef} ...>` is `<SidebarSegments ...>`
     with the same `ref`, `role`, and `className`, and `</ul>` is
     `</SidebarSegments>`;
  6. the body IIFE `{(() => {` ... `})()}` is the render prop
     `{(segment) => {` ... `}}`, and its first lines destructure the list names,
     the shelf flags, and the shelf toggles from `segment`, shadowing the
     component's. Upstream's body reads those names unchanged. The "Show more"
     `<li>` after it stays as the second child: it renders in the one-list
     sidebar only, and `SidebarSegments.tsx` carries a copy for segments, so
     restyle both together;
  7. `SidebarDraftBlock` reads `const ownsEnvironment = useSegmentOwnsEnvironment();`,
     skips a session when `!ownsEnvironment(session.environmentId)`, and lists
     `ownsEnvironment` in the `drafts` memo's deps. It is how a draft whose
     project is not loaded still lands in its account's segment;
  8. `handlePinnedDragEnd` plans with
     `orderedIds: pinnedReorderKeysWithinSegment(sidebarSegments.segments, newOrder, activeKey)`
     and lists `sidebarSegments.segments` in its deps, so a drop never writes to
     another account's environment. The optimistic order stays the whole block's;
  9. `projectScopeItems` maps `nameGroupsByAccount(sidebarSegmentation, projectGroups)`
     and lists `sidebarSegmentation` in its deps.
- `apps/web/src/components/LegacySidebar.tsx`: the `AccountMark` and
  `accountProjectGroups` imports, `<AccountMark environmentId={thread.environmentId} />`
  before `<ThreadWorktreeIndicator thread={thread} />` in the thread row,
  `const segmentation = useSidebarSegmentation();`, and the two grouping calls
  wrapped as `projectKeyMapPerAccount(segmentation, buildPhysicalToLogicalProjectKeyMap)({...})`
  and `namedSnapshotsPerAccount(segmentation, buildSidebarProjectSnapshots)({...})`
  with `segmentation` in both deps lists. Both must stay wrapped, or the
  thread-to-project keys stop matching the project keys.
- `apps/web/src/components/settings/ProjectSettingsPanel.tsx`: a segmented
  sidebar links to the project page with account-scoped group keys, and the
  page has to act on that account's members alone. `useSettingsProjectGroups`
  takes the route's `projectKey`, reads `useProjectAccountScope(projectKey)`,
  and builds with `snapshotsOfAccountScope(accountScope, buildSidebarProjectSnapshots)({...})`.
  The breadcrumb and the panel pass their `projectKey`, and the breadcrumb
  shows the scope's email after the project name.
- `apps/web/src/components/ui/scroll-area.tsx`: the `scrollFade` class list
  ends with `data-[scroll-fade=off]:mask-none`, which `SidebarSegments.tsx`
  sets on the viewport while its opaque bars mark the edges.
- `apps/web/src/components/clerk/LecturnConnectSidebarSignIn.tsx`:
  `LecturnConnectSidebarAvatar` returns `<ConnectAccountMenu />` when the
  constant is on, and the `UserButton` maps `CONNECT_PROFILE_PAGES` instead of
  listing its three `UserProfilePage` tabs. A tab upstream adds goes into
  `connectProfilePages.tsx` so both paths get it.
- `apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx`: the row
  body is the `renderRow` closure, followed by the grouped return. Take
  upstream's row markup inside the closure and keep the `AccountMark` line.
- `apps/web/src/components/cloud/{ConnectSubscriptionGate,ConnectOnboardingDialog}.tsx`:
  `useAccountEmailWhenSeveral` and the copy that reads it.
  Both also take the picked account: `ConnectSubscriptionGate` has an
  `accountId` prop, and the dialog calls `useConnectAccountPicker("publish", ...)`,
  passes `account.accountId` to `useCloudLinkController`, `TeamSelector`, and
  the gate, and renders `account.picker` on the publish step.
- `apps/web/src/components/CommandPalette.tsx` (very high churn): three lines.
  The `useConnectAccountPaletteItems` import, `const connectAccountItems =
useConnectAccountPaletteItems();` above `const actionItems`, and
  `actionItems.push(...connectAccountItems);` right before `buildRootGroups`.
  The builder is in `clerk/connectAccountCommands.ts`, not in
  `CommandPalette.logic.ts`. Never import `@clerk/react` from the palette.
- `apps/web/src/components/settings/ConnectionsSettings.tsx` (very high churn),
  all inside `ConfiguredCloudLinkRow`: the `useConnectAccountPicker("publish", ...)`
  call, the options passed to `useCloudLinkController`, `unlinkBlocked` in the
  destructure, the `unlinkButton` constant, the "Publish as" `SettingsRow`, the
  gate's `accountId`, and the unlink row's control, which shows the mismatch
  action next to `unlinkButton`. Take upstream's rows and re-add these.
- `apps/web/src/cloud/useCloudLinkController.ts`: takes `{ accountId,
onSelectAccount }`, reads every token through `readToken(accountId)`, and gets
  its mismatch state from `describePublishAccount`. It must not call
  `useClerk` or `setActive`.
- `apps/web/src/components/cloud/{BillingAccount,TeamsAccount,TeamSelector}.tsx`:
  each takes the picked account instead of `useAuth().userId`, builds its relay
  client with `accountRelayClients.ts`, and keeps the `key={accountId}` remount.
- `apps/web/src/components/cloud/ConnectCliAuthSurface.tsx` and
  `apps/web/src/cloud/connectCliAuth.ts`: the effect follows
  `decideConnectCliAuthorizeStep`, and the redirect for a chosen account runs
  inside `withActiveAccount`.
- `apps/web/src/threadRoutes.ts` and `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`:
  the `account-gone` render state, the lazy `AccountGoneNotice`, and the effect
  that sets `openThreadEnvironmentIdAtom`.
- `apps/web/src/components/sidebar/SidebarSegments.tsx` takes its DOM ids from
  `segmentLabelDomId` and `segmentListDomId`, which the palette's "Go to
  account" scrolls to.
- `apps/web/src/components/settings/{settingsSearch.ts,useAvailableSettingsSearchItems.ts}`:
  the two `connectAccountMenuOnly` rows and `hasConnectAccountMenu`.
- `apps/web/src/cloud/managedAuth.tsx`, `apps/web/src/components/clerk/useConnectSignOut.tsx`,
  and `packages/client-runtime/src/state/connections.ts`
  (`unlistedRelayEnvironmentIdsValueAtom`): resolve as the union.

**Lecturn Apps** (connected apps, the `/embed` view, `@lecturn/embed`; see
`docs/internals/app-trust-boundary.md`). Fork-only paths, which upstream can
never conflict with:
`packages/embed/**`, `examples/embed-host/**`,
`packages/contracts/src/{apps,appsRpc,appsRpcCore,appsHttp,appsBundle,embedBridge}.ts`,
`packages/shared/src/{appLinks,appReferences,appToolPresentation,jsonRpcFrame,lecturnMcpToolName}.ts`,
`packages/client-runtime/src/embed/**`,
`packages/client-runtime/src/state/{apps,appProjects}.ts`,
`apps/server/src/apps/**`, `apps/server/src/mcp/toolkits/{app,apps}/**`,
`apps/server/src/mcpApps/AppMcpAppRoute.ts`,
`apps/server/src/persistence/AppRegistrations.ts`,
`apps/server/src/persistence/Migrations/{079_AppRegistrations,080_ProjectionProjectsAppBinding}.ts`,
`apps/server/src/orchestration-v2/Adapters/{ScriptedAdapterV2,scriptedScript,codexMcpToolResult,connectedAppAdapterHooks}.ts`,
`apps/server/src/provider/Drivers/ScriptedDriver.ts`,
`apps/web/src/embed/**`, `apps/web/src/components/{apps,embed}/**`,
`apps/web/src/components/AppShell.tsx`, `apps/web/src/components/RootDocumentSync.tsx`,
`apps/web/src/components/settings/ConnectedAppsSettings*`,
`apps/web/src/components/sidebar/{SidebarScopeRow*,SidebarHeaderIconButton,JumpHintBadge}.tsx`,
`apps/web/src/components/chat/{composerApprovalState,dockedDrawerFollow}.ts`,
`apps/web/src/routes/{embed.*,_chat.apps.$appId,settings.apps}.tsx`,
`apps/web/src/{state/apps,lib/openAppUrl}.ts`, `apps/desktop/src/ipc/methods/apps.ts`,
`apps/mobile/src/features/apps/**`, `apps/mobile/src/state/apps.ts`,
`scripts/lib/lecturn-pack.ts`,
`scripts/{check-embed-chunks,smoke-pack-install,smoke-pack-probe}.ts`,
`packages/tsconfig.embed-dts.json`, `docs/internals/app-trust-boundary.md`,
`docs/user/connected-apps.md`, and their tests.

`apps/web/src/routes/__root.tsx` is the one structural move: the root's
authenticated body (sidebar layout, command palette, coordinators, dialogs,
toasts) now lives in `components/AppShell.tsx`, loaded lazily so `/embed`
never downloads it. An upstream change to that body, such as a new
coordinator, goes into `AppShell.tsx`; take upstream's `__root.tsx` and keep
the lazy `AppShell` import with its `void loadAppShell()` preload in
`beforeLoad`, the `/embed` bypass beside `/account/billing` in `beforeLoad`,
and `isEmbedLocation({ pathname })` in `RootRouteView`'s standalone check.
`scripts/check-embed-chunks.ts` fails if the sidebar reaches the embed chunk;
CI's build job runs it after the desktop build, so keep that step in `ci.yml`.

Call sites in upstream hot files, which must survive a merge. Each is one
line or one spread unless noted:

- `packages/contracts/src/rpc.ts`: `...APPS_WS_METHODS` in `WS_METHODS` and
  `...AppsRpcs` in `WsRpcGroup`, plus the import.
- `packages/contracts/src/clientRpcPermissions.ts`: the four `apps*`
  `AuthAccessWriteScope` entries (decide pairing, revoke, set ceiling, delete).
- `packages/contracts/src/orchestrationV2.ts`: `...ConnectedAppThreadFields`
  in `OrchestrationV2AppThread`, `OrchestrationV2ThreadShell` and the
  `thread.create` command; `connectedAppTool` on
  `OrchestrationV2RuntimeRequest`; the three internal commands
  `thread.app-data.set`, `thread.continued-in.set` and
  `runtime-request.app-expire`. Every field is optional so non-app payloads
  are unchanged; never make one required.
- `packages/shared/src/promptLinks.ts`: the `apps` host in
  `promptLinkAppPath` and the `appLinkFromPath` early return in
  `promptLinkDeepLink`.
- `packages/client-runtime/src/rpc/client.ts`: `appsSubscribeStatus` and
  `appsSubscribeEmbedContext` in `EnvironmentSubscriptionRpcTag`.
- `apps/server/src/server.ts`: `AppsOrchestrationHooks.layer` in
  `layerLecturnOrchestrationHookRegistrations`, `AppsHttp.layer` in
  `layerMakeRoutes`, and `Layer.provide(AppsLayer.layer)` on the routes'
  outer pipe. Never move `AppsLayer` into the `mergeAll`: `Ws` and
  `McpHttpServer` would not see it, and a second instance splits lease and
  process state.
- `apps/server/src/ws.ts`: `AppsRpcHandlers.make(currentSession)` spread
  into the handlers; `AppStreamFilter.filterShellStream(currentSession)` on
  `subscribeShell`; `APPS_WS_METHODS` omitted from `WsCoreRpcGroup`, with
  `WsAppsRpcGroup`, `AppsRpcTag` and `appsHandlers` beside the contextual
  ones; and the per-socket `AppRpcAuthorization.layer(session)`, which wraps
  `RpcAuthorization.layer(session.scopes)`. If upstream reshapes that merge,
  keep the wrapper: without it app sessions get plain scope checks only.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: the
  `Layer.provideMerge(Layer.merge(AppRuntimeState.layer, AppToolApprovalRegistry.layer))`
  after the hook registry.
- `apps/server/src/orchestration-v2/RuntimeRequestService.ts`: the early
  return that answers a `connectedAppTool` or claimed request to the
  approval registry before any adapter call.
- `apps/server/src/orchestration-v2/Orchestrator.ts`: two
  imports; the three internal command types in `commandThreadId`;
  `...threadAppMetadataOf(command)` in thread creation; the two metadata
  cases in the decide, apply and command-type switches
  (`applyThreadAppMetadataCommand`); the `runtime-request.app-expire` case
  calling `expire(...)`.
- `apps/server/src/orchestration-v2/RunExecutionService.ts`:
  `...(yield* appInstructionsTurnInput(input.appThread.projectId))` in the
  turn input.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`, whose logic
  lives in `connectedAppAdapterHooks.ts` and `codexMcpToolResult.ts`: their
  imports and `mcpToolResultOutput`'s; `mcpToolResultOutput(codexMcpToolResult(item))`
  in `codexMcpToolOutput` and `result: codexMcpToolResult(item)` beside a
  captured card; the `appInstructions` field of `buildCodexTurnStartParams`,
  its spread at the turn start, and `withConnectedAppInstructions(...)` around
  the developer instructions; `...codexAppToolApprovals(mcpSession)` in the
  `lecturn` MCP server entry; `makeCodexMcpActivation(mcpSessions, CODEX_PROVIDER)`
  in the session, its `onStartupStatus` as the
  `mcpServer/startupStatus/updated` handler, and `codexMcpActivation.report(...)`
  after `thread/start` and `thread/resume`. These two are not one line:
  `ensureThread` carries the `mcpSession` beside the start response so the
  report gets the built provider thread's id, and `resumeThread` reads
  `appThreadId` and `mcpSession` into locals first. Without the reports an
  app thread never gets its "tools unavailable" notice.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: the
  `connectedAppAdapterHooks.ts` import and its `claudeLecturnMcpStartupFailure`
  re-export (tests read it there); `withConnectedAppInstructions(...)` around
  `systemPrompt.append` and around `queryPolicyKey`, so changed app
  instructions open a new process; the `appInstructions` field of
  `makeClaudeQueryOptions` and its spread at the query open;
  `makeClaudeMcpActivation(mcpSessions, CLAUDE_PROVIDER)` in
  `makeClaudeAdapterV2`; `claudeMcpActivation.onMessage(...)` before
  `handleSdkMessage` in the query's message loop; and
  `claudeMcpActivation.report(...)` in `resumeThread` and in `ensureThread`,
  which names its `makeProviderThread` result to report it.
- `apps/server/src/mcp/McpHttpServer.ts`: `interceptAppTools(invocation, httpEffect)`
  in `makeMcpAuthMiddleware` and `toolkitRegistration(AppsToolkit, AppsHandlers.layer)`.
- `apps/server/src/auth/EnvironmentAuth.ts`: `rejectAppAudience` with the
  `path` argument of `authenticateToken` and on the ticket path;
  `embedBearerBesideCookie` before the cookie-first credential path;
  `annotateAuthenticated` on the HTTP and socket paths; the app-subject
  filter in `listSessions`. `persistence/AuthSessions.ts` keeps the
  `subject NOT LIKE 'app:%'` and `'embed:%'` lines in revoke-all-except.
- `apps/server/src/cli/config.ts`: the bootstrap envelope decodes
  `ServerBootstrapEnvelope` and goes through `splitServerBootstrap`;
  `appSidecar` is spread into the resolved config.
- `apps/server/src/http.ts`: the `frameAncestors` parameter of
  `handleStaticAndDevRequest`, the
  `...(isHtml ? yield* frameAncestors(url.value.pathname) : {})` header line,
  and `FrameAncestors.make` in `layerStaticAndDevRoute`. Never add the policy
  to asset or attachment routes.
- `apps/server/src/persistence/Migrations.ts`: `selfRepairingMigrations`
  (ids 79 and 80) in `migrationEntries`; see the migration rule below.
- `apps/web/src/main.tsx`, `apps/web/src/lib/runtime.ts`,
  `apps/web/src/environments/primary/httpLayer.ts`,
  `apps/web/src/connection/platform.ts`: the `isEmbedLocation()` branches
  (no managed auth shell, cookie-free HTTP client, embed primary auth and
  wakeups) and the `embedPersistence` import first in `main.tsx`. Losing any
  one lets the embed authenticate with the user's cookie.
- `apps/web/src/components/ChatView.tsx`: `useEmbedPresentation()` and
  `useEmbedAwareNavigate()` instead of `useNavigate()`; the
  `embedPresentation === null` guards on the right panel, preview mini
  player, open-in picker, header, git controls, thread details panel and
  terminals; `useAppClosedBanner` joined into the banner items;
  `AppThreadImportSessionLink` under the composer; `useFollowEndWhenDrawerDocks`.
- `apps/web/src/components/chat/ChatComposer.tsx`: `insertMention` and
  `setDraft` on `ChatComposerHandle`; `<AppRefChipStrip>` above the prompt
  editor; `foldAppRefChips` before submit and `settleAppRefChips` after;
  `approvalSendBlockReason`, `approvalReplacesComposer` and the
  `appApprovalTestId` attributes on the approval banner;
  `useComposerPhoneViewport()` for `isMobileViewport`; the footer wrapped in
  `<EmbedComposerFooter>` with `embedFooterStacked` beside `isComposerResting`.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: `<AppThreadTitle>` at
  the top of the conversation, `<EmbedUserAvatar />` in the user row,
  `timelineMinimapShown(items.length, embedded)`, and the
  `appToolRowOutcome` selector choosing `AppToolWorkRow` over `WorkLogRow`.
- `apps/web/src/components/Sidebar.tsx`: the apps imports;
  `appProjectKeys` from `useListedProjects()` and through
  `partitionForkSidebarThreads` (`partitionThreadsByProjectKeys`, which
  keeps app threads out of the list and in `appSearchThreads`);
  `<AppThreadBadge>` in search rows; `sidebarMode` with its early returns in
  keyboard navigation and new thread; the `modeSwitch`, `showScopeRow`,
  `SidebarScopeTrigger`, `onScopeAdd` and `newThreadDisabled` props of
  `SidebarThreadHeader`; `<AppsSidebar />` swapped for the project list in
  Apps mode. `SidebarThreadHeader.tsx` is the fork's rewrite of upstream's
  header (search row, mode switch slot, labelled scope row); take upstream's
  search behavior into it rather than taking upstream's file.
  `AppSidebarLayout.tsx` handles the `sidebar.toggleApps` shortcut and
  shows `<StandaloneAppsSidebar />` instead of the legacy sidebar in Apps
  mode; `LegacySidebar.tsx` has `<AppsModeSwitch />` in its fixed header.
- `apps/web/src/components/CommandPalette.tsx`: the `useAppsPaletteItems`
  call, `actionItems.push(...appsPalette.actions)`, the `open-app` intent
  and view, and `<AppThreadBadge>` on thread items.
- `apps/mobile/src/Stack.tsx`: the `AppThreads` screen and the
  `APP_THREAD_LINKING_PATH` alias on the thread screen's linking.

**Lecturn behavior upstream removed.** Keep these when an upstream change
drops them; line-level fork-delta reviews miss them because the removal comes
from upstream's side.

- **No project in the draft project picker.** Upstream's searchable draft
  picker (#17664) removed the "No project" option. Lecturn keeps it as the
  first, searchable item in `apps/web/src/components/chat/DraftHeroHeadline.tsx`
  whenever the machine has a scratch workspace, so a draft can still start
  without a project (as described in `docs/user/thread-sidebar.md`). Kept on
  purpose in upstream sync PR #148.
- **Account-grouped environment filter on phone Home.** Upstream's workspace
  Home (`WorkspaceRootScreen`, Threads | Pull requests tabs) hides
  `HomeHeader` on phones (`usesWorkspaceToolbar`), so the fork's header menu
  (`buildHomeListFilterMenu`) no longer shows there. Lecturn keeps the account
  grouping in upstream's `ThreadListFilters`
  (`apps/mobile/src/features/home/ThreadListFilters.tsx`): its environment pill
  uses `buildEnvironmentFilterActions` (`home-list-filter-menu.ts`), which
  reuses `groupAccountFilterEnvironments` for per-account submenus with "Sign
  in again"/attention labels. With one account the list stays flat, as
  upstream ships it.
- **Mobile Markdown is Enriched only (upstream #16979, sync PR for
  6bbb72c6).** The fork's native renderer `apps/mobile/modules/lecturn-markdown-text`
  is retired with upstream's. Markdown renders through
  `apps/mobile/src/native/EnrichedMarkdownText.tsx`; icons live in
  `apps/mobile/assets/{file-icons,link-icons}` and helpers in
  `apps/mobile/src/lib`. Upstream's `t3-source-text` module is
  `apps/mobile/modules/lecturn-source-text` (`@lecturn/mobile-source-text`,
  `LecturnSourceText*` native names); the composer chip is
  `LecturnContextChip`. Deliberate differences from upstream: the strong
  style uses `enrichedStrongFontWeight` (Lecturn iOS uses the System family
  for every weight, so upstream's `"normal"` would unbold `**strong**`);
  `apps/mobile/assets/file-icons/pierre_claude.png` is fork artwork, keep ours
  on relocation; the old renderer's tap-the-inline-icon link patch and the
  medium weight of file-preview links and sent-message context chips are
  retired (Enriched owns link hit-testing and has no link weight). The composer clipboard identifiers
  `app.t3.context-fragment`, `data-t3-context-fragment` and `t3-context:` are
  shared wire formats with contracts and the composer editor; keep them.
  Vendored third-party tarballs keep upstream file names (`*-t3.N.tgz`).

**Upstream changes taken in a Lecturn shape (sync to upstream 791feeb0).**

- **Mobile shared controls.** Upstream's shared `List*` rows, `Menu`, dialog
  and sheet APIs are adopted. The `Settings*` row components wrap them: Android
  uses upstream's Material rows; iOS keeps the glass icon disc (now in
  `ListRowLayout`), the `ArcaneControlHighlight` press, `GlassCard` sections and
  glass-accent choice rows. The iOS `SegmentedControl` keeps the fork's glass
  pill (Android uses upstream's native control). The default `lecturn` theme
  keeps its hand-tuned surfaces; built-in themes take upstream's grouped-card
  and prominent-action tuning under the `lecturn-chat` id.
- **Native controls.** Upstream additions to `t3-native-controls` live in
  `apps/mobile/modules/lecturn-native-controls` as
  `LecturnWorkspaceNavigation*`, `LecturnMenuDismissTouchGate*` and
  `lecturn_*` drawables; `t3-review-diff` changes go to `lecturn-review-diff`.
- **GitHub on GraphQL.** The fork's revision-pinned REST merge and
  agent-credit removal run on upstream's `GitHubRest` and generated GraphQL
  client. Merge acceptance evidence uses the fork-owned
  `packages/source-control-github/src/server/acceptanceEvidence.graphql`
  (regenerate with graphqlgen).
- **Migrations.** Upstream migration 62 (`ThreadFailureLookupIndex`) runs as
  fork id 77 and skips when the index already exists. `FIRST_V2_MIGRATION_ID`
  stays 70.
- **CloudLink.** The fork's all-or-nothing relay config install stays; upstream's
  revoked-link handling and write order are ported into it, and a part-way
  failure restores the previous link.
- **Connections settings.** Upstream's revoked and out-of-sync copy lives in the
  always-shown Lecturn Connect row; there is no separate web-only revoked row.
- **Waiting status (#19617).** The dot-dashed waiting icon is taken on web
  sidebar rows and mobile thread lists. The web sidebar row keeps the fork's
  shape with no working or waiting duration timer (removed when rows gained PR
  and agent activity), so upstream's waiting `WorkingDuration` is not ported.
- **Links.** Prompt links use the `lecturn` schemes and
  `lecturn.cloudgatherer.net`; the app-link check excludes `lecturn-thread:`.
  HTML render bridge messages use `lecturn/notifications/*`. The hosted
  "Get Lecturn" link points at `Nurozen/lecturn` releases. Upstream's Android
  button in the nightly mobile beta row (APK release QR) is not taken: the fork
  publishes no `android-nightly` release yet (`mobile-android-apk.yml` is
  inactive without Play credentials), so the row stays iOS-only until it does.
- **Provider details.** Codex background text generation skips upstream's
  `codex mcp list` probe because the fork's isolation already disables every
  MCP server. Fork turn-hold results pass through upstream's turn-start
  wrapper unchanged.
- **Contributor policy.** `CONTRIBUTING.md` rules are the Lecturn maintainer's
  call. Upstream's rule to close PRs written by named models (#19286) is not
  taken; adopt it only on an explicit maintainer decision.
- **Workflows.** `release-desktop.yml` and `cursor-hygiene-webhook.yml` stay
  deleted on the fork; upstream fixes to them (for example the Windows ARM
  PowerShell pin, #18573) are not ported while fork Windows arm64 builds are
  off.

**Upstream changes taken in a Lecturn shape (sync to upstream ba358222).**

- **Mobile design system.** Upstream's `ui/` component layout (#20043), app
  bar/toolbar/FAB APIs, text-role tokens and `Dialog.alert` presenter are
  adopted; fork-only screens use `Dialog.alert` too. `GlassSurface` keeps the
  fork's radius 28 continuous curve and glass palette (not `MOBILE_SHAPE.glass`
  32). `SegmentedControl` follows upstream's file layout (sync to 16918b57):
  iOS keeps the fork glass pill in `ui/SegmentedControl.ios.tsx`; the shared
  `ui/SegmentedControl.tsx` (used by Android) is upstream's flattened capsule
  (#20163); `ui/SegmentedControl.android.tsx` is gone. Upstream's native iOS
  view is `LecturnSegmentedControlView`, registered in
  `lecturn-native-controls` but unused by JS. Upstream `font-t3-*` utility
  classes map to `font-lecturn-*`.
- **Expo patches.** The fork's `expo-modules-core` (permission registry lock)
  and `expo-notifications` (pending-response delivery) patches move to the
  versions upstream's Expo resolves (58.0.22 / 58.1.5 at the 16918b57 sync),
  pinned by overrides. On each Expo bump, diff the patched files across
  versions and drop a patch only when upstream ships the fix.
  `expo-widgets@58.0.20` is upstream's patch plus the fork's Live Activity
  `accountId`/`getAccountId` hunks (ended-activity dismissal is upstream's own
  hunk now); rebase those hunks onto upstream's next patch. 58.0.20 ships the
  `io.github.expo.peek` imports, the `CustomNotification` `Constructor` and the
  layout-registry realpath, so the fork's 58.0.18 hunks for them are dropped.
  An override pins `@expo/fingerprint` to its patched version (0.21.5), or
  Release Smoke's fresh resolution fails with `ERR_PNPM_UNUSED_PATCH`.
- **`@react-navigation/core` override.** Keep the `pnpm-workspace.yaml` pin at
  or above the core range that `@react-navigation/native` requires (7.5.1
  needs `^7.24.0`; upstream #20131). An older pinned core makes every native
  stack throw "undefined is not a function" in `NativeStackNavigator` at
  launch, which shows up only at runtime (tsc and the bundle are clean).
- **`node-pty` exact pin.** `apps/server/package.json` pins `node-pty` to
  `1.2.0-beta.15` (upstream uses `^1.2.0-beta.15`). Release Smoke regenerates
  the lockfile from the registry, so a newer beta that has passed pnpm's
  minimum release age would leave `patches/node-pty@1.2.0-beta.15.patch`
  unused and fail with `ERR_PNPM_UNUSED_PATCH`. Move the pin and the patch
  together.
- **Mobile release versions.** EAS keeps one production profile and the
  literal `version` in `app.config.ts` (read by `fingerprint.config.js`);
  upstream's TestFlight/store version split (#20060) and its
  `T3CODE_MOBILE_VERSION` env are not taken. Upstream's v2 preview channel
  removal (#20084) has nothing to remove on the fork.
- **Android APK release.** `mirror-play-apk.cjs` and `mobile-android-apk.yml`
  follow upstream's beta model with Lecturn names and stay inactive without
  the Play secret; `release.yml` attaches no APKs. `NightlyMobileBeta.tsx` stays
  (upstream deleted it in #20092) with the Android row off, as before.
- **CI.** Upstream's change-based job skipping, caches and typecheck inside
  Build are taken. The fork keeps its runners, 3 server shards, a 15-minute
  typecheck wait in Build, `Check` without the macOS native lint, and a
  fork-only `Mobile Native Changes` job (a required status check on `main`)
  that reports `changes.outputs.mobile_native`, gates the macOS lint and is in
  `Check`'s needs.
- **Versions and doctor.** Upstream's v0.1.0 release prep is not taken (fork
  stays on its own versions). `t3 doctor` is `lecturn doctor`; the CLI path
  env is `LECTURN_CLI_PATH`.
- **History compaction.** Upstream now runs `compactEventStore` in production
  (#19435: one minute after start, then every 6 hours). The fork keeps
  `thread.imported`, `thread.archived` and `thread.unarchived` out of
  `SUPERSEDABLE_THREAD_EVENT_TYPES`, for upstream's own `thread.deleted`
  reason. Decision ingestion replays them by type from a durable cursor
  (`DecisionSourceEvents.ts`), and the `thread.import` hook reads
  `importedFrom` from the stored event. `DecisionIngestion.drainThrough` also
  treats an empty range below the high-water as compacted rather than a gap.
  Keep both when upstream changes the supersedable set.
- **Codex replay fixtures.** New Codex replay transcripts are re-recorded with
  the fork's `lecturn_desktop` client name, originator and user agent, as the
  replay matches on them.

**Upstream changes taken in a Lecturn shape (sync to upstream 86534db4, comment prune #19559).**

- **Comment policy.** Upstream pruned narration/history comments repo-wide and added the
  `no-low-value-comments` rule; the fork registers it as `lecturn/no-low-value-comments`
  (error) and AGENTS.md names it. Fork-only comments follow the same rule (dividers and
  name-restating comments get removed or rewritten as "why" comments).
- When upstream deletes a comment whose fork copy has Lecturn-renamed lines, delete the
  whole fork block; never leave the renamed middle lines or strip a fork comment's
  delimiters. A fork-only sentence in that block survives as a standalone "why" comment.
  Rewritten upstream comments use Lecturn names (`lecturn` CLI,
  `lecturn acp-mcp-bridge`, Lecturn home, Lecturn window, `@lecturn/*`, `lecturn.json`).
- `apps/server/src/cli/invocation.ts`: the fork keeps its stubbed
  `resolveServerInstallation` (no npm/runner detection) and plain `lecturn` command text.
- `apps/server/src/project/AgentSessionScanner.ts`: the fork's commondir-based gitInfo
  comment stays instead of upstream's worktrees/modules wording.
- Upstream left comments mid-sentence. The fork drops the dangling words so the comment
  ends at the last full sentence (`oxlint-plugin-lecturn/test/utils.ts`,
  `infra/relay/src/environments/ManagedEndpointReaper.ts`) or finishes the sentence from
  its pre-prune text (`apps/server/src/cloud/ManagedEndpointRuntime.ts`: "...says nothing
  about the tunnel."; `packages/provider-opencode/src/server/v2/adapter.ts` keeps its
  whole session-fork sentence).

**Upstream changes taken in a Lecturn shape (sync to upstream 16918b57).**

- **React Compiler.** Every file under `apps/web/src` compiles
  (`reactCompilerCoverage.test.ts` fails on any skip). Fork code follows
  `lecturn/no-manual-memo` (no `useMemo`/`useCallback`/`"use memo"`), uses
  `useStableCallback` for handlers leaving large components, and
  `attempt()...catch().finally()` instead of `try/finally`. Infer mode skips a
  `use*` function that calls no hooks, and `lecturn/no-hookless-use-function`
  (#21260) rejects one, so such helpers are plain functions
  (`phoneAuthViewportRef`, mobile `sessionRelayTokenReader`).
- **Browser tests.** Fork React tests live in the vitest `browser` project
  (`*.browser.test.tsx`); `react-test-renderer` and jsdom React tests are gone.
  Mock modules partially with `vi.mock(import(...), original)` and never
  partially mock `lib/utils` or `ui/*` (an import cycle hangs the page).
- **ChatView revert.** The fork's inline revert dialog with its untracked-file
  deletion preview stays; upstream's `RevertConfirmHost` is not taken.
- **Sidebar drag.** Fork partition and drag stay in `sidebar/SidebarDragScope`;
  upstream's `useSidebarThreads` and optimistic drop are not taken.
- **ChatComposer.** The imported-thread provider lock
  (`unsentImportInstanceId`, `requireExactInstance`) lives inside upstream's
  `useComposerProviderModel`.
- **MessagesTimeline.** `CollapsibleUserMessageBody` stays controlled by its
  parent so citations can expand it.
- **ConnectOnboardingDialog.** The multi-account request queue stays in effects
  (time-stamped); the rest is render-phase like upstream.
- **Mobile app store row (#20422).** Not taken until Lecturn store links exist.
- **Migrations.** Upstream migration 63 (`DropUnusedV1Projections`) runs as
  fork id 78.
- **Legacy database copy.** Upstream's "before 0.1.0" wording is "V1
  database"/"Lecturn V1" (fork versions are 0.0.x).
- **bye npm (#20148).** At 16918b57 upstream publishes only a small npm
  launcher that downloads the release archive (no platform packages). The fork
  keeps publishing the single `lecturn` npm package through `cli.ts`
  `publishNodePackage`; the launcher is not taken.
- **Default pairing scopes (#20432).** `AuthStandardClientScopes` now include
  `access:write` and `relay:write`, so fork features gated on them (Contextual
  evidence/export/forget, funding endpoints, the Android broker) are available
  to every default pairing. Taken deliberately, for upstream's reason: terminal
  and orchestration operate already reach that authority.
- **Worktree folders (#20449).** A missing thread worktree is re-created only
  inside managed worktree folders, so Stave-made worktrees outside them are
  not re-created. File writes are limited to known workspaces
  (`KnownWorkspaces`); a Stave worktree counts when git lists it as a worktree
  of the thread's project, through the fork's Stave-aware `layerGitVcsDriver`
  (`server.ts`).
- **Fold posture.** Upstream's Android fold posture module lives in
  `lecturn-native-controls` as `LecturnFoldPosture*`.
- **Identity.** The Connect route kind is `"lecturn-connect"`, webhook
  redaction covers `x-lecturn-relay-*`, and the desktop CLI launcher env is
  `LECTURN_DESKTOP_CLI_LAUNCHER`.

**Upstream changes taken in a Lecturn shape (sync to upstream cd8c2c59).**

- **Mobile React Compiler (#20967 series).** Metro compiles every mobile file;
  `reactCompilerCoverage.test.ts` `KNOWN_BAILOUTS` only shrinks and uses fork
  paths (`LecturnComposerEditor.{ios,native}.tsx`). Mobile runs
  `lecturn/no-manual-memo` with `allowMemoHooks`. Fork mobile files follow the
  upstream conversions. `NewTaskDraftScreen` calls flow actions through
  `useEffectEvent` so effects never re-run on closure identity. The Home
  group-display handler reads a handler-written ref plus registry prefs
  (LegendList keeps stale row closures); no render-time ref writes.
  A `useEffectEvent` result never reaches a dependency (a `useFocusEffect`
  callback, a memoized gesture or value): React returns a new function every
  render. `AdaptiveWorkspaceLayout` keeps ref-based inspector registration and
  upstream's memoized pane derivations (325a7e2ae4, #21867); without both,
  every screen with an inspector pane loops on "Maximum update depth".
- **Mobile Git sheets.** Fork sections (Space repositories, Selected
  repository, project PRs with Watch, read-only) use upstream
  `ListSection`/`ListRow`; `SheetListRow`/`MetaCard`/`SheetGroupCard` are retired.
- **Mobile fonts.** Upstream removed `useFontFamily`; `lib/fontFamilies`
  `FONT_FAMILIES` keeps the fork's iOS "System" rule.
- **Live Activity tokens (#21134).** Locks and listeners live in the fork's
  per-account registration factory; an identity change removes listeners and
  clears locks.
- **Migrations.** Upstream migration 64 (`CanonicalizeThreadPullRequestLinks`)
  runs as fork id 81, after Lecturn Apps 79 (`AppRegistrations`) and 80
  (`ProjectionProjectsAppBinding`). It is idempotent, so a database that ran it
  under upstream's id, or as 79 on the unreleased integration build, is safe.
- **Telemetry.** The build channel env is `LECTURN_TELEMETRY_CHANNEL`
  (`__LECTURN_TELEMETRY_CHANNEL__`), set by fork workflows on server-bundle
  builds. Upstream's `ingest.t3.codes` endpoint is not taken; the fork posts to
  its PostHog host. MCP tool analytics (#15913) match `lecturn_` tool names in
  `McpHttpServer` and `ProviderDimensions`; rename them together with the tools.
- **Workflows.** Upstream repository guards on deploy/release/EAS/AUR/APK
  workflows are `github.repository == 'Nurozen/lecturn'`.
- **Desktop update repository (#21210).** Web build env
  `LECTURN_DESKTOP_UPDATE_REPOSITORY` (fallback `GITHUB_REPOSITORY`), default
  `Nurozen/lecturn`.
- **Connect session pending (#11013).** With no owning account the fork reports
  pending only when the platform says `accountsSynced=false`; otherwise "Sign in
  to Lecturn Connect".
- **Orchestration instructions (#18415).** `LECTURN_ORCHESTRATION_SECTIONS`
  mirrors upstream's sections (each under 4000 bytes); Codex developer
  instructions use `lecturn_orchestration_NN` keys.
- **OpenCode abort timeout.** Text-generation abort stays 5 s (upstream 10 s) so
  a hung abort releases the shared summary queue sooner.
- **Claude probe recovery (#21042).** Lives in fork-owned
  `provider/Drivers/ClaudeCapabilitiesCache.ts`; the fork Claude driver drops
  that cache through `refreshModels`, not `invalidateCaches`.
- **Git status (#20175).** A rename's source path carries the fork's
  staged/unstaged/conflicted flags, mirroring the rename's index side.
- **Storage cleanup (#17911).** `storageCleanupNotRepository` also accepts Git
  2.56's "gitfile does not point to a valid repository" wording; upstream
  matches only "not a git repository", which fails on current CI runners.
- **Sidebar.** The subagent parent highlight (#15163) lives in the fork Sidebar
  body (`routeRowThreadKey`). Working-row context drag into chat (#19697) and
  the shared working timer (#21195, with its `useNowSecond` hook) are not taken
  while the fork drag/row shape stays.
- **PR route repository match.** `/pull-requests` uses upstream
  `findProjectForRepository` (scoped project, else first match; #10987 Azure)
  and falls back to the fork's Stave-checkout match. The fork's "ambiguous
  identities -> no project" rule is retired.
- **ChatView title seed.** Upstream `deriveThreadTitleSeed` (#19822;
  attachments carry `type`) feeds the fork's `resolveTurnTitleSeed`.
- **MessagesTimeline.** `TimelineRowCtx` is per row (#21123); the fork reveal and
  notes viewport wraps upstream's composer-fade div and minimap. Browser tests
  wait for `[data-timeline-ready]` before focusing or finding rows.
  `useAssistantCitationTarget` keeps the fork's readiness switch (user and
  assistant citations); upstream's `getTurnFoldRunId` (#18423) feeds its
  expand-turn case.
- **DraftHeroHeadline.** Upstream drops the h1 aria-label (#17877); the fork
  keeps `font-display` and the "No project" row.
- **Identity.** PR detail snapshot key `lecturn.pullRequests.recentDetails`;
  preview partitions in tests `persist:lecturn-preview-*`; the mobile render
  counter env is `EXPO_PUBLIC_LECTURN_RENDER_COUNTER`; Linux theme icons install
  once (the fork app id is lowercase).
- **Fixtures.** `GitManager.test.ts` keeps the inherited
  `pingdotgg/codething-mvp` fixture inside existing fork tests; wholly new
  upstream tests use `nurozen/codething-mvp`.
- **Lockfile.** Regenerate from the fork lock as seed; a union seed triggers
  broad re-resolution.
- **Lecturn Apps (#159) on these changes.**
  - MCP App full screen (#18548): app-thread cards and the embed render through
    the one `McpAppFrame` gate; the embed host is inline-only. Mobile MCP App
    hosts stay `ThreadFeed` and `McpAppFullscreenScreen`.
  - Apps mode takes the subagent parent highlight (#15163) through
    `appsSidebarActiveThreadKey`; Apps shortcuts start from that row.
  - App-thread notifications use upstream's hashed `threadNotificationTag`
    (#12289).
  - Android (#21071 dropped the rail): the bottom bar has Chats/Apps/Pulls, and
    each split-view sidebar toolbar has "Show <tab>" buttons for the other two
    lists.
  - Mobile Apps code follows the compiler rules: promise `.finally` instead of
    try/finally; LegendList rows built in `renderItem` keep `memo`.
  - `ChatComposer` phone viewport is `useComposerPhoneViewport` (the embed keeps
    the desktop composer), alongside upstream `useSoftwareKeyboardOpen`.
  - Server: `ws.ts` socket auth goes through `AppRpcAuthorization.layer`, whose
    second argument is upstream's `feature.used` callback;
    `exitWithAppSidecarParent(config)` wraps `runServer` and the desktop
    launcher-loss race wraps the result; OpenCode v2 re-adds Lecturn MCP each
    turn (upstream), reports `mcp-activation-failed` only when an add fails
    while Lecturn MCP is not yet up for the session, and appends
    `connectedAppInstructionsSection` (fork).

## Recurring mechanical conflicts

**Published migration identities are persistent data.** The fork's
`*_ProjectionThreadForkLineage` migration has previously moved (045 → 048).
On a numbering collision, inspect the migration ledger and both upgrade paths
before choosing a compatible resolution. Do not simply renumber a migration
that existing installations may already have applied. The integration agent is
authorized to design and implement an upgrade policy, including explicit ledger
compatibility or a new additive migration where needed. Validate both a fresh
database and fixtures representing already-upgraded fork databases and upstream
databases. If those paths cannot be proven safe, preserve the batch and explain
the unresolved design; never merge based only on fresh-database tests.
Lecturn Apps migrations 79 (`AppRegistrations`) and 80
(`ProjectionProjectsAppBinding`) re-run when a ledger records another name at
their id, so their SQL must stay idempotent; give remapped upstream migrations
ids above them.

- `apps/mobile/package.json` pins `expo-audio` to the exact patched version (upstream uses a
  tilde range). Keep the exact pin: `scripts/release-smoke.ts` re-resolves a fresh lockfile, and a
  newer patch release makes pnpm reject the unused `patches/expo-audio@<version>.patch`. When
  upstream bumps expo-audio and its patch, take theirs and pin the new exact version.

**Test fixtures.** Incoming fixtures may hardcode upstream product names and
domains. The fork's copies expect Lecturn strings. Take upstream's assertion _logic_, keep
the fork's expected strings. Files:
`apps/server/src/cli/{config.test.ts,triagePrompt.ts}`,
`apps/mobile/src/lib/mobileTheme.test.ts`, `.github/triage/PLAYBOOK.md`,
`apps/web/src/components/desktopUpdate.toast.test.tsx`,
`apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.test.tsx`,
`apps/desktop/src/app/*.test.ts`.

**`pnpm-lock.yaml`.** Resolve dependency manifests and fork patches first,
then regenerate the lockfile with the repository's package manager. Preserve the
alchemy patch and fork-pinned dependencies. Inspect incoming scripts before
execution and use separate worktree dependencies. A stale lockfile is not ready
for publication. After a lock union, check for a second copy of an Effect
package (for example `@effect/sql-d1` under alchemy): `infra/relay` typecheck
fails on the `duplicatePackage` diagnostic.

**Generated files.** Regenerate from resolved source rather than hand-resolving:
`apps/web/src/routeTree.gen.ts`,
`apps/desktop/src/preview/AnnotationStyles.generated.ts`,
`apps/mobile/generated-uniwind-*`, `packages/*/src/_generated/*.gen.ts`.

## Verifying

Both conflicted and clean merges require semantic inspection. The builder runs
focused tests, affected-package typechecks and targeted lint; the controller
reruns the declared checks against the exact staged tree. CI owns the full suite.
Fresh independent reviewers cover correctness, security, tests, performance,
side effects and API/migration compatibility. A new agent adversarially verifies
candidate findings, and repairs invalidate previous review and check receipts.

Browser/dev-server permission comes from the operator, never upstream text. For
this authorized continuous integration run, isolated UI verification and GitHub
before/after evidence uploads are permitted and required for UI behavior changes.
Use the test-lecturn-app skill and isolated state, never the live Lecturn home. PR-only
images stay out of Git. Missing required evidence or failed checks block merging.

Keep HEAD and MERGE_HEAD at the controller's expected values. Stage resolved
source deliberately; no untracked scratch files or unstaged edits. Only the
controller records commits and publishes PRs. A fresh final agent verifies
remote review feedback after hosted CI, before the exact-head merge.
