import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { GripVerticalIcon, PinIcon, PinOffIcon } from "lucide-react";
import {
  SAGA_WORKBENCH_STAGES,
  sagaWorkbenchStageLabel,
} from "@t3tools/client-runtime/state/sagaWorkbench";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { SagaStageDragGesture } from "./sagaWorkbench.logic";
import type { SagaWorkbenchStage } from "@t3tools/contracts";

/** Keyboard movement targets phase columns, including empty columns. */
const phaseCoordinates: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  const direction =
    event.code === "ArrowRight" || event.code === "ArrowDown"
      ? 1
      : event.code === "ArrowLeft" || event.code === "ArrowUp"
        ? -1
        : 0;
  if (!direction) return;
  event.preventDefault();
  const current = SAGA_WORKBENCH_STAGES.findIndex((stage) => stage === context.over?.id);
  const start =
    current >= 0 ? current : SAGA_WORKBENCH_STAGES.indexOf(context.active?.data.current?.stage);
  const target = SAGA_WORKBENCH_STAGES[Math.max(0, Math.min(4, start + direction))];
  const rect = target && context.droppableRects.get(target);
  if (!rect || !context.collisionRect) return;
  return {
    x:
      currentCoordinates.x +
      rect.left +
      rect.width / 2 -
      context.collisionRect.left -
      context.collisionRect.width / 2,
    y:
      currentCoordinates.y +
      rect.top +
      rect.height / 2 -
      context.collisionRect.top -
      context.collisionRect.height / 2,
  };
};

export function SagaWorkbenchBoard({
  children,
  onPick,
  onMove,
}: {
  children: ReactNode;
  onPick: (memberId: string) => SagaStageDragGesture | null;
  onMove: (gesture: SagaStageDragGesture, stage: string) => void;
}) {
  const gesture = useRef<SagaStageDragGesture | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: phaseCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space to pick up this space. Use arrow keys to choose a workflow phase, then Space to drop. Press Escape to cancel.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${String(active.id)}. Use arrow keys to choose a phase.`,
          onDragOver: ({ over }) =>
            over ? `Over ${String(over.id)} phase.` : "Outside phase columns.",
          onDragEnd: ({ over }) =>
            over ? `Dropped in ${String(over.id)}. Saving phase change.` : "Move cancelled.",
          onDragCancel: () => "Move cancelled.",
        },
      }}
      onDragStart={({ active }) => {
        gesture.current = onPick(String(active.id));
      }}
      onDragCancel={() => {
        gesture.current = null;
      }}
      onDragEnd={({ active, over }) => {
        const picked = gesture.current;
        gesture.current = null;
        if (picked && over && picked.memberId === String(active.id))
          onMove(picked, String(over.id));
      }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-5">{children}</div>
    </DndContext>
  );
}

export function SagaPhaseColumn({
  stage,
  count,
  children,
}: {
  stage: SagaWorkbenchStage;
  count: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={sagaWorkbenchStageLabel(stage)}
      className={`min-w-0 rounded-xl border p-2 ${isOver ? "border-primary bg-primary/10" : "border-transparent bg-muted/40"}`}
    >
      <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wide text-primary">
        {sagaWorkbenchStageLabel(stage)} <span className="text-muted-foreground">{count}</span>
      </h2>
      <div className="min-h-16 space-y-2">{children}</div>
    </section>
  );
}

export function SagaWorkbenchCard({
  id,
  stage,
  draggable,
  pinned,
  canPin,
  onPin,
  running,
  children,
}: {
  id: string;
  stage: SagaWorkbenchStage;
  draggable: boolean;
  pinned: boolean;
  canPin: boolean;
  onPin: () => void;
  running: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, isDragging } =
    useDraggable({
      id,
      disabled: !draggable,
      data: { stage },
    });
  return (
    <div
      ref={setNodeRef}
      className={`relative isolate rounded-lg ${isDragging ? "z-20 opacity-80" : ""}`}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
    >
      {children}
      <div className="absolute right-2 top-2 flex gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-lecturn-hover
                className="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
                aria-label={`${pinned ? "Unpin" : "Pin"} ${id} stage`}
                aria-pressed={pinned}
                disabled={!canPin}
                onClick={onPin}
              >
                {pinned ? (
                  <PinIcon className="size-3.5 text-primary" />
                ) : (
                  <PinOffIcon className="size-3.5" />
                )}
              </button>
            }
          />
          <TooltipPopup>
            {pinned
              ? "Stage pinned; summaries continue updating"
              : "Pin stage to prevent all movement"}
          </TooltipPopup>
        </Tooltip>
        {draggable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  ref={setActivatorNodeRef}
                  {...listeners}
                  {...attributes}
                  aria-label={`Move ${id} to another phase`}
                  className="touch-none cursor-grab rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing"
                >
                  <GripVerticalIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup>Drag to a phase; keyboard: Space, arrows, Space</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {running ? <GoldThreadBorder /> : null}
    </div>
  );
}

/** Only transform small decorative particles; stop work outside the visible viewport. */
function GoldThreadBorder() {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let intersects = false;
    const update = () => setVisible(intersects && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => {
      intersects = !!entry?.isIntersecting;
      update();
    });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <span ref={ref} aria-hidden="true" className="lecturn-running-border" data-moving={visible}>
      <span className="lecturn-running-edge lecturn-running-top" />
      <span className="lecturn-running-edge lecturn-running-right" />
      <span className="lecturn-running-edge lecturn-running-bottom" />
      <span className="lecturn-running-edge lecturn-running-left" />
    </span>
  );
}
