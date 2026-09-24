import { describe, expect, it } from "vite-plus/test";
import {
  ACTIVE_THREAD_NOTE_HIGHLIGHT,
  THREAD_NOTE_HIGHLIGHT,
  createThreadNoteHighlightRegistry,
  type ThreadNoteHighlightDependencies,
  type ThreadNoteHighlightSelector,
} from "./threadNoteHighlights";

class TestNode {
  nodeType = 1;
  isConnected = true;
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  ownerDocument = {} as Document;
  control = false;
  append(child: TestNode) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  closest(): TestNode | null {
    return this.control ? this : (this.parentElement?.closest() ?? null);
  }
  element() {
    return this as unknown as HTMLElement;
  }
}
class TestRange {
  constructor(
    public startContainer: Node,
    public startOffset: number,
    public endContainer = startContainer,
    public endOffset = startOffset + 4,
  ) {}
  get collapsed() {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }
  setStart(node: Node, offset: number) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node: Node, offset: number) {
    this.endContainer = node;
    this.endOffset = offset;
  }
  cloneRange() {
    return new TestRange(
      this.startContainer,
      this.startOffset,
      this.endContainer,
      this.endOffset,
    ).range();
  }
  isPointInRange(node: Node, offset: number) {
    return node === this.startContainer && offset >= this.startOffset && offset <= this.endOffset;
  }
  range() {
    return this as unknown as Range;
  }
}
class TestHighlight extends Set<AbstractRange> {
  priority = -1;
}
const note = (id: string, start = 0, end = 4): ThreadNoteHighlightSelector => ({
  id,
  text: "text",
  start,
  end,
  prefix: "",
  suffix: "",
});

