import {
  CONTROL_SELECTOR,
  resolveAssistantCitationRanges,
  type AssistantTextSelector,
} from "./assistantTextSelection";

export const THREAD_NOTE_HIGHLIGHT = "lecturn-thread-note";
export const ACTIVE_THREAD_NOTE_HIGHLIGHT = "lecturn-thread-note-active";
export type ThreadNoteHighlightSelector = AssistantTextSelector & { readonly id: string };
type HighlightSet = {
  add(range: AbstractRange): unknown;
  clear(): void;
  delete(range: AbstractRange): boolean;
  priority: number;
};
type Point = { node: Node; offset: number };
type Click = { target: EventTarget | null; clientX: number; clientY: number };

export interface ThreadNoteHighlightDependencies {
  highlights: {
    set(name: string, value: HighlightSet): unknown;
    delete(name: string): unknown;
  } | null;
  createHighlight: () => HighlightSet;
  observe: (
    viewport: HTMLElement,
    callback: (records: readonly MutationRecord[]) => void,
  ) => () => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  delay: (callback: () => void, milliseconds: number) => () => void;
  now: () => number;
  resolve: typeof resolveAssistantCitationRanges;
  selection: (document: Document) => Pick<Selection, "isCollapsed"> | null;
  /** null means unavailable; an empty list means no painted highlight at the point. */
  rangesAtPoint: (x: number, y: number) => readonly AbstractRange[] | null;
  caretAtPoint: (document: Document, x: number, y: number) => Point | null;
}

function browserDependencies(): ThreadNoteHighlightDependencies {
  const highlights =
    typeof CSS !== "undefined" && typeof Highlight !== "undefined" ? CSS.highlights : null;
  return {
    highlights: highlights
      ? {
          set: (name, value) => highlights.set(name, value as Highlight),
          delete: (name) => highlights.delete(name),
        }
      : null,
    createHighlight: () => new Highlight(),
    observe: (viewport, callback) => {
      const observer = new MutationObserver(callback);
      observer.observe(viewport, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden"],
      });
      return () => observer.disconnect();
    },
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (id) => cancelAnimationFrame(id),
    delay: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
    resolve: resolveAssistantCitationRanges,
    selection: (document) => document.getSelection(),
    rangesAtPoint: (x, y) => {
      const registry = highlights as unknown as {
        highlightsFromPoint?: (
          x: number,
          y: number,
        ) => { highlight: Highlight; ranges: AbstractRange[] }[];
      } | null;
      if (!registry?.highlightsFromPoint) return null;
      return registry
        .highlightsFromPoint(x, y)
        .filter(
          (result) =>
            result.highlight === highlights?.get(THREAD_NOTE_HIGHLIGHT) ||
            result.highlight === highlights?.get(ACTIVE_THREAD_NOTE_HIGHLIGHT),
        )
        .flatMap((result) => result.ranges);
    },
    caretAtPoint: (document, x, y) => {
      const caretDocument = document as Document & {
        caretPositionFromPoint?: (
          x: number,
          y: number,
        ) => { offsetNode: Node; offset: number } | null;
      };
      const point = caretDocument.caretPositionFromPoint?.(x, y);
      if (point) return { node: point.offsetNode, offset: point.offset };
      const range = document.caretRangeFromPoint?.(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    },
  };
}

type Entry = { selector: ThreadNoteHighlightSelector; range: Range | null };
type Source = {
  viewport: HTMLElement;
  root: HTMLElement;
  owners: Map<symbol, Entry[]>;
  lastResolved: number;
  cancelDelay?: () => void;
};

