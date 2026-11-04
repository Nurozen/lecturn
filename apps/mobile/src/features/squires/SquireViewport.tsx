import { createContext, useContext, useEffect, useState, type RefObject } from "react";
import {
  createSquireViewport,
  squireRectInView,
  type SquireRect,
  type SquireViewport,
} from "./squireMotion";

/**
 * Plain ScrollViews have no list viewability, so a working indicator in one measures itself
 * against the scroll view's window rect on each scroll and pauses its motion while out of view.
 */
export const SquireViewportContext = createContext<SquireViewport | null>(null);

interface Measurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
}

const measure = (node: Measurable | null, onRect: (rect: SquireRect) => void) =>
  node?.measureInWindow((x, y, width, height) => onRect({ x, y, width, height }));

/** For the scroll view: provide `viewport`, and call `onLayout` and `onScroll` from its own. */
export function useSquireScrollViewport(scrollRef: RefObject<Measurable | null>) {
  const [viewport] = useState(createSquireViewport);
  return {
    viewport,
    onLayout: () => measure(scrollRef.current, viewport.setRect),
    onScroll: viewport.notify,
  };
}

/** For a nested scroller (a horizontal strip): its scrolling moves indicators too. */
export function useSquireViewportScroll() {
  const viewport = useContext(SquireViewportContext);
  return () => viewport?.notify();
}

/**
 * For the View (`ref`) wrapping one indicator. `visible` stays undefined (animate) outside a
 * viewport, before the first measure, and while the indicator is not working, so it costs
 * nothing then.
 */
export function useSquireInView(ref: RefObject<Measurable | null>, working: boolean) {
  const viewport = useContext(SquireViewportContext);
  const [visible, setVisible] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!working || viewport === null) return;
    const check = () => {
      const rect = viewport.rect();
      if (rect === null) return;
      measure(ref.current, (item) => setVisible(squireRectInView(item, rect)));
    };
    check();
    return viewport.subscribe(check);
  }, [ref, working, viewport]);
  return {
    // A moved indicator re-measures with the rest; only working ones are subscribed.
    onLayout: () => viewport?.notify(),
    visible: working && viewport !== null ? visible : undefined,
  };
}
