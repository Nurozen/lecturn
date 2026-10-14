import { useAtomValue } from "@effect/atom-react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@lecturn/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@lecturn/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { useThreadActions } from "../../hooks/useThreadActions";
import { environmentServerConfigsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { accountByEnvironmentIdAtom } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import {
  animateSidebarLayoutChanges,
  applySidebarThreadDrop,
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  sortSettledThreadsForSidebar,
  type SidebarListMarker,
  type SidebarSection,
  type SidebarThreadDropPlan,
} from "../Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  limitSidebarCollisionToScope,
} from "../Sidebar.drag";
import { createSidebarListMotion } from "../Sidebar.motion";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildScopedSidebarItems,
  projectSidebarDrop,
  sidebarDropConfirmed,
  type SidebarDropHold,
  type SidebarLists,
} from "./sidebarDragScope.logic";

export type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;
const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
interface SidebarDragContext {
  enabledKeys: ReadonlySet<string>;
  draggableKeys: ReadonlySet<string>;
  from: SidebarSection | null;
  destination: SidebarSection | null;
  suspend: (controller: ReturnType<typeof createSidebarListMotion>, add: boolean) => void;
  dragging: boolean;
  baselineKey: string;
}
const DragScope = createContext<SidebarDragContext | null>(null);

function SidebarDragProvider(props: SidebarDragContext & { children: ReactNode }) {
  const { enabledKeys, draggableKeys, from, destination, suspend, dragging, baselineKey } = props;
  const value = useMemo(
    () => ({ enabledKeys, draggableKeys, from, destination, suspend, dragging, baselineKey }),
    [enabledKeys, draggableKeys, from, destination, suspend, dragging, baselineKey],
  );
  return <DragScope value={value}>{props.children}</DragScope>;
}

function useSidebarDropHold(lists: SidebarLists, enabled: boolean) {
  const [hold, setHold] = useState<SidebarDropHold | null>(null);
  if (hold && (!enabled || sidebarDropConfirmed(lists, hold))) setHold(null);
  return [hold, setHold] as const;
}

/** Each account list, or each project in the hierarchy, owns a DndContext.
 * Structural IDs, measured order, optimistic acknowledgement and writes never
 * escape that list. Hidden keys remain reservations in the planner. */
