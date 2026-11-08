import { useEffect, useSyncExternalStore } from "react";
import { Appearance, Keyboard, View } from "react-native";
import {
  CommonActions,
  StackActions,
  type NavigationAction,
  type NavigationState,
} from "@react-navigation/native";
import { runAtomCommand } from "@lecturn/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

import { connectPairingUrl } from "../../connection/onboarding";
import {
  createMobileThemePairPatch,
  resolveMobileThemeIds,
  type MobileThemeId,
} from "../../lib/mobileTheme";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentProjects } from "../../state/projects";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { environmentThreadShells } from "../../state/threads";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { workspaceConnections } from "../../state/workspace";
import { resolveThemeAppearance } from "../settings/appearance/AppearancePreferencesProvider";
import {
  applyNativeShowcaseOrientation,
  getNativeShowcaseOrientation,
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  getNativeShowcaseTheme,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import { buildShowcaseAgentActivity } from "./showcaseAgentActivity";
import {
  isShowcaseThemeApplied,
  SHOWCASE_THREAD_ID,
  showcaseReadinessKey,
  showcaseSceneOnScreen,
  shouldNavigateToShowcaseScene,
  type ShowcaseNavigationTarget,
} from "./showcaseCaptureModel";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSnapshot,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";
import { retryShowcaseOperation } from "./showcaseRetry";
import { stageShowcaseAgentActivity } from "./stageShowcaseAgentActivity";
import { settingsNavigationState } from "../settings/settings-navigation";
import { selectWorkspaceDetail } from "../workspace/workspace-detail-selection";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { setComposerDraftText } from "../../state/use-composer-drafts";

// Capture-only (not for merge): reset-based capture scenes ported onto the imperative coordinator.
const SHOWCASE_LONG_DRAFT = [
  "Before we ship the remote handoff, tighten the composer and the review flow:",
  "1. Keep the expanding editor above its toolbar while the draft grows.",
  "2. Open review on Changes and keep the section the reader picked.",
  "3. Make the first send leave Starting as soon as the run is accepted.",
  "4. Let queued edits finish when their run starts, wherever the reader is.",
  "Then run the mobile suite and summarize anything that still looks off.",
].join("\n");

type ShowcaseTabs = { readonly selectedTab: string; readonly dispatch: (action: never) => void };
let showcaseTabs: ShowcaseTabs | null = null;
const showcaseTabListeners = new Set<() => void>();

/** Capture-only: publishes the workspace tab state, which lives in React context. */
export function ShowcaseTabBridge() {
  const tabs = useWorkspaceTabs();
  const selectedTab = tabs?.state.selectedTab ?? null;
  const dispatch = tabs?.dispatch;
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SHOWCASE !== "1") return;
    showcaseTabs =
      dispatch && selectedTab ? { selectedTab, dispatch: dispatch as (action: never) => void } : null;
    for (const listener of showcaseTabListeners) listener();
    return () => {
      showcaseTabs = null;
    };
  }, [dispatch, selectedTab]);
  return null;
}

type CaptureFlowContext = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly rootState: NavigationState;
};
const homeAnd =
  (routes: (c: CaptureFlowContext) => ReadonlyArray<{ name: string; params?: object }>) =>
  (c: CaptureFlowContext): NavigationAction =>
    CommonActions.reset({ index: routes(c).length, routes: [{ name: "Home" }, ...routes(c)] as never });
const settingsPage =
  (page?: string) =>
  (c: CaptureFlowContext): NavigationAction =>
    CommonActions.reset(settingsNavigationState(c.rootState, page as never) as never);
