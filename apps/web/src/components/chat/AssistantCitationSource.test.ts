import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, ThreadId } from "@lecturn/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  observeAssistantCitationCommentSource,
  observeAssistantCitationSource,
  type AssistantCitationTarget,
} from "./AssistantCitationSource";

const mocks = vi.hoisted(() => ({ resolveRange: vi.fn(), toast: vi.fn() }));
vi.mock("~/lib/assistantTextSelection", () => ({
  resolveAssistantCitationRange: mocks.resolveRange,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

function rect(top: number, height = 20) {
  return { top, bottom: top + height, height, width: 100 } as DOMRect;
}

class TestAnimation {
  currentTime = 0;
  id = "";
  private resolveFinished!: () => void;
  finished = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });
  cancel = vi.fn();
  finish() {
    this.resolveFinished();
  }
}

class TestElement {
  parentNode: TestElement | null = null;
  dataset: Record<string, string> = {};
  focus = vi.fn();
  animations: TestAnimation[] = [];
  animate = vi.fn(() => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation as unknown as Animation;
  });
  isConnected = true;
  scrollTop = 8586;
  scrollHeight = 9334;
  clientHeight = 748;
  getBoundingClientRect = () => rect(0, this.clientHeight);
  ownerDocument = {
    getSelection: () => null as TestSelection | null,
  };

  contains(node: TestElement | null): boolean {
    return node === this || (node?.parentNode ? this.contains(node.parentNode) : false);
  }
}

class TestRange {
  startOffset = 0;
  endOffset = 5;
  collapsed = false;
  endContainer: TestElement;

  constructor(
    public startContainer: TestElement,
    readonly readRect: () => DOMRect,
  ) {
    this.endContainer = startContainer;
  }

  getBoundingClientRect() {
    return this.collapsed ? rect(0, 0) : this.readRect();
  }

  cloneRange() {
    const copy = new TestRange(this.startContainer, this.readRect);
    copy.startOffset = this.startOffset;
    copy.endOffset = this.endOffset;
    return copy;
  }

  collapseTo(parent: TestElement) {
    this.startContainer = this.endContainer = parent;
    this.startOffset = this.endOffset = 0;
    this.collapsed = true;
  }

