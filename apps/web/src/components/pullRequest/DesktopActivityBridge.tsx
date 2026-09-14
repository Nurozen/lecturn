import {
  useLocalThreadActivityIntents,
  localThreadActivityKey,
} from "../../state/localThreadActivityIntent";
import { loadActivityProjectIcon } from "./activityProjectIcon";
import { mergeHandoffMessage } from "@lecturn/client-runtime/state/pullRequestHandoff";
import { useSagaRepositoryIndex } from "../../state/stave";
import { useActivityRecentStore } from "./activityRecentStore";
import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { describeThreadActivity } from "@lecturn/client-runtime/state/activityContext";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentThreadDetails } from "../../state/threads";
import { useThreadShells, useProjects } from "../../state/entities";
import { DESKTOP_ACTIVITY_ENABLED_EVENT } from "./DesktopActivityToggle";
import { randomUUID } from "../../lib/utils";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  DesktopActivityAction,
  EnvironmentId,
  ProjectId,
  ProjectIconOverride,
  ThreadId,
} from "@lecturn/contracts";
import { useEnvironments } from "../../state/environments";
import { pullRequestWatchEnvironment, usePullRequestWatches } from "../../state/pullRequestWatch";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  watchActivityRows,
  contextualActivityRows,
  boundedActivitySnapshot,
  threadActivityRows,
  resolveActivityAction,
} from "./desktopActivity.logic";
import { useQuickSteer } from "./useQuickSteer";
import { toastManager } from "../ui/toast";
import { formatEnvironmentQueryError } from "../../state/query";

