import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  isListedThread,
  pendingSubagentRequestsByThread,
} from "@lecturn/client-runtime/state/threads";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
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
import { useContext, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useAppStatuses } from "../state/apps";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import { randomUUID } from "../lib/utils";
import { squireEnvironment, useSquireEnvironments } from "../state/squires";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  revealNotifiedAppThread,
  setNotificationBadge,
  reportSquireAlert,
  squireNotificationIntents,
  type SquireNotificationIntent,
  squireNotificationTag,
  threadNotificationApp,
  threadNotificationTag,
  threadNotificationTitle,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  };
  // The badge counts threads waiting on the user, so Squire alerts close with the thread ones but
  // stay out of that count.
  const squirePending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onSquireNotification = (environmentId: EnvironmentId, notification: Notification) => {
    squirePending.current.get(notification.tag)?.notification.close();
    squirePending.current.set(notification.tag, { environmentId, notification });
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const notifications of [pending.current, squirePending.current]) {
      for (const [tag, entry] of notifications) {
        if (activeIds.has(entry.environmentId)) continue;
        entry.notification.close();
        notifications.delete(tag);
      }
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      for (const { notification } of squirePending.current.values()) notification.close();
      pending.current.clear();
      squirePending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return (
    <>
      {environmentIds.map((environmentId) => (
        <EnvironmentNotifications
          key={environmentId}
          environmentId={environmentId}
          onNotification={onNotification}
        />
      ))}
      <SquireNotifications onNotification={onSquireNotification} />
    </>
  );
}

/** One alert per `notification.pushed` intent; a question card writes none. */
function SquireNotifications({
  onNotification,
}: {
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const environments = useSquireEnvironments();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, squireId: activeSquireId } = useParams({
    strict: false,
  });
  const seenByEnvironment = useRef(new Map<EnvironmentId, ReadonlyMap<SquireId, number>>());
  const registry = useContext(RegistryContext);

  useEffect(() => {
    // Each shown alert is recorded once; the server ignores a repeat for the same card.
    const alerted = (environmentId: EnvironmentId, intent: SquireNotificationIntent) => {
      if (!registry.get(squireEnvironment.notificationAlerted.permissionAtom(environmentId)))
        return;
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
    const nextSeen = new Map<EnvironmentId, ReadonlyMap<SquireId, number>>();
    for (const { environmentId, state } of environments) {
      const { seen, intents } = squireNotificationIntents(
        seenByEnvironment.current.get(environmentId) ?? null,
        state,
      );
      nextSeen.set(environmentId, seen);
      for (const intent of intents) {
        const open = () => {
          void navigate({
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
          (activeEnvironmentId !== environmentId || activeSquireId !== intent.squireId)
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
          continue;
        }
        if (
          !hasDesktopNotifications(mode) ||
          (document.visibilityState === "visible" && document.hasFocus()) ||
          typeof Notification === "undefined" ||
          Notification.permission !== "granted"
        )
          continue;
        try {
          const notification = new Notification(intent.title, {
            body: intent.body,
            tag: squireNotificationTag(environmentId, intent.squireId),
            silent: true,
          });
          onNotification(environmentId, notification);
          alerted(environmentId, intent);
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            open();
          });
        } catch {
          // Some browsers expose Notification but reject desktop presentation.
        }
      }
    }
    seenByEnvironment.current = nextSeen;
  }, [
    activeEnvironmentId,
    activeSquireId,
    environments,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    registry,
  ]);

  return null;
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value : null;
  const threads = snapshot?.threads ?? null;
  const projects = snapshot?.projects ?? null;
  const listingCapabilities = useAtomValue(
    environmentThreadShells.environmentListingCapabilitiesAtom(environmentId),
  );
  const appStatuses = useAppStatuses();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    for (const rawThread of threads) {
      if (!isListedThread(rawThread, listingCapabilities)) continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, subagentRequest, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      // App threads alert like any other, even while Projects mode hides their project.
      const app = threadNotificationApp(
        projects?.find((project) => project.id === thread.projectId),
        appStatuses.flatMap((entry) => (entry.environmentId === environmentId ? [entry.app] : [])),
      );
      const open = () => {
        revealNotifiedAppThread(app);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
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
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
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
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: threadNotificationTag(environmentId, thread.id),
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void window.desktopBridge?.revealWindow?.().catch(() => undefined);
          open();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    appStatuses,
    environmentId,
    inAppNotificationsEnabled,
    listingCapabilities,
    mode,
    navigate,
    onNotification,
    projects,
    threads,
  ]);

  return null;
}