/** A single owner for persistent note paint; it never pins virtualized rows. */
export function createThreadNoteHighlightRegistry(deps = browserDependencies()) {
  const sources = new Map<HTMLElement, Source>();
  const viewports = new Map<HTMLElement, { sources: Set<Source>; disconnect: () => void }>();
  const dirty = new Set<Source>();
  const notes = deps.highlights ? deps.createHighlight() : null;
  const active = deps.highlights ? deps.createHighlight() : null;
  if (notes) notes.priority = 0;
  if (active) active.priority = 1;
  let activeId: string | null = null;
  let frame: number | null = null;
  let disposed = false;
  let enabled = true;
  const entries = (source: Source) => [...source.owners.values()].flat();
  const intact = (source: Source, range: Range | null) =>
    range !== null &&
    !range.collapsed &&
    source.root.isConnected &&
    source.viewport.contains(source.root) &&
    source.root.contains(range.startContainer) &&
    source.root.contains(range.endContainer);
  const paint = () => {
    notes?.clear();
    active?.clear();
    let count = 0;
    let activeCount = 0;
    for (const source of sources.values()) {
      if (!enabled) break;
      for (const entry of entries(source)) {
        if (!intact(source, entry.range)) continue;
        notes?.add(entry.range!);
        count++;
        if (entry.selector.id === activeId) {
          active?.add(entry.range!);
          activeCount++;
        }
      }
    }
    if (count && notes) deps.highlights?.set(THREAD_NOTE_HIGHLIGHT, notes);
    else deps.highlights?.delete(THREAD_NOTE_HIGHLIGHT);
    if (activeCount && active) deps.highlights?.set(ACTIVE_THREAD_NOTE_HIGHLIGHT, active);
    else deps.highlights?.delete(ACTIVE_THREAD_NOTE_HIGHLIGHT);
  };
  const flush = () => {
    frame = null;
    for (const source of dirty) {
      dirty.delete(source);
      source.cancelDelay?.();
      delete source.cancelDelay;
      const values = entries(source);
      if (!source.root.isConnected || !source.viewport.contains(source.root)) {
        for (const entry of values) entry.range = null;
        continue;
      }
      const wait = 250 - (deps.now() - source.lastResolved);
      // Invalidated ranges must recover next frame, even while text streams.
      if (wait > 0 && values.every((entry) => intact(source, entry.range))) {
        source.cancelDelay = deps.delay(() => schedule(source), wait);
        continue;
      }
      const resolved = deps.resolve(
        source.root,
        values.map((entry) => entry.selector),
      );
      source.lastResolved = deps.now();
      for (const [index, entry] of values.entries()) {
        const next = resolved[index] ?? null;
        if (next && entry.range) {
          entry.range.setStart(next.startContainer, next.startOffset);
          entry.range.setEnd(next.endContainer, next.endOffset);
        } else entry.range = next;
      }
    }
    paint();
  };
  const schedule = (source: Source) => {
    if (disposed || !source.owners.size) return;
    dirty.add(source);
    frame ??= deps.requestFrame(flush);
  };
  const acquire = (viewport: HTMLElement, root: HTMLElement, values: Entry[]) => {
    if (!deps.highlights || disposed || !values.length) return () => {};
    let source = sources.get(root);
    if (!source) {
      source = { root, viewport, owners: new Map(), lastResolved: -Infinity };
      sources.set(root, source);
      let watched = viewports.get(viewport);
      if (!watched) {
        const affected = new Set<Source>();
        const disconnect = deps.observe(viewport, (records) => {
          for (const candidate of affected) {
            const invalid = entries(candidate).some((entry) => !intact(candidate, entry.range));
            const changed = records.some(
              (record) =>
                candidate.root.contains(record.target) ||
                (record.type === "attributes" && record.target.contains(candidate.root)) ||
                [...record.addedNodes, ...record.removedNodes].some((node) =>
                  node.contains(candidate.root),
                ),
            );
            if (invalid || changed) schedule(candidate);
          }
        });
        watched = { sources: affected, disconnect };
        viewports.set(viewport, watched);
      }
      watched.sources.add(source);
    }
    const token = Symbol();
    source.owners.set(token, values);
    schedule(source);
    paint();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      source.owners.delete(token);
      if (!source.owners.size) {
        source.cancelDelay?.();
        sources.delete(root);
        dirty.delete(source);
        const watched = viewports.get(viewport);
        watched?.sources.delete(source);
        if (watched?.sources.size === 0) {
          watched.disconnect();
          viewports.delete(viewport);
        }
      }
      paint();
    };
  };
  return {
    supported: deps.highlights !== null,
    register: (
      viewport: HTMLElement,
      root: HTMLElement,
      selectors: readonly ThreadNoteHighlightSelector[],
    ) =>
      acquire(
        viewport,
        root,
        selectors.map((selector) => ({ selector, range: null })),
      ),
    /** Keeps the saved range painted until the create + list refresh have settled. */
    hold: (
      viewport: HTMLElement,
      root: HTMLElement,
      id: string,
      range: Range,
      selector: AssistantTextSelector,
    ) => acquire(viewport, root, [{ selector: { ...selector, id }, range: range.cloneRange() }]),
    /** Visibility does not release pending-save holds or mounted source ownership. */
    setEnabled: (value: boolean) => {
      enabled = value;
      paint();
    },
    setActive: (id: string | null) => {
      activeId = id;
      paint();
    },
    hitTest: (viewport: HTMLElement, event: Click): string | null => {
      if (
        !deps.highlights ||
        !enabled ||
        disposed ||
        deps.selection(viewport.ownerDocument)?.isCollapsed === false
      )
        return null;
      const target = event.target as Node | null;
      const element = target?.nodeType === 1 ? (target as Element) : target?.parentElement;
      if (
        !element ||
        !viewport.contains(element) ||
        element.closest(`${CONTROL_SELECTOR}, a, [role=link]`)
      )
        return null;
      const painted = deps.rangesAtPoint(event.clientX, event.clientY);
      const caret =
        painted === null
          ? deps.caretAtPoint(viewport.ownerDocument, event.clientX, event.clientY)
          : null;
      let best: Entry | null = null;
      for (const source of sources.values()) {
        if (source.viewport !== viewport || !source.root.contains(element)) continue;
        for (const entry of entries(source)) {
          if (!intact(source, entry.range)) continue;
          const range = entry.range!;
          const hit =
            painted !== null
              ? painted.some(
                  (candidate) =>
                    candidate.startContainer === range.startContainer &&
                    candidate.startOffset === range.startOffset &&
                    candidate.endContainer === range.endContainer &&
                    candidate.endOffset === range.endOffset,
                )
              : caret && range.isPointInRange(caret.node, caret.offset);
          if (
            hit &&
            (!best ||
              entry.selector.end - entry.selector.start < best.selector.end - best.selector.start)
          )
            best = entry;
        }
      }
      return best?.selector.id ?? null;
    },
    dispose: () => {
      disposed = true;
      if (frame !== null) deps.cancelFrame(frame);
      for (const source of sources.values()) source.cancelDelay?.();
      for (const watched of viewports.values()) watched.disconnect();
      sources.clear();
      viewports.clear();
      dirty.clear();
      paint();
    },
  };
}

let sharedRegistry: ReturnType<typeof createThreadNoteHighlightRegistry> | undefined;
export function getThreadNoteHighlightRegistry() {
  return (sharedRegistry ??= createThreadNoteHighlightRegistry());
}
