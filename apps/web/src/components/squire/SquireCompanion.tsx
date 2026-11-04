import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from "react";

import { cn } from "../../lib/utils";
import type { CompanionPlacement } from "./companion/companionLease";
import type {
  CompanionElement,
  CompanionGesture,
  CompanionPauseReason,
  CompanionState,
  GestureResult,
  SquireCompanion as SquireCompanionChoice,
} from "./companion/types";

/**
 * Where a full figure shows. Every placement but the panel is an overlay for the
 * single live rig, so a hover card or setup preview stills the panel while it is mounted.
 */
export type SquireCompanionPlacement = "panel" | "hover" | "setup" | "onboarding" | "overlay";

const leasePlacement = (placement: SquireCompanionPlacement): CompanionPlacement =>
  placement === "panel" ? "panel" : "overlay";

// A just-mounted companion is paused while its art decodes and its first visibility check
// lands. A gesture sent then (greet on first open) waits that out, for at most 2 s, instead of
// dropping.
const STARTUP_PAUSES: ReadonlySet<CompanionPauseReason | null> = new Set([
  "missing-art",
  "offscreen",
]);
async function untilStarted(element: CompanionElement) {
  for (let tries = 0; tries < 20 && STARTUP_PAUSES.has(element.debugState.reason); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface SquireCompanionHandle {
  /** Wakes a settled companion first; resolves `played: false` while it is genuinely paused. */
  play(name: CompanionGesture): Promise<GestureResult>;
}

// The runtime (about 80 KB gzipped) and the figure art stay out of the main bundle until a
// full-figure placement first mounts.
let runtime: Promise<void> | null = null;
export function loadCompanionRuntime() {
  runtime ??= import("./companion/runtime").then((module) => module.defineCompanionElements());
  return runtime;
}

function companionAttributes(
  companion: SquireCompanionChoice,
  state: CompanionState,
  placement: CompanionPlacement,
  crest: boolean,
  label: string,
  mirrored: boolean,
): Record<string, string> {
  const shared = { palette: companion.palette, motion: companion.motion, state, placement, label };
  return companion.presence === "figure"
    ? {
        ...shared,
        appearance: companion.appearance,
        hood: companion.hood,
        equipment: companion.equipment,
        crest: crest ? "on" : "off",
        // The host's -scale-x-100 flips the stage; the rig needs it to aim its gaze at the pointer.
        mirrored: mirrored ? "on" : "off",
      }
    : { ...shared, frame: companion.frame, weight: companion.weight, glow: companion.glow };
}

export function SquireCompanion(props: {
  readonly companion: SquireCompanionChoice;
  readonly state: CompanionState;
  readonly label: string;
  /** Hover card, setup preview, and onboarding outrank the panel for the single live rig. */
  readonly placement?: SquireCompanionPlacement;
  /** The Lead's crest (figure presence only); every Lead placement passes it. */
  readonly crest?: boolean;
  /**
   * The rig's art faces right; beside the main content (panel, sidebar hover) it is mirrored to
   * face the content. Figures only: the emblem is the Threadkeeper letterform.
   */
  readonly facesContent?: boolean;
  readonly className?: string;
  readonly ref?: Ref<SquireCompanionHandle> | undefined;
}) {
  const {
    companion,
    state,
    label,
    placement = "panel",
    crest = false,
    facesContent = false,
    className,
    ref,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<CompanionElement | null>(null);
  const tag = companion.presence === "figure" ? "squire-rig" : "squire-emblem";
  const attributes = companionAttributes(
    companion,
    state,
    leasePlacement(placement),
    crest,
    label,
    facesContent,
  );
  const attributeKey = JSON.stringify(attributes);
  const applyAttributes = useEffectEvent((element: CompanionElement) => {
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  });

  // Created imperatively so React never reconciles the shadow-DOM element; swapping presence
  // replaces it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    void loadCompanionRuntime();
    const element = document.createElement(tag) as CompanionElement;
    element.style.display = "block";
    element.style.width = "100%";
    // Attributes before connecting, so the element's first frame and entrance use them.
    applyAttributes(element);
    elementRef.current = element;
    host.append(element);
    return () => {
      element.remove();
      if (elementRef.current === element) elementRef.current = null;
    };
  }, [tag]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    for (const [name, value] of Object.entries(
      JSON.parse(attributeKey) as Record<string, string>,
    )) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  }, [attributeKey]);

  useImperativeHandle(
    ref,
    () => ({
      async play(name) {
        await loadCompanionRuntime();
        const element = elementRef.current;
        if (!element) return { name, played: false };
        await customElements.whenDefined(element.localName);
        await untilStarted(element);
        if (elementRef.current !== element) return { name, played: false };
        return element.play(name);
      },
    }),
    [],
  );

  // The rig's FX blend (screen, color-dodge) and repaint every live frame. Its own stacking
  // context keeps those blends from reaching the page behind it, and layout containment keeps
  // its frames from re-laying out the page. Paint is not contained, since FX may draw past the
  // stage; the stacking context already confines repaint to the companion's own layer.
  return (
    <div
      ref={hostRef}
      className={cn(
        "isolate contain-layout contain-style",
        facesContent && companion.presence === "figure" && "-scale-x-100",
        className,
      )}
    />
  );
}
