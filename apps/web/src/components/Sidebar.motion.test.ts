import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createSidebarListMotion } from "./Sidebar.motion";

class TestAnimation {
  progress: number | null = 0;
  playState: AnimationPlayState = "running";
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  cancel = vi.fn(() => {
    this.playState = "idle";
  });
  private onFinish: (() => void) | undefined;
  addEventListener(_type: string, listener: () => void) {
    this.onFinish = listener;
  }
  finish() {
    this.playState = "finished";
    this.onFinish?.();
  }
}

class TestRow {
  offsetTop = 0;
  offsetLeft = 4;
  offsetWidth = 260;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  dragTranslate = 0;
  style: Record<string, string> = {};
  inert = false;
  attributes: { name: string; value: string }[] = [];
  children: TestRow[] = [];
  clones: TestRow[] = [];
  remove = vi.fn();
  animations: TestAnimation[] = [];
  constructor(
    readonly name: string,
    public offsetHeight = 82,
  ) {}
  getBoundingClientRect() {
    return { top: this.offsetTop + this.dragTranslate, height: this.offsetHeight };
  }
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
  }
  hasAttribute(name: string) {
    return this.attributes.some((attribute) => attribute.name === name);
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  querySelectorAll(_selector: string): TestRow[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
  cloneNode(_deep: boolean): TestRow {
    const clone = new TestRow(`${this.name} clone`, this.offsetHeight);
    clone.namespaceURI = this.namespaceURI;
    clone.style = { ...this.style };
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.children = this.children.map((child) => child.cloneNode(true));
    this.clones.push(clone);
    return clone;
  }
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  });
}

function fixture(rows: TestRow[]) {
  const media = { matches: false };
  const parent = {
    children: rows,
    ownerDocument: { defaultView: { matchMedia: () => media } },
    getBoundingClientRect: () => ({ top: 0 }),
    append(node: TestRow) {
      parent.children.push(node);
      node.remove.mockImplementation(() => {
        parent.children = parent.children.filter((child) => child !== node);
      });
    },
  };
  function layout(next: TestRow[]) {
    let top = 8;
    for (const row of next) {
      row.offsetTop = top;
      top += row.offsetHeight + 1;
    }
    parent.children = [
      ...next,
      ...parent.children.filter((row) => row.style.position === "absolute"),
    ];
  }
  layout(rows);
  const motion = createSidebarListMotion(parent as unknown as HTMLUListElement);
  return { motion, layout, media, parent };
}

function expectMove(row: TestRow, offset: number) {
  expect(row.animate).toHaveBeenLastCalledWith(
    [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
    { duration: 150, easing: "ease-out" },
  );
}

beforeEach(() => vi.stubGlobal("HTMLElement", TestRow));
afterEach(() => vi.unstubAllGlobals());

describe("sidebar list motion", () => {
  it("glides released rows without animating independently folded shelf wrappers", () => {
    const row = new TestRow("row");
    const fold = new TestRow("fold");
    fold.setAttribute("data-sidebar-motion-skip", "");
    const { motion } = fixture([row, fold]);
    motion.update(false);
    row.dragTranslate = 24;
    fold.dragTranslate = 24;
    motion.release();
    row.dragTranslate = fold.dragTranslate = 0;
    motion.update(true);
    expectMove(row, 24);
    expect(fold.animate).not.toHaveBeenCalled();
    expect(fold.clones).toHaveLength(0);
    motion.dispose();
  });

  it("keeps separate list controllers alive and leaves folded wrappers to their own motion", () => {
    const a = new TestRow("account-a");
    const b = new TestRow("account-b");
    const fold = new TestRow("shelf-fold");
    fold.setAttribute("data-sidebar-motion-skip", "");
    const first = fixture([a, fold]);
    const second = fixture([b]);
    first.motion.update(false);
    second.motion.update(false);
    first.layout([fold]);
    first.motion.update(true);
    expect(a.clones).toHaveLength(1);
    expect(fold.animations).toHaveLength(0);
    second.layout([]);
    second.motion.update(true);
    expect(b.clones).toHaveLength(1);
    first.motion.dispose();
    expect(b.clones[0]!.animations[0]!.cancel).not.toHaveBeenCalled();
    second.motion.dispose();
    expect(b.clones[0]!.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(fold.clones).toHaveLength(0);
  });
});