  setStart(node: TestElement, offset: number) {
    this.startContainer = node;
    this.startOffset = offset;
    this.collapsed =
      this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  setEnd(node: TestElement, offset: number) {
    this.endContainer = node;
    this.endOffset = offset;
    this.collapsed =
      this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  toString() {
    return this.collapsed ? "" : "quote";
  }
}

class TestSelection {
  ranges: TestRange[] = [];
  get rangeCount() {
    return this.ranges.length;
  }
  getRangeAt(index: number) {
    return this.ranges[index]!;
  }
  addRange(range: TestRange) {
    this.ranges.push(range);
  }
  removeRange(range: TestRange) {
    this.ranges = this.ranges.filter((current) => current !== range);
  }
  removeAllRanges() {
    this.ranges = [];
  }
}

function createSource({ reducedMotion = false } = {}) {
  vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: reducedMotion })) });
  let now = 0;
  vi.stubGlobal("performance", { now: () => now });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const mutationCallbacks = new Set<MutationCallback>();
  let resize: ResizeObserverCallback = () => {};
  const resizeEntries: ResizeObserverEntry[] = [];
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(readonly callback: MutationCallback) {}
      observe() {
        mutationCallbacks.add(this.callback);
      }
      disconnect() {
        mutationCallbacks.delete(this.callback);
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe(target: Element) {
        resizeEntries.push({ target } as ResizeObserverEntry);
      }
      disconnect() {
        resize = () => {};
      }
    },
  );
  vi.stubGlobal("HTMLElement", TestElement);
  const highlights = new Map<string, Set<TestRange>>();
  vi.stubGlobal(
    "Highlight",
    class extends Set<TestRange> {
      constructor(...ranges: TestRange[]) {
        super(ranges);
      }
    },
  );
  vi.stubGlobal("CSS", { highlights });

  const scrollNode = new TestElement();
  const container = new TestElement();
  container.parentNode = scrollNode;
  const root = new TestElement();
  root.parentNode = container;
  const text = new TestElement();
  text.parentNode = root;
  let sourceTop = 200;
  let measured = true;
  let rangeHeight = 20;
  root.getBoundingClientRect = () => rect(sourceTop - scrollNode.scrollTop, 300);
  mocks.resolveRange.mockImplementation(
    () => new TestRange(text, () => rect(sourceTop - scrollNode.scrollTop, rangeHeight)),
  );
  const listeners = new Set<() => void>();
  const listen = (callback: () => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
  const layoutChanged = () => {
    for (const listener of listeners) listener();
  };
  let pending: { options: { offset: number }; resolve: () => void } | null = null;
  const scrollToOffset = vi.fn((options: { offset: number; animated?: boolean }) => {
    pending?.resolve();
    return new Promise<void>((resolve) => {
      pending = { options, resolve };
    });
  });
  const finishScroll = async () => {
    const scroll = pending;
    if (!scroll) throw new Error("No citation scroll is pending");
    pending = null;
    scrollNode.scrollTop = scroll.options.offset;
    scroll.resolve();
    await Promise.resolve();
    flushFrame();
  };
  const list = {
    getScrollableNode: () => scrollNode,
    getState: () => ({
      scroll: scrollNode.scrollTop,
      indexByKey: () => 1,
      sizeAtIndex: () => (measured ? 300 : undefined),
      listenToPosition: (_key: string, callback: () => void) => listen(callback),
      listen: (_signal: string, callback: () => void) => listen(callback),
    }),
    scrollToOffset,
  } as unknown as LegendListRef;
  const target: AssistantCitationTarget = {
    key: "activation-one",
    citation: {
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: "quote",
      start: 0,
      end: 5,
      prefix: "",
      suffix: "",
    },
    activationRef: { current: { scrolled: false, dismissed: false } },
    onComplete: vi.fn(),
  };
  const cleanups: Array<() => void> = [];
  const mount = (request = target) => {
    const cleanup = observeAssistantCitationSource({
      root: root as unknown as HTMLElement,
      itemKey: "source-row",
      request,
      list,
    });
    if (cleanup) cleanups.push(cleanup);
    return cleanup;
  };
  const mountComment = (
    range = new TestRange(text, () => rect(sourceTop - scrollNode.scrollTop, rangeHeight)),
  ) => {
    const onUnavailable = vi.fn();
    const cleanup = observeAssistantCitationCommentSource({
      anchor: {
        source: root as unknown as HTMLElement,
        range: range as unknown as Range,
        viewport: scrollNode as unknown as HTMLElement,
      },
      citation: target.citation,
      onUnavailable,
    });
    cleanups.push(cleanup);
    return { range, onUnavailable, cleanup };
  };
  const mutation = (changed: TestElement, removed: TestElement[] = []) => {
    for (const callback of mutationCallbacks) {
      callback(
        [{ target: changed, addedNodes: [], removedNodes: removed }] as unknown as MutationRecord[],
        {} as MutationObserver,
      );
    }
  };
  return {
    target,
    root,
    text,
    container,
    scrollNode,
    highlights,
    scrollToOffset,
    mount,
    mountComment,
    flushFrame,
    finishScroll,
    layoutChanged,
    mutation,
    advanceTime: (milliseconds: number) => {
      now += milliseconds;
    },
    finishPulse: async () => {
      root.animations.at(-1)?.finish();
      await Promise.resolve();
    },
    resize: () => resize(resizeEntries, {} as ResizeObserver),
    setMeasured: (value: boolean) => {
      measured = value;
    },
    setRangeHeight: (value: number) => {
      rangeHeight = value;
    },
    setSourceTop: (value: number) => {
      sourceTop = value;
    },
    highlight: () => highlights.get("lecturn-assistant-citation")?.values().next().value,
    commentHighlight: () => highlights.get("lecturn-assistant-citation-comment"),
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("assistant citation source lifecycle", () => {
  it("keeps comment and navigation priority above persistent note highlights", async () => {
    const source = createSource();
    source.mountComment();
    source.mount();
    source.flushFrame();
    await source.finishScroll();
    expect(source.commentHighlight()).toHaveProperty("priority", 2);
    expect(source.highlights.get("lecturn-assistant-citation")).toHaveProperty("priority", 3);
    source.cleanup();
  });
});
