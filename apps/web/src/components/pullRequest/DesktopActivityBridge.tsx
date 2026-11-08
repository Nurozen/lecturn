import { accountTintColor } from "@lecturn/shared/accountTint";
import { accountMarkByEnvironmentIdAtom } from "../../cloud/connectAccounts";
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
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { environmentThreadDetails } from "../../state/threads";
import { environmentShell } from "../../state/shell";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { DESKTOP_ACTIVITY_ENABLED_EVENT } from "./DesktopActivityToggle";
import { randomUUID } from "../../lib/utils";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  DesktopActivityAction,
  DesktopActivitySquireResult,
  EnvironmentId,
  ProjectId,
  ProjectIconOverride,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import { squireEnvironment, useSquireEnvironments } from "../../state/squires";
import { useEnvironments } from "../../state/environments";
import { pullRequestWatchEnvironment, usePullRequestWatches } from "../../state/pullRequestWatch";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  CoalescedActivityPublication,
  watchActivityRows,
  withActivityAccountMarks,
  contextualActivityRows,
  boundedActivitySnapshot,
  threadActivityRows,
  resolveActivityAction,
  threadDetailMessages,
  resolveSquireActivityAction,
  runSquireActivityAction,
  squireActivityInfo,
  squireActivityOverlay,
  squireActivityRows,
  type SquireActivityAction,
  type SquireActivityOffer,
  type SquireActivitySource,
} from "./desktopActivity.logic";
import { useQuickSteer } from "./useQuickSteer";
import { toastManager } from "../ui/toast";
import { formatEnvironmentQueryError } from "../../state/query";

// Keyed by serialized ids so atom identity is stable across renders.
const liveShellIdsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get) =>
    (JSON.parse(environmentKey) as EnvironmentId[]).filter(
      (id) => get(environmentShell.stateValueAtom(id)).status === "live",
    ),
  ),
);

const contextDetailsAtom = Atom.family((contextRefs: string) =>
  Atom.make((get) =>
    (JSON.parse(contextRefs) as [EnvironmentId, ThreadId][]).map(([environmentId, threadId]) =>
      get(environmentThreadDetails.threadAtom({ environmentId, threadId })),
    ),
  ),
);

// Keyed by serialized [environmentId, squireId] pairs, like the details above.
const squireQueuesAtom = Atom.family((leads: string) =>
  Atom.make((get) =>
    (JSON.parse(leads) as [EnvironmentId, SquireId][]).map(
      ([environmentId, squireId]) =>
        Option.getOrNull(
          AsyncResult.value(get(squireEnvironment.decisionItems({ environmentId, squireId }))),
        )?.items ?? [],
    ),
  ),
);

// Only raisers with a rule-made card are read, to name the rule on its row.
const squireRulesAtom = Atom.family((raisers: string) =>
  Atom.make((get) =>
    (JSON.parse(raisers) as [EnvironmentId, SquireId][]).map(
      ([environmentId, squireId]) =>
        Option.getOrNull(
          AsyncResult.value(get(squireEnvironment.rules({ environmentId, input: { squireId } }))),
        )?.rules ?? [],
    ),
  ),
);

const SQUIRE_ITEM_GONE = "This item is no longer available. Refresh activity in Lecturn.";