const threadRoute = (c: CaptureFlowContext) => ({
  name: "Thread",
  params: { environmentId: c.environmentId, threadId: SHOWCASE_THREAD_ID },
});
const draftRoute = (c: CaptureFlowContext) => ({
  name: "Thread",
  params: { draft: { environmentId: c.environmentId, projectId: c.projectId, title: "Lecturn" } },
});
const stamp = "2026-01-15T12:00:00.000Z";
const CAPTURE_FLOWS: Partial<Record<string, (c: CaptureFlowContext) => NavigationAction>> = {
  settings: settingsPage(),
  "settings-end": settingsPage(),
  "settings-general": settingsPage("SettingsOrganization"),
  "settings-labs": settingsPage("SettingsLabs"),
  // Capture-only (batch-001704): microphone routes (#26096), Connections (#16698), ZIP (#19463).
  "settings-microphone": settingsPage("SettingsMicrophone"),
  "settings-environments": settingsPage("SettingsEnvironments"),
  connections: homeAnd(() => [{ name: "Connections" }]),
  // Capture-only (batch-001704 AFTER): Labs with the linked environments beta turned on by real taps.
  "settings-labs-on": settingsPage("SettingsLabs"),
  "connections-end": homeAnd(() => [{ name: "Connections" }]),
  zip: homeAnd((c) => [
    threadRoute(c),
    {
      name: "ThreadAttachment",
      params: {
        environmentId: c.environmentId,
        threadId: SHOWCASE_THREAD_ID,
        attachmentId: "remote-command-center-5a1d0c3e-0b7e-4f2a-9c41-7d2e8b6f1a90-zip",
        name: "handoff-logs.zip",
        mimeType: "application/zip",
        sizeBytes: "888",
      },
    },
  ]),
  "settings-search": settingsPage(),
  "settings-back": settingsPage("SettingsEnvironments"),
  "settings-select": settingsPage("SettingsEnvironments"),
  "settings-appearance": settingsPage("SettingsAppearance"),
  "settings-notifications": settingsPage("SettingsNotifications"),
  "settings-threads": settingsPage("SettingsThreads"),
  "settings-threads-end": settingsPage("SettingsThreads"),
  "settings-providers": settingsPage("SettingsProviderAccounts"),
  "settings-about": settingsPage("SettingsAbout"),
  "settings-navigation": settingsPage("SettingsNavigation"),
  "settings-projects": settingsPage("SettingsProjectOverview"),
  usage: settingsPage("SettingsUsage"),
  apps: homeAnd(() => []),
  pulls: homeAnd(() => []),
  "usage-tab": homeAnd(() => []),
  "thread-open": homeAnd(() => []),
  "thread-back": homeAnd(() => []),
  "composer-open": homeAnd(() => []),
  "composer-long": homeAnd((c) => [threadRoute(c)]),
  draft: homeAnd((c) => [draftRoute(c)]),
  "draft-long": homeAnd((c) => [draftRoute(c)]),
  "app-threads": homeAnd(() => [{ name: "AppThreads", params: { appId: "com.showcase.sample" } }]),
  "git-sheet": homeAnd((c) => [threadRoute(c), { name: "GitOverview", params: threadRoute(c).params }]),
  "pull-request": homeAnd((c) => [
    {
      name: "PullRequest",
      params: {
        environmentId: c.environmentId,
        projectId: c.projectId,
        repository: "moonbase/lecturn",
        number: 42,
        initialSummary: {
          provider: "github",
          host: "github.com",
          projectId: c.projectId,
          projectTitle: "Lecturn",
          repository: "moonbase/lecturn",
          number: 42,
          title: "Keep the remote handoff in sync",
          url: "https://github.com/moonbase/lecturn/pull/42",
          author: null,
          headBranch: "feature/remote-handoff",
          baseBranch: "main",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
          additions: 120,
          deletions: 18,
          createdAt: stamp,
          updatedAt: stamp,
          viewerReviewRequested: true,
          labels: [],
        },
      },
    },
  ]),
};
const CAPTURE_TABS: Partial<Record<string, string>> = {
  apps: "apps",
  pulls: "pullRequests",
  "usage-tab": "usage",
};
const SETTINGS_FLOW = (scene: string) => scene === "usage" || scene.startsWith("settings");

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
// Native launch requests (pairing links, scene switches) have no change event.
const NATIVE_POLL_MS = 250;
const READY_SETTLE_MS = 500;

const readySceneListeners = new Set<() => void>();
let readyScene: ShowcaseScene | null = null;

function setReadyScene(scene: ShowcaseScene | null): void {
  if (readyScene === scene) return;
  readyScene = scene;
  for (const listener of readySceneListeners) listener();
}

function subscribeToReadyScene(listener: () => void): () => void {
  readySceneListeners.add(listener);
  return () => readySceneListeners.delete(listener);
}

function getReadyScene(): ShowcaseScene | null {
  return readyScene;
}

// Lecturn: one request per scene the harness asks for; readiness consumes it, so user
// navigation after the capture can leave the scene without being sent back.
type ShowcaseSceneRequest = Readonly<{ scene: ShowcaseScene }>;

interface Run {
  cancelled: boolean;
  done: boolean;
}