function EnabledActivityBridge() {
  const { environments } = useEnvironments();
  const ids = useMemo(
    () =>
      environments
        .filter((environment) => environment.serverConfig?.environment.capabilities.pullRequests)
        .map((environment) => environment.environmentId),
    [environments],
  );
  const connectedIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const { values, failedEnvironmentIds } = usePullRequestWatches(ids);
  const threads = useThreadShells();
  const projects = useProjects();
  const sagaIndex = useSagaRepositoryIndex(projects);
  const interactions = useActivityRecentStore((state) => state.interactions);
  const localIntents = useLocalThreadActivityIntents();
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map());
  const inFlight = useRef(new Set<string>());
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  // Bound background detail subscriptions: shell metadata remains available for every row.
  const contextRefs = JSON.stringify(
    [
      ...threadActivityRows(threads, connectedIds, interactions),
      ...watchActivityRows(values, threads, [], projects, sagaIndex),
    ]
      .filter((row) => row.threadId && connectedIds.has(row.environmentId as EnvironmentId))
      .map((row) => [row.environmentId, row.threadId])
      .filter(
        (ref, index, refs) =>
          refs.findIndex((item) => item[0] === ref[0] && item[1] === ref[1]) === index,
      )
      .slice(0, 12),
  );
  const contextAtom = useMemo(
    () =>
      Atom.make((get) =>
        (JSON.parse(contextRefs) as [EnvironmentId, ThreadId][]).map(([environmentId, threadId]) =>
          get(environmentThreadDetails.detailAtom({ environmentId, threadId })),
        ),
      ),
    [contextRefs],
  );
  const contextDetails = useAtomValue(contextAtom);
  const rows = useMemo(() => {
    const watches = watchActivityRows(values, threads, contextDetails, projects, sagaIndex);
    const active = threadActivityRows(threads, connectedIds, interactions);
    return contextualActivityRows(
      [...active, ...watches].map((row) => ({
        ...row,
        ...(row.threadId &&
        localIntents.has(localThreadActivityKey(row.environmentId, row.threadId))
          ? {
              userAction: localIntents.get(
                localThreadActivityKey(row.environmentId, row.threadId),
              )!,
            }
          : {}),
        ...(row.threadId && !row.watchId
          ? {
              detail: (() => {
                const thread = threads.find(
                  (item) => item.environmentId === row.environmentId && item.id === row.threadId,
                );
                const detail = contextDetails.find(
                  (item) => item?.environmentId === row.environmentId && item.id === row.threadId,
                );
                return thread ? describeThreadActivity(thread, detail?.messages) : row.detail;
              })(),
            }
          : {}),
        ...(!connectedIds.has(row.environmentId as EnvironmentId)
          ? {
              status: "Offline · last observed",
              actions: row.actions.map((action) => ({ ...action, disabled: action.id !== "open" })),
            }
          : {}),
        ...(failedEnvironmentIds.includes(row.environmentId as EnvironmentId) && row.watchId
          ? {
              status: "Monitor unavailable · last observed",
              actions: row.actions.map((action) => ({ ...action, disabled: action.id !== "open" })),
            }
          : {}),
        ...(failures[row.id]
          ? {
              detail: [row.detail, failures[row.id]].filter(Boolean).join("\n"),
              mergeStatus: failures[row.id],
              ...(acknowledged.has(row.id) ? {} : { status: "Action failed" }),
            }
          : {}),
        ...(pending.has(row.id)
          ? {
              status: pending.get(row.id) ?? "Updating…",
              actions: row.actions.map((action) => ({ ...action, disabled: true })),
            }
          : {}),
      })),
      threads,
      projects,
      contextDetails,
    );
  }, [
    values,
    threads,
    connectedIds,
    pending,
    failures,
    acknowledged,
    failedEnvironmentIds,
    contextDetails,
    projects,
    sagaIndex,
    interactions,
    localIntents,
  ]);
  const iconRequests = JSON.stringify(
    [
      ...new Set(
        rows
          .slice(0, 200)
          .flatMap((row) => (row.projectIcon ? [JSON.stringify(row.projectIcon)] : [])),
      ),
    ].slice(0, 64),
  );
  const [iconImages, setIconImages] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let disposed = false;
    void Promise.all(
      (JSON.parse(iconRequests) as string[]).map(
        async (key) =>
          [key, await loadActivityProjectIcon(JSON.parse(key) as ProjectIconOverride)] as const,
      ),
    ).then((entries) => {
      if (!disposed)
        setIconImages(
          new Map(
            entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
          ),
        );
    });
    return () => {
      disposed = true;
    };
  }, [iconRequests]);
  const publishedRows = useMemo(
    () =>
      rows.map((row) => {
        const url = row.projectIcon ? iconImages.get(JSON.stringify(row.projectIcon)) : undefined;
        return url ? { ...row, projectIconDataUrl: url } : row;
      }),
    [rows, iconImages],
  );
  const command = useAtomCommand(pullRequestWatchEnvironment.command, { reportFailure: false });
  const navigate = useNavigate();
  const steer = useQuickSteer();
  const onAction = useEffectEvent(async (action: DesktopActivityAction) => {
    const row = resolveActivityAction(action, rows);
    if (!row || inFlight.current.has(row.id)) return;
    inFlight.current.add(row.id);
    setAcknowledged((current) => {
      const next = new Set(current);
      next.delete(row.id);
      return next;
    });
    setPending((current) =>
      new Map(current).set(
        row.id,
        action.kind === "merge" || action.kind === "steer"
          ? "Sending instruction…"
          : "Updating watch…",
      ),
    );
    setFailures((current) => {
      const next = { ...current };
      delete next[row.id];
      return next;
    });
    const environmentId = row.environmentId as EnvironmentId;
    try {
      if (action.kind === "open" || (action.kind === "merge" && !row.threadId)) {
        if (row.threadId && !row.watchId)
          await navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: row.threadId },
          });
        else {
          const reference = values
            .find(([id]) => id === environmentId)?.[1]
            .watches.find((watch) => watch.id === row.watchId)?.reference;
          await navigate({
            to: "/pull-requests",
            search: {
              environmentId,
              projectId: row.projectId as ProjectId,
              ...(reference
                ? {
                    repository: reference.repository,
                    number: reference.number,
                    selectedProjectId: reference.projectId,
                    selectedEnvironmentId: environmentId,
                    ...(reference.host ? { selectedHost: reference.host } : {}),
                  }
                : {}),
              involvement: "all",
              state: "open",
            },
          });
        }
      } else if (action.kind === "steer") {
        if (row.threadId) {
          await steer(environmentId, row.threadId as ThreadId, action.text ?? "");
          setAcknowledged((current) => new Set(current).add(row.id));
          setFailures((current) => ({
            ...current,
            [row.id]: "Steering message accepted. The draft remains available.",
          }));
        }
      } else if (action.kind === "merge" && row.threadId && row.watchId) {
        const watch = values
          .find(([id]) => id === environmentId)?.[1]
          .watches.find((item) => item.id === row.watchId);
        if (!watch) throw new Error("This PR is no longer available. Refresh and try again.");
        if (!watch.managerThreadId) {
          const result = await command({
            environmentId,
            input: {
              requestId: randomUUID(),
              watchId: watch.id,
              action: "set-manager",
              expectedBinding: watch.binding,
              managerThreadId: row.threadId as ThreadId,
            },
          });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        }
        await steer(environmentId, row.threadId as ThreadId, mergeHandoffMessage(watch));
        setAcknowledged((current) => new Set(current).add(row.id));
        setFailures((current) => ({
          ...current,
          [row.id]: `Merge instruction queued for ${row.mergeRecipient ?? "the managing thread"}.`,
        }));
      } else if (row.watchId) {
        const watch = values
          .find(([id]) => id === environmentId)?.[1]
          .watches.find((item) => item.id === row.watchId);
        if (!watch) return;
        const result = await command({
          environmentId,
          input: {
            requestId: randomUUID(),
            watchId: watch.id,
            action:
              action.kind === "watch"
                ? "resume"
                : action.kind === "stop-watch"
                  ? "pause"
                  : "revoke-merge",
          },
        });
        if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      }
    } catch (cause) {
      setFailures((current) => ({
        ...current,
        [row.id]:
          cause instanceof Error
            ? cause.message
            : "Action failed. Your steering draft is retained.",
      }));
      toastManager.add({
        type: "error",
        title: "Activity action failed",
        description:
          cause instanceof Error ? cause.message : "The environment could not complete the action.",
      });
    } finally {
      inFlight.current.delete(row.id);
      setPending((current) => {
        const next = new Map(current);
        next.delete(row.id);
        return next;
      });
    }
  });
  useEffect(() => window.desktopBridge?.activity?.onAction((action) => void onAction(action)), []);
  const publicationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPublication = useRef<ReturnType<typeof boundedActivitySnapshot> | null>(null);
  const publishLatest = useEffectEvent(() => {
    const snapshot = pendingPublication.current;
    if (!snapshot) return;
    void window.desktopBridge?.activity?.publish(snapshot).catch((cause) => {
      toastManager.add({
        type: "error",
        title: "Could not update activity panel",
        description: cause instanceof Error ? cause.message : "Reconnect Lecturn and try again.",
      });
    });
  });
  useEffect(() => {
    pendingPublication.current = boundedActivitySnapshot(publishedRows);
    // Coalesce streamed assistant text without starving updates during a long response.
    if (publicationTimer.current !== null) return;
    publicationTimer.current = setTimeout(() => {
      publicationTimer.current = null;
      publishLatest();
    }, 300);
  }, [publishedRows]);
  useEffect(
    () => () => {
      if (publicationTimer.current !== null) clearTimeout(publicationTimer.current);
      void window.desktopBridge?.activity?.publish({ summary: "Disconnected", rows: [] });
    },
    [],
  );
  return null;
}

export function DesktopActivityBridge() {
  const routeThread = useParams({ strict: false, select: resolveThreadRouteRef });
  const routeKey = routeThread ? scopedThreadKey(routeThread) : null;
  const visit = useActivityRecentStore((state) => state.visit);
  useEffect(() => {
    if (routeKey) visit(routeKey, new Date().toISOString());
  }, [routeKey, visit]);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    void window.desktopBridge?.activity?.getEnabled().then((value) => {
      if (mounted) setEnabled(value);
    });
    const unsubscribe = window.desktopBridge?.activity?.onEnabledChange(setEnabled);
    const update = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail);
    window.addEventListener(DESKTOP_ACTIVITY_ENABLED_EVENT, update);
    return () => {
      mounted = false;
      unsubscribe?.();
      window.removeEventListener(DESKTOP_ACTIVITY_ENABLED_EVENT, update);
    };
  }, []);
  return enabled ? <EnabledActivityBridge /> : null;
}
