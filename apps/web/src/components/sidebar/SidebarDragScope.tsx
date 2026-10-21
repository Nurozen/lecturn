import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
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
  useCallback,
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
  resolveSidebarDropVerb,
  sidebarListItemId,
  sidebarMarkerId,
  sortSettledThreadsForSidebar,
  type SidebarListMarker,
  type SidebarSection,
  type SidebarThreadDropPlan,
  type SidebarDropVerb,
} from "../Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  limitSidebarCollisionToScope,
  restrictBelowSidebarLabel,
} from "../Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "../Sidebar.pointer";
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
  activeCount: number;
  settledCount: number;
  registerNode: (id: string, node: HTMLElement | null) => void;
}
const DragScope = createContext<SidebarDragContext | null>(null);

function SidebarDragProvider(props: SidebarDragContext & { children: ReactNode }) {
  const {
    enabledKeys,
    draggableKeys,
    from,
    destination,
    suspend,
    dragging,
    baselineKey,
    activeCount,
    settledCount,
    registerNode,
  } = props;
  const value = useMemo(
    () => ({
      enabledKeys,
      draggableKeys,
      from,
      destination,
      suspend,
      dragging,
      baselineKey,
      activeCount,
      settledCount,
      registerNode,
    }),
    [
      enabledKeys,
      draggableKeys,
      from,
      destination,
      suspend,
      dragging,
      baselineKey,
      activeCount,
      settledCount,
      registerNode,
    ],
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
  const canAccess = useCallback(
    (thread: EnvironmentThreadShell) => {
      const account = accounts.get(thread.environmentId);
      return !account || !known.needsSignIn.includes(account);
    },
    [accounts, known],
  );
  const { actions } = props;
  const [hold, setHold] = useSidebarDropHold(props.lists, props.enabled);
  const [drag, setDrag] = useState<{
    key: string;
    section: SidebarSection;
    occurredAt: string;
    activationY: number | null;
    geometry: Pick<
      Parameters<typeof createSidebarSortingStrategy>[0],
      "scale" | "gap" | "slimHeight" | "boundaryLabelHeight"
    >;
  } | null>(null);
  const [destination, setDestination] = useState<SidebarSection | null>(null);
  const controllers = useRef(new Set<ReturnType<typeof createSidebarListMotion>>());
  const sortableNodes = useRef(new Map<string, HTMLElement>());
  const reservation = useRef<{
    release: () => void;
    bounds: () => Pick<DOMRect, "top" | "bottom" | "left" | "right">;
  } | null>(null);
  const registerNode = useCallback((id: string, node: HTMLElement | null) => {
    if (node) sortableNodes.current.set(id, node);
    else sortableNodes.current.delete(id);
  }, []);
  const scopeBounds = useCallback(() => reservation.current?.bounds() ?? null, []);
  const sensorRef = useRef<SidebarPointerSensor | null>(null);
  const labelTopRef = useRef<number | null>(null);
  const labelOffsetRef = useRef<number | null>(null);
  const restrictBelowPins = useCallback<Modifier>((args) => {
    if (labelOffsetRef.current === null && args.containerNodeRect && labelTopRef.current !== null)
      labelOffsetRef.current = labelTopRef.current - args.containerNodeRect.top;
    return restrictBelowSidebarLabel(args, labelOffsetRef.current ?? 0);
  }, []);
  const suspend = () => {
    for (const controller of controllers.current) controller.suspend();
  };
  const finishDrag = useCallback((started: boolean) => {
    sensorRef.current = null;
    if (!started) return;
    for (const controller of controllers.current) controller.release();
    reservation.current?.release();
    reservation.current = null;
    setDrag(null);
    setDestination(null);
  }, []);
  const attachSensor = useCallback((sensor: SidebarPointerSensor) => {
    sensorRef.current = sensor;
  }, []);
  const cancelDrag = useCallback(() => sensorRef.current?.cancel(), []);
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
  const canonical = useMemo(
    () =>
      new Map(
        Object.values(props.lists)
          .flat()
          .map((thread) => [keyOf(thread), thread]),
      ),
    [props.lists],
  );
  const lists = useMemo(() => projectSidebarDrop(props.lists, hold), [props.lists, hold]);
  const items = useMemo(
    () =>
      buildScopedSidebarItems(lists, {
        snoozedExpanded: props.snoozedExpanded,
        settledExpanded: props.settledExpanded,
        settledLimit: props.settledLimit,
        routeThreadKey: props.routeThreadKey,
        ...(props.retainCurrentSettled === undefined
          ? {}
          : { retainCurrentSettled: props.retainCurrentSettled }),
      }),
    [
      lists,
      props.snoozedExpanded,
      props.settledExpanded,
      props.settledLimit,
      props.routeThreadKey,
      props.retainCurrentSettled,
    ],
  );
  useEffect(() => {
    if (
      drag &&
      (!props.enabled || !items.some((item) => item.kind === "thread" && item.key === drag.key))
    )
      cancelDrag();
  }, [cancelDrag, drag, items, props.enabled]);
  const draggableKeys = useMemo(
    () =>
      new Set(
        [...canonical.values()]
          .filter((thread) => {
            const c = configs.get(thread.environmentId)?.environment.capabilities;
            return canAccess(thread) && c?.threadPinning === true && c.threadPinReorder === true;
          })
          .map(keyOf),
      ),
    [canonical, configs, canAccess],
  );
  const activeReorderableKeys = useMemo(
    () =>
      new Set(
        [...canonical.values()]
          .filter(
            (thread) =>
              draggableKeys.has(keyOf(thread)) &&
              configs.get(thread.environmentId)?.environment.capabilities.threadActiveReorder ===
                true,
          )
          .map(keyOf),
      ),
    [canonical, draggableKeys, configs],
  );
  const pinnedKeysById = props.reservedKeys.pinned;
  const activeKeysById = props.reservedKeys.active;
  const sectionOf = useCallback(
    (key: string) =>
      (Object.keys(props.lists) as SidebarSection[]).find((section) =>
        props.lists[section].some((thread) => keyOf(thread) === key),
      ),
    [props.lists],
  );
  const planFor = useCallback(
    (activeKey: string, overId: string): SidebarThreadDropPlan => {
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
    },
    [
      canonical,
      sectionOf,
      items,
      props.enabled,
      draggableKeys,
      configs,
      lists,
      pinnedKeysById,
      activeKeysById,
      activeReorderableKeys,
    ],
  );
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, { distance: 6, onAttach: attachSensor, onFinish: finishDrag }),
  );
  const strategyInput = {
    items,
    ...drag?.geometry,
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
  };
  const strategy = createSidebarSortingStrategy(strategyInput);
  const end = (event: DragEndEvent) => {
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
  const detectCollision = useMemo(
    () =>
      createSidebarCollisionDetection((id) => !!drag && planFor(drag.key, id).kind !== "none", {
        items,
        activationY: drag?.activationY ?? null,
      }),
    [items, drag, planFor],
  );
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => limitSidebarCollisionToScope(detectCollision, scopeBounds)(args),
    [detectCollision, scopeBounds],
  );
  const registerMotion = useCallback(
    (controller: ReturnType<typeof createSidebarListMotion>, add: boolean) => {
      if (add) controllers.current.add(controller);
      else controllers.current.delete(controller);
    },
    [],
  );
  const baselineKey = `${props.enabled}:${props.snoozedExpanded}:${props.settledExpanded}:${props.settledLimit}:${props.routeThreadKey}`;
  const from = drag?.section ?? null;
  const dragging = drag !== null;
  const enabledIds = props.enabled ? items.map(sidebarListItemId) : [];
  const draggableIds = hold ? [] : [...draggableKeys];

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis, restrictBelowPins, restrictToFirstScrollableAncestor]}
      collisionDetection={collisionDetection}
      onDragStart={(event) => {
        const key = String(event.active.id);
        const section = sectionOf(key);
        if (!props.enabled || hold || !section || !draggableKeys.has(key)) return;
        const occurredAt = new Date().toISOString();
        suspend();
        labelTopRef.current = null;
        labelOffsetRef.current = null;
        const header = sortableNodes.current.get(sidebarMarkerId("pinned-header"));
        const tail = sortableNodes.current.get(sidebarMarkerId("settled-placeholder"));
        let root = header?.parentElement;
        if (tail) while (root && !root.contains(tail)) root = root.parentElement;
        const geometry: NonNullable<typeof drag>["geometry"] = {};
        if (root && header && tail) {
          const rootRect = root.getBoundingClientRect();
          const scale = root.offsetWidth > 0 ? rootRect.width / root.offsetWidth : 1;
          const label = header.querySelector<HTMLElement>("[data-sidebar-drag-label]");
          const hint = tail.querySelector<HTMLElement>("[data-sidebar-drag-placeholder]");
          const labelRect = label?.getBoundingClientRect();
          // The label's top inset also supplies its bottom clearance.
          const labelHeight = labelRect
            ? labelRect.height + 2 * (labelRect.top - header.getBoundingClientRect().top)
            : 0;
          geometry.scale = scale;
          geometry.gap =
            (Number.parseFloat(getComputedStyle(header.parentElement!).rowGap) || 0) * scale;
          geometry.boundaryLabelHeight = labelHeight / scale;
          if (hint) geometry.slimHeight = hint.getBoundingClientRect().height;
          labelTopRef.current = header.getBoundingClientRect().top + labelHeight;
          // In the hierarchy, the last shelf owns the padding; padding the
          // shared project list would put it after child projects instead.
          let end: HTMLElement = tail;
          while (end.parentElement && end.parentElement !== root) end = end.parentElement;
          const paddingNode = tail.parentElement === root ? root : end;
          const rects = items.map((item) =>
            sortableNodes.current.get(sidebarListItemId(item))?.getBoundingClientRect(),
          );
          const activeIndex = items.findIndex((item) => sidebarListItemId(item) === key);
          const bottom = (paddingNode === root ? rootRect : end.getBoundingClientRect()).bottom;
          const overflow = createSidebarSortingStrategy({
            ...strategyInput,
            ...geometry,
            settledOrder: sortSettledThreadsForSidebar([
              ...lists.settled.filter((thread) => keyOf(thread) !== key),
              applySidebarThreadDrop(canonical.get(key)!, "settled", occurredAt),
            ]).map(keyOf),
          }).measureOverflow(rects, activeIndex, bottom);
          const padding = paddingNode.style.paddingBottom;
          const restingPadding =
            Number.parseFloat(getComputedStyle(paddingNode).paddingBottom) || 0;
          paddingNode.style.paddingBottom = `${restingPadding + overflow / scale}px`;
          const scopeRoot = root;
          reservation.current = {
            release: () => {
              paddingNode.style.paddingBottom = padding;
            },
            bounds: () => {
              const rect = scopeRoot.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom:
                  paddingNode === scopeRoot ? rect.bottom : end.getBoundingClientRect().bottom,
              };
            },
          };
        }
        setDrag({
          key,
          section,
          occurredAt,
          activationY:
            event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
          geometry,
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
      onDragEnd={end}
    >
      <SidebarDragLifecycle onUnmount={cancelDrag} />
      <SortableContext items={items.map(sidebarListItemId)} strategy={strategy}>
        <SidebarDragProvider
          enabledKeys={new Set(enabledIds)}
          draggableKeys={new Set(draggableIds)}
          from={from}
          destination={destination}
          suspend={registerMotion}
          dragging={dragging}
          baselineKey={baselineKey}
          activeCount={lists.active.length}
          settledCount={
            items.filter((item) => item.kind === "thread" && item.section === "settled").length
          }
          registerNode={registerNode}
        >
          {props.children(lists)}
        </SidebarDragProvider>
      </SortableContext>
    </DndContext>
  );
}

export function ScopedSortableThreadRow(props: {
  thread: EnvironmentThreadShell;
  /** A row being renamed keeps pointer gestures for text selection. */
  dragDisabled?: boolean;
  children: (
    bag: SortableThreadRowBag | undefined,
    verb: SidebarDropVerb | null,
    overPinned: boolean,
  ) => ReactNode;
}) {
  const scope = useContext(DragScope);
  const key = keyOf(props.thread);
  const sortable = useSortable({
    id: key,
    disabled: {
      draggable:
        props.dragDisabled === true ||
        !scope?.enabledKeys.has(key) ||
        !scope.draggableKeys.has(key),
      droppable: !scope?.enabledKeys.has(key),
    },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const { listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const registerNode = scope?.registerNode;
  const attach = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      registerNode?.(key, node);
    },
    [setNodeRef, registerNode, key],
  );
  const bag = useMemo(
    () => ({ listeners, setNodeRef: attach, transform, transition, isDragging }),
    [listeners, attach, transform, transition, isDragging],
  );
  return props.children(
    scope ? bag : undefined,
    scope?.from ? resolveSidebarDropVerb(scope.from, scope.destination) : null,
    scope?.destination === "pinned",
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
  const registerNode = scope?.registerNode;
  const attach = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      registerNode?.(id, node);
    },
    [setNodeRef, registerNode, id],
  );
  const section =
    props.marker === "pinned-header"
      ? "pinned"
      : props.marker.startsWith("settled")
        ? "settled"
        : props.marker === "snoozed-header"
          ? "snoozed"
          : "active";
  const boundary = props.marker === "pinned-header" || props.marker === "pinned-divider";
  const placeholder = props.marker.endsWith("-placeholder");
  const visible = scope?.dragging === true;
  const isDropTarget = visible && scope?.destination === section;
  const count = section === "active" ? scope?.activeCount : scope?.settledCount;
  const showHint =
    visible &&
    (count === 0 ||
      (count === 1 &&
        scope?.from === section &&
        scope.destination !== null &&
        scope.destination !== section));
  return (
    <li
      ref={attach}
      data-thread-selection-safe
      data-testid={`sidebar-${props.marker}`}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: placeholder ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      className={cn(
        "relative list-none",
        boundary || placeholder ? "-mb-px h-0" : props.children ? "" : "h-8",
        visible &&
          props.marker === "settled-header" &&
          "[&_button]:text-sidebar-foreground/80 [&_span]:text-sidebar-foreground/80",
        isDropTarget && "[&_button]:text-primary [&_span]:text-primary [&_.h-px]:bg-primary/50",
        props.className,
      )}
    >
      {props.children ??
        (placeholder ? (
          <div
            aria-hidden={!showHint}
            data-sidebar-drag-placeholder=""
            style={{ visibility: showHint ? undefined : "hidden" }}
            className={cn(
              "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
              isDropTarget && "border-primary/40 bg-primary/5 text-primary",
            )}
          >
            {props.label}
          </div>
        ) : boundary ? (
          <div
            data-sidebar-drag-label
            aria-hidden={!visible}
            style={{ visibility: visible ? undefined : "hidden" }}
            className={cn(
              "pointer-events-none absolute inset-x-2 top-1 flex h-4 items-center gap-2",
              visible && "sidebar-drag-boundary-label",
            )}
          >
            <span
              className={cn(
                "shrink-0 text-xs font-medium",
                isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
              )}
            >
              {props.label}
            </span>
            <span
              aria-hidden
              className={cn(
                "h-px flex-1",
                isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
              )}
            />
          </div>
        ) : (
          <span
            className={cn(
              "flex h-full items-center gap-2 px-2 text-xs font-medium",
              visible ? "text-sidebar-foreground/80" : "text-sidebar-muted-foreground/60",
              isDropTarget && "text-primary",
            )}
          >
            {props.label}
            <span
              aria-hidden
              className={cn(
                "h-px flex-1 bg-sidebar-border/60",
                visible && "bg-sidebar-foreground/25",
                isDropTarget && "bg-primary/50",
              )}
            />
          </span>
        ))}
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