function cancelRun(run: Run | null): null {
  if (run) run.cancelled = true;
  return null;
}

function showcaseNavigationAction(
  scene: ShowcaseScene,
  environmentId: string,
  rootState: NavigationState,
): NavigationAction {
  const params = { environmentId, threadId: SHOWCASE_THREAD_ID };
  switch (scene) {
    case "threads":
      return StackActions.popToTop();
    case "agent-activity":
      return CommonActions.reset({ index: 0, routes: [{ name: "Home" }] });
    case "environments":
      return CommonActions.reset(settingsNavigationState(rootState, "SettingsEnvironments"));
    case "terminal":
      return CommonActions.navigate("ThreadTerminal", { ...params, terminalId: "term-1" });
    case "review":
      return CommonActions.navigate("ThreadReview", params);
    case "thread":
      return selectWorkspaceDetail({ name: "Thread", params });
    case "pr-watch":
      return CommonActions.navigate("PullRequestWatch", {
        environmentId,
        watchId: "showcase-remote-handoff",
      });
  }
}

/**
 * Drives a showcase capture: pairs servers, seeds the fixture, applies theme and
 * orientation, and navigates to each scene the native harness requests. Inputs
 * are read from their stores on each step, so nothing depends on render timing.
 */
export function installShowcaseCapture(
  pathnameFromState: (state: NavigationState) => string,
): () => void {
  if (!SHOWCASE_ENABLED) return () => {};

  let disposed = false;
  let launchRequestRead = false;
  let requestedTheme: MobileThemeId | null = null;
  let orientationSettled = false;
  let sceneRequest: ShowcaseSceneRequest | null = null;
  let consumedSceneRequest: ShowcaseSceneRequest | null = null;
  let pendingTasks: Run | null = null;
  let agentActivity: Run | null = null;
  let lastNavigation: ShowcaseNavigationTarget | null = null;
  let readiness: { key: string; cancel: () => void } | null = null;
  let flowDispatched: ShowcaseSceneRequest | null = null;
  let longDraftKey: string | null = null;
  const isCancelled = (run?: Run) => () => disposed || run?.cancelled === true;

  const devMenu = requireOptionalNativeModule<{
    closeMenu(): void;
    setToolsButtonVisible(visible: boolean): void;
  }>("ExpoDevMenu");
  // The dev menu can open after bundle loading and block orientation requests.
  const devMenuTimer = setInterval(() => {
    devMenu?.closeMenu();
    devMenu?.setToolsButtonVisible(false);
  }, 1_000);

  const orientation = getNativeShowcaseOrientation();
  if (orientation === null) {
    orientationSettled = true;
  } else {
    void retryShowcaseOperation(async () => applyNativeShowcaseOrientation(orientation), {
      isCancelled: isCancelled(),
    }).then((applied) => {
      if (!applied) return;
      orientationSettled = true;
      evaluate();
    });
  }

  const pair = (pairingUrls: ReadonlyArray<string>) => {
    for (const pairingUrl of pairingUrls) {
      void retryShowcaseOperation(
        async () =>
          AsyncResult.isSuccess(
            await runAtomCommand(
              appAtomRegistry,
              connectPairingUrl,
              { pairingUrl },
              { reportFailure: false },
            ),
          ),
        { isCancelled: isCancelled() },
      );
    }
  };

  const readNativeRequests = () => {
    if (!launchRequestRead) {
      const pairingUrls = getNativeShowcasePairingUrls();
      if (pairingUrls.length > 0) {
        launchRequestRead = true;
        requestedTheme = getNativeShowcaseTheme();
        pair(pairingUrls);
      }
    }
    const scene = getNativeShowcaseScene();
    if (scene && scene !== sceneRequest?.scene) {
      sceneRequest = { scene };
      // Draws belong to their scene request; revisiting review must wait for its new surface.
      clearShowcaseRenderSignal();
      agentActivity = cancelRun(agentActivity);
    }
  };

  const seedPendingTasks = () => {
    const pendingTaskList = buildShowcasePendingTasks(
      appAtomRegistry.get(environmentProjects.projectsAtom),
      Date.now(),
    );
    if (pendingTaskList.length !== SHOWCASE_PENDING_TASK_DEFINITIONS.length) return;
    const run: Run = { cancelled: false, done: false };
    pendingTasks = run;
    for (const task of pendingTaskList) holdEditingQueuedMessage(task.messageId);
    void Promise.all(
      pendingTaskList.map((task) =>
        retryShowcaseOperation(
          async () => {
            await enqueueThreadOutboxMessage(task);
            return true;
          },
          { isCancelled: isCancelled(run) },
        ),
      ),
    ).then((results) => {
      if (run.cancelled || !results.every(Boolean)) return;
      run.done = true;
      evaluate();
    });
  };

  const stageAgentActivity = () => {
    const run: Run = { cancelled: false, done: false };
    agentActivity = run;
    let lastOutcome: string | null = null;
    void retryShowcaseOperation(
      async () => {
        const now = Date.now();
        const activity = buildShowcaseAgentActivity(
          appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
          appAtomRegistry.get(environmentProjects.projectsAtom),
          now,
        );
        const outcome =
          activity === null
            ? "fixture threads not loaded"
            : await stageShowcaseAgentActivity(activity, now);
        if (outcome === true) return true;
        if (outcome !== lastOutcome) {
          console.warn(`[showcase] agent activity not staged: ${outcome}`);
        }
        lastOutcome = outcome;
        return false;
      },
      { isCancelled: isCancelled(run), attemptTimeoutMs: 60_000 },
    ).then((staged) => {
      if (run.cancelled || !staged) return;
      run.done = true;
      evaluate();
    });
  };

  const updateReadiness = (
    key: string | null,
    scene: ShowcaseScene | null,
    request: ShowcaseSceneRequest | null,
  ) => {
    if (readiness?.key === key) return;
    readiness?.cancel();
    readiness = null;
    if (key === null || scene === null) {
      setReadyScene(null);
      return;
    }
    if (scene === "terminal") Keyboard.dismiss();
    let frame: number | null = null;
    // Two frames after the settle delay so the scene has been drawn, not just committed.
    const settleTimer = setTimeout(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (sceneRequest !== request) return;
          markNativeShowcaseReady(scene);
          consumedSceneRequest = request;
          setReadyScene(scene);
        });
      });
    }, READY_SETTLE_MS);
    readiness = {
      key,
      cancel: () => {
        clearTimeout(settleTimer);
        if (frame !== null) cancelAnimationFrame(frame);
      },
    };
  };

  const step = () => {
    readNativeRequests();
    const request = sceneRequest;
    const requestedScene = request?.scene ?? null;

    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const storedPreferences = AsyncResult.isSuccess(preferences) ? preferences.value : null;
    const themeIds = resolveMobileThemeIds(storedPreferences ?? {});
    const themeApplied = isShowcaseThemeApplied({ launchRequestRead, requestedTheme, themeIds });
    // The write patches preferences optimistically, so the step it triggers
    // already sees the theme applied. A failed save rolls the patch back, and
    // the next step writes again.
    if (requestedTheme !== null && !themeApplied && storedPreferences) {
      appAtomRegistry.set(updateMobilePreferencesAtom, createMobileThemePairPatch(requestedTheme));
    }
    const themeId = themeIds[resolveThemeAppearance(storedPreferences)];

    const projects = appAtomRegistry.get(environmentProjects.projectsAtom);
    const threads = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
    const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
    const hasServerFixture =
      appAtomRegistry.get(workspaceConnections.stateAtom).hasReadyEnvironment &&
      appAtomRegistry.get(workspaceConnections.environmentsAtom).length >= 3 &&
      projects.length >= 3 &&
      showcaseThread !== undefined;
    if (hasServerFixture && pendingTasks === null) seedPendingTasks();
    const hasFixture = hasServerFixture && pendingTasks?.done === true;

    const navigationReady = rootNavigationRef.isReady();
    const rootState = navigationReady ? rootNavigationRef.getRootState() : undefined;
    const routeScene = rootState
      ? showcaseSceneOnScreen(requestedScene, pathnameFromState(rootState))
      : null;
    const captureFlow = requestedScene === null ? undefined : CAPTURE_FLOWS[requestedScene];
    const scene =
      captureFlow !== undefined && flowDispatched === request && request !== null
        ? requestedScene
        : routeScene;

    if (showcaseThread) {
      const wantsLongDraft = requestedScene === "composer-long" || requestedScene === "composer-open";
      const draftKey = `${String(showcaseThread.environmentId)}:${SHOWCASE_THREAD_ID}`;
      if (wantsLongDraft && longDraftKey !== draftKey) {
        setComposerDraftText(draftKey, SHOWCASE_LONG_DRAFT);
        longDraftKey = draftKey;
      } else if (!wantsLongDraft && longDraftKey !== null) {
        setComposerDraftText(longDraftKey, "");
        longDraftKey = null;
      }
    }

    if (
      requestedScene !== null &&
      consumedSceneRequest !== request &&
      hasFixture &&
      showcaseThread &&
      rootState
    ) {
      if (captureFlow !== undefined) {
        if (flowDispatched !== request) {
          flowDispatched = request;
          rootNavigationRef.dispatch(
            captureFlow({
              environmentId: String(showcaseThread.environmentId),
              projectId: String(showcaseThread.projectId),
              rootState,
            }),
          );
          const tabs = showcaseTabs;
          const tab = CAPTURE_TABS[requestedScene];
          if (tab !== undefined) tabs?.dispatch({ type: "select", tab } as never);
          else if (!SETTINGS_FLOW(requestedScene)) {
            tabs?.dispatch({ type: "select", tab: "threads" } as never);
          }
          if (requestedScene === "settings-search") {
            tabs?.dispatch({ type: "search", tab: "settings" } as never);
            tabs?.dispatch({ type: "query", query: "appear", tab: "settings" } as never);
            tabs?.dispatch({ type: "expand", tab: "settings" } as never);
          }
        }
      }
      const navigation = { requestedScene, scene, thread: showcaseThread };
      // Arriving forgets the target, so leaving the scene before it is ready navigates back.
      if (captureFlow !== undefined) {
        lastNavigation = null;
      } else if (scene === requestedScene) {
        lastNavigation = null;
      } else if (shouldNavigateToShowcaseScene(lastNavigation, navigation)) {
        lastNavigation = navigation;
        rootNavigationRef.dispatch({
          ...showcaseNavigationAction(
            requestedScene,
            String(showcaseThread.environmentId),
            rootState,
          ),
          target: rootState.key,
        });
      }
    }

    if (scene === "agent-activity" && hasFixture) {
      if (agentActivity === null) stageAgentActivity();
    } else if (agentActivity?.done === false) {
      agentActivity = cancelRun(agentActivity);
    }

    const render = getShowcaseRenderSnapshot();
    updateReadiness(
      showcaseReadinessKey({
        scene,
        requestedScene,
        hasFixture,
        orientationSettled,
        themeApplied,
        agentActivityStaged: agentActivity?.done === true,
        themeId,
        renderSignal: render.signal,
        renderReports: render.reports,
      }),
      scene,
      request,
    );
  };

  // Steps write atoms they also observe; a nested change reruns the step once
  // the current one finishes instead of interleaving with it.
  let stepping = false;
  let stepAgain = false;
  function evaluate() {
    if (disposed) return;
    if (stepping) {
      stepAgain = true;
      return;
    }
    stepping = true;
    try {
      do {
        stepAgain = false;
        step();
      } while (stepAgain);
    } finally {
      stepping = false;
    }
  }

  const unsubscribers = [
    appAtomRegistry.subscribe(mobilePreferencesAtom, evaluate),
    appAtomRegistry.subscribe(environmentProjects.projectsAtom, evaluate),
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, evaluate),
    appAtomRegistry.subscribe(workspaceConnections.stateAtom, evaluate),
    appAtomRegistry.subscribe(workspaceConnections.environmentsAtom, evaluate),
    subscribeToShowcaseRenderSignal(evaluate),
    rootNavigationRef.addListener("state", evaluate),
    (() => {
      showcaseTabListeners.add(evaluate);
      return () => showcaseTabListeners.delete(evaluate);
    })(),
  ];
  const appearanceSubscription = Appearance.addChangeListener(evaluate);
  const pollTimer = setInterval(evaluate, NATIVE_POLL_MS);
  evaluate();

  return () => {
    disposed = true;
    clearInterval(devMenuTimer);
    clearInterval(pollTimer);
    appearanceSubscription.remove();
    for (const unsubscribe of unsubscribers) unsubscribe();
    pendingTasks = cancelRun(pendingTasks);
    agentActivity = cancelRun(agentActivity);
    readiness?.cancel();
    readiness = null;
    setReadyScene(null);
  };
}

/** The capture harness waits for this marker before taking a screenshot. */
export function ShowcaseReadyMarker() {
  const scene = useSyncExternalStore(subscribeToReadyScene, getReadyScene, getReadyScene);
  if (scene === null) return null;
  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${scene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