export function SidebarDragScope(props: {
  reservedKeys: {
    readonly pinned: ReadonlyMap<string, string | null>;
    readonly active: ReadonlyMap<string, string | null>;
  };
  actions: ReturnType<typeof useThreadActions>;
  lists: SidebarLists;
  enabled: boolean;
  snoozedExpanded: boolean;
  settledExpanded: boolean;
  settledLimit: number;
  retainCurrentSettled?: boolean;
  routeThreadKey: string | null;
  onSettle: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown> | null>;
  children: (lists: SidebarLists) => ReactNode;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const accounts = useAtomValue(accountByEnvironmentIdAtom);
  const known = useAtomValue(knownConnectAccountsAtom);
  const canAccess = (thread: EnvironmentThreadShell) => {
    const account = accounts.get(thread.environmentId);
    return !account || !known.needsSignIn.includes(account);
  };
  const { actions } = props;
  const [hold, setHold] = useSidebarDropHold(props.lists, props.enabled);
  const [drag, setDrag] = useState<{
    key: string;
    section: SidebarSection;
    occurredAt: string;
    activationY: number | null;
  } | null>(null);
  const [destination, setDestination] = useState<SidebarSection | null>(null);
  const controllers = useRef(new Set<ReturnType<typeof createSidebarListMotion>>());
  const suspend = () => {
    for (const controller of controllers.current) controller.suspend();
  };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const live = useRef({ props, configs, canAccess });
  useLayoutEffect(() => {
    live.current = { props, configs, canAccess };
  });
  const canonical = new Map(
    Object.values(props.lists)
      .flat()
      .map((thread) => [keyOf(thread), thread]),
  );
  const lists = projectSidebarDrop(props.lists, hold);
  const items = buildScopedSidebarItems(lists, props);
  const draggableKeys = new Set(
    [...canonical.values()]
      .filter((thread) => {
        const c = configs.get(thread.environmentId)?.environment.capabilities;
        return canAccess(thread) && c?.threadPinning === true && c.threadPinReorder === true;
      })
      .map(keyOf),
  );
  const activeReorderableKeys = new Set(
    [...canonical.values()]
      .filter(
        (thread) =>
          draggableKeys.has(keyOf(thread)) &&
          configs.get(thread.environmentId)?.environment.capabilities.threadActiveReorder === true,
      )
      .map(keyOf),
  );
  const pinnedKeysById = props.reservedKeys.pinned;
  const activeKeysById = props.reservedKeys.active;
  const sectionOf = (key: string) =>
    (Object.keys(props.lists) as SidebarSection[]).find((section) =>
      props.lists[section].some((thread) => keyOf(thread) === key),
    );
  const planFor = (activeKey: string, overId: string): SidebarThreadDropPlan => {
    const source = canonical.get(activeKey);
    const section = sectionOf(activeKey);
    const target = resolveSidebarDropTarget(items, activeKey, overId);
    if (
      !props.enabled ||
      !source ||
      source.archivedAt !== null ||
      !section ||
      !target ||
      !draggableKeys.has(activeKey)
    )
      return { kind: "none" };
    return planSidebarThreadDrop({
      activeKey,
      activeSection: section,
      activePinned: source.pinnedAt != null,
      activeSettled: source.settledOverride === "settled",
      supportsSettlement:
        configs.get(source.environmentId)?.environment.capabilities.threadSettlement === true,
      target,
      pinnedOrder: lists.pinned.map(keyOf),
      activeOrder: lists.active.map(keyOf),
      pinnedKeysById,
      activeKeysById,
      reorderableKeys: draggableKeys,
      activeReorderableKeys,
    });
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const strategy = createSidebarSortingStrategy({
    items,
    settledOrder: sortSettledThreadsForSidebar(
      drag && canonical.has(drag.key)
        ? [
            ...lists.settled.filter((thread) => keyOf(thread) !== drag.key),
            applySidebarThreadDrop(canonical.get(drag.key)!, "settled", drag.occurredAt),
          ]
        : lists.settled,
    ).map(keyOf),
    settledExpanded: props.settledExpanded,
    settledVisibleCount: props.settledLimit,
    snoozedThreadCount: lists.snoozed.length,
    routeThreadKey:
      props.retainCurrentSettled === false && !props.settledExpanded ? null : props.routeThreadKey,
  });
  const clearDrag = () => {
    suspend();
    setDrag(null);
    setDestination(null);
  };
  const end = (event: DragEndEvent) => {
    clearDrag();
    if (hold || !event.over) return;
    const activeKey = String(event.active.id);
    const overId = String(event.over.id);
    const source = canonical.get(activeKey);
    const section = sectionOf(activeKey);
    const target = resolveSidebarDropTarget(items, activeKey, overId);
    const plan = planFor(activeKey, overId);
    if (!source || !section || !target || plan.kind === "none") return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined ? [] : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "settle"
          ? []
          : plan.assignments;
    const drop: SidebarDropHold = {
      key: activeKey,
      sourceSection: section,
      section: target.section,
      occurredAt: new Date().toISOString(),
      clearsSnooze: plan.kind !== "reorder-pinned",
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: target.section === "active" ? activeKeysById : pinnedKeysById,
      assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
    };
    setHold(drop);
    void (async () => {
      const release = () => setHold((current) => (current === drop ? null : current));
      // Revalidate scope membership and capability before each asynchronous write.
      const stillOwned = (key: string, activeOrder = false) => {
        const state = live.current;
        const thread = Object.values(state.props.lists)
          .flat()
          .find((candidate) => keyOf(candidate) === key);
        const capability =
          thread && state.configs.get(thread.environmentId)?.environment.capabilities;
        return (
          mounted.current &&
          state.props.enabled &&
          thread != null &&
          state.canAccess(thread) &&
          thread.archivedAt === null &&
          capability?.threadPinning === true &&
          capability.threadPinReorder === true &&
          (!activeOrder || capability.threadActiveReorder === true)
        );
      };
      const run = async (operation: () => Promise<AtomCommandResult<unknown, unknown> | null>) => {
        if (!stillOwned(activeKey, plan.kind === "move-active")) {
          release();
          return false;
        }
        const result = await operation();
        if (result?._tag === "Success") return true;
        release();
        if (result && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to move thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      };
      const ref = scopeThreadRef(source.environmentId, source.id);
      if (plan.kind === "settle") {
        await run(() => props.onSettle(ref));
        return;
      }
      if (
        plan.kind === "pin" &&
        !(await run(() =>
          actions.pinThread(ref, plan.orderKey === undefined ? {} : { orderKey: plan.orderKey }),
        ))
      )
        return;
      if (plan.kind === "move-active") {
        if (plan.unpin && !(await run(() => actions.unpinThread(ref)))) return;
        if (plan.unsettle && !(await run(() => actions.unsettleThread(ref)))) return;
        if (plan.unsnooze && !(await run(() => actions.unsnoozeThread(ref)))) return;
      }
      const writes = plan.kind === "pin" ? plan.extraAssignments : plan.assignments;
      for (const assignment of writes) {
        const thread = canonical.get(assignment.id);
        if (!thread || !stillOwned(assignment.id, plan.kind === "move-active")) {
          release();
          return;
        }
        if (
          !(await run(() =>
            (plan.kind === "move-active"
              ? actions.reorderActiveThread
              : actions.reorderPinnedThread)(
              scopeThreadRef(thread.environmentId, thread.id),
              assignment.orderKey,
            ),
          ))
        )
          return;
      }
    })();
  };
  const detect = createSidebarCollisionDetection(
    (id) => !!drag && planFor(drag.key, id).kind !== "none",
    { emptyPins: lists.pinned.length === 0, activationY: drag?.activationY ?? null },
  );
  const collisionDetection = limitSidebarCollisionToScope(detect);
  const registerMotion = (controller: ReturnType<typeof createSidebarListMotion>, add: boolean) => {
    if (add) controllers.current.add(controller);
    else controllers.current.delete(controller);
  };
  const baselineKey = `${props.enabled}:${props.snoozedExpanded}:${props.settledExpanded}:${props.settledLimit}:${props.routeThreadKey}`;
  const from = drag?.section ?? null;
  const dragging = drag !== null;
  const enabledIds = props.enabled ? items.map(sidebarListItemId) : [];
  const draggableIds = hold ? [] : [...draggableKeys];

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      collisionDetection={collisionDetection}
      onDragStart={(event) => {
        const key = String(event.active.id);
        const section = sectionOf(key);
        if (!props.enabled || hold || !section || !draggableKeys.has(key)) return;
        suspend();
        setDrag({
          key,
          section,
          occurredAt: new Date().toISOString(),
          activationY:
            event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
        });
        setDestination(section);
      }}
      onDragOver={(event) =>
        setDestination(
          event.over && planFor(String(event.active.id), String(event.over.id)).kind !== "none"
            ? (resolveSidebarDropTarget(items, String(event.active.id), String(event.over.id))
                ?.section ?? null)
            : null,
        )
      }
      onDragCancel={clearDrag}
      onDragEnd={end}
    >
      <SortableContext items={items.map(sidebarListItemId)} strategy={strategy}>
        <SidebarDragProvider
          enabledKeys={new Set(enabledIds)}
          draggableKeys={new Set(draggableIds)}
          from={from}
          destination={destination}
          suspend={registerMotion}
          dragging={dragging}
          baselineKey={baselineKey}
        >
          {props.children(lists)}
        </SidebarDragProvider>
      </SortableContext>
    </DndContext>
  );
}

export function ScopedSortableThreadRow(props: {
  thread: EnvironmentThreadShell;
  children: (
    bag: SortableThreadRowBag | undefined,
    destination: "pinned" | "active" | "settled" | null,
  ) => ReactNode;
}) {
  const scope = useContext(DragScope);
  const key = keyOf(props.thread);
  const sortable = useSortable({
    id: key,
    disabled: {
      draggable: !scope?.enabledKeys.has(key) || !scope.draggableKeys.has(key),
      droppable: !scope?.enabledKeys.has(key),
    },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return props.children(
    scope ? sortable : undefined,
    scope?.from === scope?.destination || scope?.destination === "snoozed"
      ? null
      : (scope?.destination ?? null),
  );
}

export function SidebarDragBoundary(props: {
  marker: SidebarListMarker;
  label: string;
  children?: ReactNode;
  className?: string;
  "data-thread-selection-safe"?: boolean;
}) {
  const scope = useContext(DragScope);
  const id = sidebarMarkerId(props.marker);
  const { setNodeRef, transform, transition } = useSortable({
    id,
    disabled: { draggable: true, droppable: !scope?.enabledKeys.has(id) },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const section =
    props.marker === "pinned-header"
      ? "pinned"
      : props.marker.startsWith("settled")
        ? "settled"
        : props.marker === "snoozed-header"
          ? "snoozed"
          : "active";
  const boundary = props.marker === "pinned-header" || props.marker === "pinned-divider";
  const visible = scope?.from !== null && scope?.from !== undefined;
  const isDropTarget = visible && scope?.destination === section;
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={`sidebar-${props.marker}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      className={cn(
        "relative list-none",
        boundary ? "h-0 z-10" : props.children ? "" : "h-9",
        isDropTarget && "rounded-md border-primary/40 bg-primary/5 text-primary",
        props.className,
      )}
    >
      {props.children ??
        (visible || props.marker === "snoozed-header" ? (
          <span
            className={cn(
              "flex items-center text-xs text-sidebar-muted-foreground",
              isDropTarget && "text-primary",
              boundary
                ? "absolute inset-x-2 -top-2 h-4 bg-sidebar"
                : "h-full justify-center border border-dashed border-sidebar-border rounded-md",
            )}
          >
            <span
              className={cn(
                boundary &&
                  "shrink-0 rounded-sm border border-sidebar-border bg-sidebar px-1.5 text-[10px] font-medium",
                isDropTarget && "border-primary/40",
              )}
            >
              {props.label}
            </span>
            <span
              className={cn("ml-2 h-px flex-1 bg-sidebar-border", isDropTarget && "bg-primary/50")}
            />
          </span>
        ) : null)}
    </li>
  );
}

/** A controller per actual row list; folds own their own animation. */
export function SidebarMotionList(props: { children: ReactNode; className?: string }) {
  const scope = useContext(DragScope);
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    scopeRef.current = scope;
  });
  const controller = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attach = useMemo(
    () => (node: HTMLUListElement | null) => {
      if (controller.current) {
        scopeRef.current?.suspend(controller.current, false);
        controller.current.dispose();
      }
      controller.current = node ? createSidebarListMotion(node) : null;
      if (controller.current) scopeRef.current?.suspend(controller.current, true);
    },
    [],
  );
  const baseline = useRef(scope?.baselineKey);
  useLayoutEffect(() => {
    if (baseline.current !== scope?.baselineKey) controller.current?.suspend();
    baseline.current = scope?.baselineKey;
    controller.current?.update(!scope?.dragging);
  });
  return (
    <ul ref={attach} className={cn("relative flex flex-col gap-px", props.className)}>
      {props.children}
    </ul>
  );
}
