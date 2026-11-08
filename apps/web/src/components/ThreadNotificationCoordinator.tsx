import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  isListedThread,
  pendingSubagentRequestsByThread,
} from "@lecturn/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import type {
  AppBinding,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import type { ClientSettings } from "@lecturn/contracts/settings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform, randomUUID } from "../lib/utils";
import { readableAppStatusesAtom } from "../state/apps";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { readableSquireEnvironmentsAtom, squireEnvironment } from "../state/squires";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  reportSquireAlert,
  revealNotifiedAppThread,
  setNotificationBadge,
  squireNotificationIntents,
  type SquireNotificationIntent,
  squireNotificationTag,
  threadNotificationApp,
  threadNotificationTag,
  threadNotificationTitle,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

interface NotificationProject {
  readonly id: string;
  readonly appBinding?: AppBinding | undefined;
}

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  // The live snapshot's threads and projects: app threads alert under their app's name.
  threads: ReadonlyArray<OrchestrationV2ThreadShell> | null;
  projects: ReadonlyArray<NotificationProject> | null;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<string, { environmentId: EnvironmentId; notification: Notification }>();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  // The badge counts threads waiting on the user, so Squire alerts close with the thread ones but
  // stay out of that count.
  const squirePending = new Map<
    string,
    { environmentId: EnvironmentId; notification: Notification }
  >();

  const trackNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.size);
  };
  const trackSquireNotification = (environmentId: EnvironmentId, notification: Notification) => {
    squirePending.get(notification.tag)?.notification.close();
    squirePending.set(notification.tag, { environmentId, notification });
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    for (const { notification } of squirePending.values()) notification.close();
    pending.clear();
    squirePending.clear();
    setNotificationBadge(0);
  };

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
    projects: ReadonlyArray<NotificationProject> | null,
  ) => {
    const { thread, status } = state;
    // App threads alert like any other, even while Projects mode hides their project.
    const app = threadNotificationApp(
      projects?.find((project) => project.id === thread.projectId),
      registry
        .get(readableAppStatusesAtom)
        .flatMap((entry) => (entry.environmentId === environmentId ? [entry.app] : [])),
    );
    const open = () => {
      revealNotifiedAppThread(app);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: thread.id },
      });
    };
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    const title = threadNotificationTitle(
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed",
      app,
    );
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastId = toastManager.add({
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    const listingCapabilities = registry.get(
      environmentThreadShells.environmentListingCapabilitiesAtom(environmentId),
    );
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (!isListedThread(rawThread, listingCapabilities)) continue;
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const settled = status === "ready" && thread.latestRun?.status === "completed";
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        settled,
        completedAt: settled && Number.isFinite(completedAt) ? completedAt : null,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      threads: null,
      projects: null,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind, entry.projects);
      }),
    };
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        const snapshot =
          shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value : null;
        entry.threads = snapshot?.threads ?? null;
        entry.projects = snapshot?.projects ?? null;
        if (entry.threads !== null) {
          observeThreads(environmentId, entry, entry.threads);
          return;
        }
        entry.gate.clear();
        entry.previous = new Map();
      },
      { immediate: true },
    );
    // Which threads alert depends on the server's listing capabilities.
    const unsubscribeListing = registry.subscribe(
      environmentThreadShells.environmentListingCapabilitiesAtom(environmentId),
      () => {
        if (entry.threads !== null) observeThreads(environmentId, entry, entry.threads);
      },
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeListing();
      entry.gate.clear();
    };
    return entry;
  };

  let stopSquireAlerts: (() => void) | null = null;
  let stopAppStatuses: (() => void) | null = null;
  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (enabled) {
      stopSquireAlerts ??= startSquireAlerts(registry, router, trackSquireNotification);
      // Keeps app names loaded for the alert titles.
      stopAppStatuses ??= registry.subscribe(readableAppStatusesAtom, () => {});
    } else {
      stopSquireAlerts?.();
      stopAppStatuses?.();
      stopSquireAlerts = null;
      stopAppStatuses = null;
    }
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const notifications of [pending, squirePending]) {
      for (const [tag, entry] of notifications) {
        if (activeIds.has(entry.environmentId)) continue;
        entry.notification.close();
        notifications.delete(tag);
      }
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear?.(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopSquireAlerts?.();
    stopAppStatuses?.();
    stopModeListeners();
  };
}

/** One alert per `notification.pushed` intent; a question card writes none. */
function startSquireAlerts(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
  trackNotification: (environmentId: EnvironmentId, notification: Notification) => void,
): () => void {
  let seenByEnvironment = new Map<EnvironmentId, ReadonlyMap<SquireId, number>>();

  // Each shown alert is recorded once; the server ignores a repeat for the same card.
  const alerted = (environmentId: EnvironmentId, intent: SquireNotificationIntent) => {
    if (!registry.get(squireEnvironment.notificationAlerted.permissionAtom(environmentId))) return;
    const pushedLog = squireEnvironment.actionLog({
      environmentId,
      input: { squireId: intent.squireId, kinds: ["notification.pushed"], limit: 20 },
    });
    void reportSquireAlert(intent, {
      readLog: () =>
        Effect.runPromise(
          AtomRegistry.getResult(registry, pushedLog, { suspendOnWaiting: true }).pipe(
            Effect.map((result) => result.entries),
            Effect.timeout("10 seconds"),
            Effect.orElseSucceed(() => null),
          ),
        ),
      report: (cardId) =>
        squireEnvironment.notificationAlerted.run(registry, {
          environmentId,
          input: {
            requestId: randomUUID(),
            squireId: intent.squireId,
            cardId,
            surface: "desktop",
          },
        }),
    });
  };

  const presentSquire = (environmentId: EnvironmentId, intent: SquireNotificationIntent) => {
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      squireId?: string;
    };
    const open = () => {
      void router.navigate({
        to: "/squires/$environmentId/$squireId",
        params: { environmentId, squireId: intent.squireId },
      });
    };
    if (hasNotificationSound(mode)) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.squireId !== intent.squireId)
    ) {
      const toastId = toastManager.add({
        type: "info",
        title: intent.title,
        description: intent.body,
        data: {
          hideCopyButton: true,
          leadingIcon: <BellIcon aria-hidden className="size-4 text-info-foreground" />,
        },
        actionProps: {
          children: "Open Squire",
          onClick: () => {
            toastManager.close(toastId);
            open();
          },
        },
      });
      alerted(environmentId, intent);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(intent.title, {
        body: intent.body,
        tag: squireNotificationTag(environmentId, intent.squireId),
        silent: true,
      });
      trackNotification(environmentId, notification);
      alerted(environmentId, intent);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        open();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  return registry.subscribe(
    readableSquireEnvironmentsAtom,
    (environments) => {
      const nextSeen = new Map<EnvironmentId, ReadonlyMap<SquireId, number>>();
      for (const { environmentId, state } of environments) {
        const { seen, intents } = squireNotificationIntents(
          seenByEnvironment.get(environmentId) ?? null,
          state,
        );
        nextSeen.set(environmentId, seen);
        for (const intent of intents) presentSquire(environmentId, intent);
      }
      seenByEnvironment = nextSeen;
    },
    { immediate: true },
  );
}