function harness(supported = true) {
  const viewport = new TestNode();
  const row = viewport.append(new TestNode());
  const root = row.append(new TestNode());
  let text = root.append(new TestNode());
  const highlights = new Map<string, TestHighlight>();
  const observers = new Map<HTMLElement, (records: readonly MutationRecord[]) => void>();
  const frames = new Map<number, () => void>();
  const delays = new Map<number, () => void>();
  let sequence = 0;
  let now = 0;
  let walks = 0;
  let selectionCollapsed = true;
  let painted: readonly AbstractRange[] | null = null;
  let caretCalls = 0;
  let caretOffset = 2;
  const deps: ThreadNoteHighlightDependencies = {
    highlights: supported
      ? {
          set: (name, value) => highlights.set(name, value as TestHighlight),
          delete: (name) => highlights.delete(name),
        }
      : null,
    createHighlight: () => new TestHighlight(),
    observe: (node, callback) => {
      observers.set(node, callback);
      return () => {
        observers.delete(node);
      };
    },
    requestFrame: (callback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    delay: (callback) => {
      const id = ++sequence;
      delays.set(id, callback);
      return () => {
        delays.delete(id);
      };
    },
    now: () => now,
    resolve: (_root, selectors) => {
      walks++;
      return selectors.map((selector) =>
        new TestRange(text.element(), selector.start, text.element(), selector.end).range(),
      );
    },
    selection: () => ({ isCollapsed: selectionCollapsed }),
    rangesAtPoint: () => painted,
    caretAtPoint: () => {
      caretCalls++;
      return { node: text.element(), offset: caretOffset };
    },
  };
  const registry = createThreadNoteHighlightRegistry(deps);
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  const mutate = (target = root, moved?: TestNode) => {
    observers.get(viewport.element())?.([
      { target, addedNodes: moved ? [moved] : [], removedNodes: [] } as unknown as MutationRecord,
    ]);
  };
  return {
    registry,
    root,
    row,
    viewport,
    highlights,
    observers,
    frames,
    delays,
    flush,
    mutate,
    register: (notes: ThreadNoteHighlightSelector[]) =>
      registry.register(viewport.element(), root.element(), notes),
    walks: () => walks,
    advance: () => {
      now += 250;
      const callbacks = [...delays.values()];
      delays.clear();
      callbacks.forEach((callback) => callback());
      flush();
    },
    replaceText: () => {
      root.children = [];
      text = root.append(new TestNode());
      mutate();
    },
    hold: (id: string) =>
      registry.hold(
        viewport.element(),
        root.element(),
        id,
        new TestRange(text.element(), 0).range(),
        note(id),
      ),
    click: (target = text) =>
      registry.hitTest(viewport.element(), { target: target.element(), clientX: 10, clientY: 20 }),
    setSelection: (value: boolean) => {
      selectionCollapsed = value;
    },
    setPainted: (value: readonly AbstractRange[] | null) => {
      painted = value;
    },
    setCaretOffset: (value: number) => {
      caretOffset = value;
    },
    caretCalls: () => caretCalls,
  };
}

describe("thread note highlights", () => {
  it("coalesces multiple notes and mutations into one source resolution with explicit priorities", () => {
    const h = harness();
    h.register(Array.from({ length: 50 }, (_, index) => note(String(index))));
    h.mutate();
    h.mutate();
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.walks()).toBe(1);
    expect(h.highlights.get(THREAD_NOTE_HIGHLIGHT)?.size).toBe(50);
    expect(h.highlights.get(THREAD_NOTE_HIGHLIGHT)?.priority).toBe(0);
    h.registry.setActive("1");
    expect(h.highlights.get(ACTIVE_THREAD_NOTE_HIGHLIGHT)?.priority).toBe(1);
    expect(h.highlights.get(ACTIVE_THREAD_NOTE_HIGHLIGHT)?.size).toBe(1);
    h.registry.setActive(null);
    expect(h.highlights.has(ACTIVE_THREAD_NOTE_HIGHLIGHT)).toBe(false);
  });

  it("shares a viewport observer and disposes it only after all source owners leave", () => {
    const h = harness();
    const first = h.register([note("a")]);
    const secondRoot = h.viewport.append(new TestNode());
    const second = h.registry.register(h.viewport.element(), secondRoot.element(), [note("b")]);
    expect(h.observers.size).toBe(1);
    first();
    expect(h.observers.size).toBe(1);
    second();
    expect(h.observers.size).toBe(0);
    expect(h.highlights.size).toBe(0);
  });

  it("repairs replaced text and collapsed ranges after ancestor moves on the next frame", () => {
    const h = harness();
    h.register([note("a")]);
    h.flush();
    const original = [...h.highlights.get(THREAD_NOTE_HIGHLIGHT)!][0]! as Range;
    h.replaceText();
    h.flush();
    expect(h.walks()).toBe(2);
    expect([...h.highlights.get(THREAD_NOTE_HIGHLIGHT)!][0]).toBe(original);
    original.setEnd(original.startContainer, original.startOffset);
    h.mutate(h.viewport, h.row);
    h.flush();
    expect(original.collapsed).toBe(false);
    expect(h.walks()).toBe(3);
  });

  it("throttles intact streaming ranges without dropping paint", () => {
    const h = harness();
    h.register([note("a")]);
    h.flush();
    h.mutate();
    h.flush();
    expect(h.walks()).toBe(1);
    expect(h.highlights.get(THREAD_NOTE_HIGHLIGHT)?.size).toBe(1);
    h.advance();
    expect(h.walks()).toBe(2);
  });

  it("holds pending saves independently and removes stale paint when the source unmounts", () => {
    const h = harness();
    const unregister = h.register([note("a")]);
    h.flush();
    const release = h.hold("pending");
    unregister();
    expect(h.highlights.get(THREAD_NOTE_HIGHLIGHT)?.size).toBe(1);
    h.root.isConnected = false;
    h.mutate(h.viewport, h.row);
    h.flush();
    expect(h.highlights.size).toBe(0);
    expect(h.observers.size).toBe(1);
    release();
    expect(h.observers.size).toBe(0);
  });

  it("hides pending holds and hit testing without discarding their ranges", () => {
    const h = harness();
    const release = h.hold("pending");
    h.registry.setActive("pending");
    const original = [...h.highlights.get(THREAD_NOTE_HIGHLIGHT)!][0];
    expect(h.click()).toBe("pending");
    h.registry.setEnabled(false);
    expect(h.highlights.size).toBe(0);
    expect(h.click()).toBeNull();
    expect(h.observers.size).toBe(1);
    h.flush();
    expect(h.highlights.size).toBe(0);
    h.registry.setEnabled(true);
    expect([...h.highlights.get(THREAD_NOTE_HIGHLIGHT)!][0]).toBe(original);
    expect([...h.highlights.get(ACTIVE_THREAD_NOTE_HIGHLIGHT)!][0]).toBe(original);
    expect(h.click()).toBe("pending");
    release();
    expect(h.highlights.size).toBe(0);
    expect(h.observers.size).toBe(0);
  });

  it("clears queued work and paint on registry disposal", () => {
    const h = harness();
    h.register([note("a")]);
    h.flush();
    h.mutate();
    h.flush();
    h.registry.dispose();
    expect(h.frames.size).toBe(0);
    expect(h.delays.size).toBe(0);
    expect(h.observers.size).toBe(0);
    expect(h.highlights.size).toBe(0);
  });

  it("is a no-op without the CSS Highlight API", () => {
    const h = harness(false);
    h.register([note("a")]);
    h.hold("b");
    h.registry.setActive("a");
    expect(h.registry.supported).toBe(false);
    expect(h.observers.size).toBe(0);
    expect(h.frames.size).toBe(0);
    expect(h.click()).toBeNull();
  });
});

describe("thread note hit testing", () => {
  it("uses the shortest containing note in the caret fallback", () => {
    const h = harness();
    h.register([note("long", 0, 20), note("short", 1, 4)]);
    h.flush();
    expect(h.click()).toBe("short");
    h.setCaretOffset(9);
    expect(h.click()).toBe("long");
    h.setCaretOffset(30);
    expect(h.click()).toBeNull();
  });

  it("prefers actual painted ranges and does not invent hits when the native result is empty", () => {
    const h = harness();
    h.register([note("long", 0, 20), note("short", 1, 4)]);
    h.flush();
    h.setPainted([...h.highlights.get(THREAD_NOTE_HIGHLIGHT)!]);
    expect(h.click()).toBe("short");
    expect(h.caretCalls()).toBe(0);
    h.setPainted([]);
    expect(h.click()).toBeNull();
    expect(h.caretCalls()).toBe(0);
  });

  it("ignores links, controls, and selection drags without consuming the click", () => {
    const h = harness();
    h.register([note("a")]);
    h.flush();
    const link = h.root.append(new TestNode());
    link.control = true;
    expect(h.click(link)).toBeNull();
    h.setSelection(false);
    expect(h.click()).toBeNull();
    expect(h.caretCalls()).toBe(0);
  });
});
