import {
  activityVisualPresentation,
  type ActivityVisualState,
} from "@lecturn/client-runtime/state/activityContext";
import type { PullRequestCheckStatus } from "@lecturn/contracts";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import "./activityWatchVisual.css";

export function ActivityWatchFrame(props: { state: ActivityVisualState; children: ReactNode }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!element || !["active", "attention"].includes(props.state)) {
      setMoving(false);
      return;
    }
    let visible = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMoving(visible && !document.hidden && !reduced.matches);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting === true;
      sync();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", sync);
    reduced.addEventListener("change", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduced.removeEventListener("change", sync);
    };
  }, [element, props.state]);
  return (
    <article
      ref={setElement}
      className="lecturn-watch-activity space-y-3 rounded-xl border p-3 text-sm"
      data-activity-state={props.state}
      data-moving={moving && ["active", "attention"].includes(props.state)}
      style={
        { "--watch-state-color": activityVisualPresentation[props.state].color } as CSSProperties
      }
    >
      {props.children}
    </article>
  );
}

export function ActivityWatchState({
  state,
  detail,
}: {
  state: ActivityVisualState;
  detail: string;
}) {
  const presentation = activityVisualPresentation[state];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={`${presentation.label}: ${detail}`}
            className="lecturn-watch-state inline-flex size-6 shrink-0 items-center justify-center rounded-full text-base font-semibold"
            style={{ color: presentation.color }}
          />
        }
      >
        <span aria-hidden>{presentation.glyph}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {presentation.label} · {detail}
      </TooltipPopup>
    </Tooltip>
  );
}

const CHECK_STATES = [
  { key: "failure", label: "Failed", color: activityVisualPresentation.failed.color },
  {
    key: "action-required",
    label: "Needs attention",
    color: activityVisualPresentation.attention.color,
  },
  { key: "pending", label: "Running or queued", color: activityVisualPresentation.active.color },
  { key: "success", label: "Passed", color: activityVisualPresentation.complete.color },
  {
    key: "other",
    label: "Skipped, neutral or cancelled",
    color: activityVisualPresentation.idle.color,
  },
] as const;

export function ActivityCheckBar({
  checks,
}: {
  checks: readonly { status: PullRequestCheckStatus }[];
}) {
  const counts = CHECK_STATES.map((group) => ({
    ...group,
    count: checks.filter((check) =>
      group.key === "other"
        ? !["failure", "action-required", "pending", "success"].includes(check.status)
        : check.status === group.key,
    ).length,
  })).filter((group) => group.count > 0);
  if (checks.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div
        role="img"
        aria-label={`CI: ${counts.map((group) => `${group.count} ${group.label.toLowerCase()}`).join(", ")}`}
        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted/30"
      >
        {counts.map((group) => (
          <span key={group.key} style={{ flexGrow: group.count, backgroundColor: group.color }} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
        {counts.map((group) => (
          <Tooltip key={group.key}>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={`${group.count} ${group.label.toLowerCase()}`}
                  className="inline-flex items-center gap-1.5 rounded"
                />
              }
            >
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ backgroundColor: group.color }}
              />
              {group.count}
            </TooltipTrigger>
            <TooltipPopup>
              {group.count} {group.label.toLowerCase()}
            </TooltipPopup>
          </Tooltip>
        ))}
        <span className="ml-auto text-muted-foreground">{checks.length} jobs</span>
      </div>
    </div>
  );
}