function EnabledActivityBridge() {
  const accountMarks = useAtomValue(accountMarkByEnvironmentIdAtom);
  const viewedThread = useParams({ strict: false, select: resolveThreadRouteRef });
  const { environments } = useEnvironments();
  const ids = environments
    .filter((environment) => environment.serverConfig?.environment.capabilities.pullRequests)
    .map((environment) => environment.environmentId);
  const connectedIds = new Set(
    environments
      .filter((environment) => environment.connection.phase === "connected")
      .map((environment) => environment.environmentId),
  );
  const { values, failedEnvironmentIds } = usePullRequestWatches(ids);
  const environmentKey = JSON.stringify(environments.map((item) => item.environmentId));
  const liveShellIds = useAtomValue(liveShellIdsAtom(environmentKey));
  const readyEnvironmentIds = liveShellIds.filter(
    (id) =>
      connectedIds.has(id) &&
      (!ids.includes(id) ||
        values.some(([valueId]) => valueId === id) ||
        failedEnvironmentIds.includes(id)),
  );
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const sagaIndex = useSagaRepositoryIndex(projects);
  const interactions = useActivityRecentStore((state) => state.interactions);
  const localIntents = useLocalThreadActivityIntents();
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map());
  const inFlight = useRef(new Set<string>());
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [squireOffers, setSquireOffers] = useState<ReadonlyArray<SquireActivityOffer>>([]);
  const squireEnvironments = useSquireEnvironments();
  const squireLeads = squireEnvironments.flatMap(({ environmentId, state }) =>
    state.lead === null ? [] : [[environmentId, state.lead] as const],
  );
  const squireQueues = useAtomValue(squireQueuesAtom(JSON.stringify(squireLeads)));
  const squireRaisers = squireLeads
    .flatMap(([environmentId], index) =>
      (squireQueues[index] ?? [])
        .filter((card) => card.ruleId !== null)
        .map((card) => [environmentId, card.squireId] as const),
    )
    .filter(
      (pair, index, pairs) =>
        pairs.findIndex((item) => item[0] === pair[0] && item[1] === pair[1]) === index,
    );
  const squireRules = useAtomValue(squireRulesAtom(JSON.stringify(squireRaisers)));
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
  const contextDetails = useAtomValue(contextDetailsAtom(contextRefs));
  const rows = (() => {
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
                return thread
                  ? describeThreadActivity(
                      thread,
                      threadDetailMessages(contextDetails, thread.environmentId, thread.id),
                    )
                  : row.detail;
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
  })();
  const squireSources = squireLeads.flatMap(([environmentId], index): SquireActivitySource[] => {
    const state = squireEnvironments.find((item) => item.environmentId === environmentId)?.state;
    if (state === undefined) return [];
    const threadTitle = (threadId: string) =>
      threads.find((item) => item.environmentId === environmentId && item.id === threadId)?.title ??
      null;
    const projectTitle = (projectId: string) =>
      projects.find((item) => item.environmentId === environmentId && item.id === projectId)
        ?.title ?? null;
    return [
      {
        environmentId,
        state,
        items: squireQueues[index] ?? [],
        rules: new Map(
          squireRaisers.flatMap(([raiserEnvironmentId, squireId], raiserIndex) =>
            raiserEnvironmentId === environmentId
              ? [[squireId, squireRules[raiserIndex] ?? []] as const]
              : [],
          ),
        ),
        threadTitle,
        projectTitle,
        targetName: (rule) =>
          (rule.targetKind === "thread"
            ? threadTitle(rule.targetId)
            : rule.targetKind === "project"
              ? projectTitle(rule.targetId)
              : null) ?? rule.targetId,
      },
    ];
  });
  const squireRowsAt = (now: number) => {
    const own = squireActivityOverlay(
      squireActivityRows(squireSources, squireOffers, now),
      new Set(pending.keys()),
    );
    // Project labels only: a Squire row's excerpt is its target thread's title, not its output.
    return contextualActivityRows(own, [], projects, []).map((row, index) => {
      const { excerpt: _excerpt, ...rest } = row;
      const excerpt = own[index]?.excerpt;
      return excerpt === undefined ? rest : { ...rest, excerpt };
    });
  };
  // Render needs only the rows' identity and icons; publication reads the clock for hold times.
  const [mountedAt] = useState(Date.now);
  const squireRows = squireRowsAt(mountedAt);
  const iconRequests = JSON.stringify(
    [
      ...new Set(
        [...squireRows, ...rows]
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
  // Squire rows lead so the snapshot's row bound never drops a decision for watch history.
  const publishedRowsAt = (now: number) =>
    [...squireRowsAt(now), ...rows].map((row) => {
      const url = row.projectIcon ? iconImages.get(JSON.stringify(row.projectIcon)) : undefined;
      return url ? { ...row, projectIconDataUrl: url } : row;
    });
  const command = useAtomCommand(pullRequestWatchEnvironment.command, { reportFailure: false });
  const actSquire = useAtomCommand(squireEnvironment.itemsAct, { reportFailure: false });
  const createSquireRule = useAtomCommand(squireEnvironment.ruleCreate, { reportFailure: false });
  const navigate = useNavigate();
  const steer = useQuickSteer();
  // The host's reply to a notch press only confirms forwarding, so the outcome goes back by
  // `requestId`, and the notch shows it on the card that was pressed.
  const settleSquireAction = (result: DesktopActivitySquireResult) => {
    void window.desktopBridge?.activity?.reportSquireResult(result).catch(() => undefined);
  };
  const onSquireAction = async (action: SquireActivityAction) => {
    const target = resolveSquireActivityAction(action, squireRows, squireOffers, squireSources);
    if (target === null) {
      settleSquireAction(squireActivityInfo(action.requestId, SQUIRE_ITEM_GONE));
      return;
    }
    const rowId = target.row.id;
    if (inFlight.current.has(rowId)) {
      settleSquireAction(squireActivityInfo(action.requestId, "This item is already updating."));
      return;
    }
    inFlight.current.add(rowId);
    setPending((current) => new Map(current).set(rowId, "Updating…"));
    const outcome = await runSquireActivityAction(action, target, {
      act: async (environmentId, input) => {
        const result = await actSquire({
          environmentId,
          input: { requestId: randomUUID(), cardIds: [...input.cardIds], action: input.action },
        });
        return result._tag === "Failure"
          ? { ok: false, error: formatEnvironmentQueryError(result.cause) }
          : { ok: true, value: result.value };
      },
      createRule: async (environmentId, input) => {
        const result = await createSquireRule({
          environmentId,
          input: { requestId: randomUUID(), ...input },
        });
        return result._tag === "Failure"
          ? { ok: false, error: formatEnvironmentQueryError(result.cause) }
          : { ok: true, value: result.value };
      },
      open: async (environmentId, squireId) => {
        await navigate({
          to: "/squires/$environmentId/$squireId",
          params: { environmentId, squireId },
        });
      },
    });
    inFlight.current.delete(rowId);
    setPending((current) => {
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });
    const { offer, settledOffer } = outcome;
    if (offer !== null || settledOffer !== null) {
      setSquireOffers((current) => [
        ...current.filter(
          (item) =>
            item.environmentId !== target.row.environmentId ||
            (item.card.id !== settledOffer && item.card.id !== offer?.card.id),
        ),
        ...(offer === null ? [] : [offer]),
      ]);
    }
    settleSquireAction(outcome.result);
  };
  const onAction = useEffectEvent(async (action: DesktopActivityAction) => {
    if ("requestId" in action) return await onSquireAction(action);
    // A Squire card's Open goes to its target thread; the host already raised the window.
    const squireThread = action.kind === "open" ? resolveActivityAction(action, squireRows) : null;
    if (squireThread?.threadId) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: squireThread.environmentId as EnvironmentId,
          threadId: squireThread.threadId,
        },
      });
      return;
    }
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
    const attempt = async () => {
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
    };
    return await attempt()
      .catch((cause: unknown) => {
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
            cause instanceof Error
              ? cause.message
              : "The environment could not complete the action.",
        });
      })
      .finally(() => {
        inFlight.current.delete(row.id);
        setPending((current) => {
          const next = new Map(current);
          next.delete(row.id);
          return next;
        });
      });
  });
  useEffect(() => window.desktopBridge?.activity?.onAction((action) => void onAction(action)), []);
  const [publication] = useState(
    () => new CoalescedActivityPublication<ReturnType<typeof boundedActivitySnapshot>>(),
  );
  const publish = useEffectEvent((snapshot: ReturnType<typeof boundedActivitySnapshot>) => {
    void window.desktopBridge?.activity?.publish(snapshot).catch((cause) => {
      toastManager.add({
        type: "error",
        title: "Could not update activity panel",
        description: cause instanceof Error ? cause.message : "Reconnect Lecturn and try again.",
      });
    });
  });
  useEffect(() => {
    publication.offer(
      {
        ...boundedActivitySnapshot(
          withActivityAccountMarks(
            publishedRowsAt(Date.now()),
            new Map(
              [...accountMarks].map(([id, mark]) => [
                id,
                {
                  accountId: mark.accountId,
                  label: mark.label,
                  color: accountTintColor(mark.preset),
                },
              ]),
            ),
          ),
        ),
        readyEnvironmentIds,
        ...(viewedThread ? { viewedThread } : {}),
      },
      (snapshot) => publish(snapshot),
    );
  }, [publication, publishedRowsAt, readyEnvironmentIds, viewedThread, accountMarks]);
  useEffect(
    () => () => {
      publication.dispose();
      void window.desktopBridge?.activity?.publish({
        summary: "Disconnected",
        rows: [],
        readyEnvironmentIds: [],
      });
    },
    [publication],
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
