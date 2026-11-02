import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { observeVisibleAnimation } from "./visibleAnimation";

let focused = true;
let page = createPage();
let view = createView();
let motion = Object.assign(new EventTarget(), { matches: false });
let observers: TestIntersectionObserver[] = [];
let cleanups: Array<() => void> = [];

class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  report(target: Element, isIntersecting: boolean) {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function createPage() {
  return Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
}

function createView() {
  return Object.assign(new EventTarget(), { matchMedia: () => motion });
}

function animationElement() {
  const properties = new Map<string, string>();
  const element = {
    style: { setProperty: (name: string, value: string) => properties.set(name, value) },
  } as unknown as HTMLElement;
  return {
    element,
    state: () => properties.get("--visible-animation-state"),
    willChange: () => properties.get("--visible-animation-will-change"),
  };
}

function attach(element: HTMLElement, options?: Parameters<typeof observeVisibleAnimation>[1]) {
  const cleanup = observeVisibleAnimation(element, options);
  if (cleanup) cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  focused = true;
  page = createPage();
  motion = Object.assign(new EventTarget(), { matches: false });
  view = createView();
  observers = [];
  cleanups = [];
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", view);
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("observeVisibleAnimation", () => {
  it("runs only intersecting animations in a visible document with motion enabled", () => {
    const first = animationElement();
    const second = animationElement();
    attach(first.element);
    attach(second.element);
    expect(first.state()).toBe("paused");

    const observer = observers[0]!;
    observer.report(first.element, true);
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("paused");

    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    observer.report(second.element, true);
    expect(first.state()).toBe("paused");
    expect(first.willChange()).toBe("auto");
    expect(second.state()).toBe("paused");

    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(first.state()).toBe("running");
    expect(second.state()).toBe("running");

    observer.report(first.element, false);
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("paused");

    motion.matches = false;
    motion.dispatchEvent(new Event("change"));
    expect(first.state()).toBe("paused");
    expect(second.state()).toBe("running");
  });

  it.each(["hidden", "reduced motion"])("starts paused with %s already active", (condition) => {
    page.visibilityState = condition === "hidden" ? "hidden" : "visible";
    motion.matches = condition === "reduced motion";
    const animation = animationElement();
    attach(animation.element);
    observers[0]!.report(animation.element, true);
    expect(animation.state()).toBe("paused");

    page.visibilityState = "visible";
    motion.matches = false;
    page.dispatchEvent(new Event("visibilitychange"));
    expect(animation.state()).toBe("running");
  });

  it("shares observers, releases the final ref, and ignores late callbacks after remount", () => {
    const addVisibility = vi.spyOn(page, "addEventListener");
    const removeVisibility = vi.spyOn(page, "removeEventListener");
    const addMotion = vi.spyOn(motion, "addEventListener");
    const removeMotion = vi.spyOn(motion, "removeEventListener");
    const first = animationElement();
    const second = animationElement();
    const detachFirst = attach(first.element);
    const detachSecond = attach(second.element);
    expect(observers).toHaveLength(1);
    expect(addVisibility).toHaveBeenCalledTimes(1);
    expect(addMotion).toHaveBeenCalledTimes(1);

    const previousObserver = observers[0]!;
    detachFirst?.();
    previousObserver.report(first.element, true);
    expect(first.state()).toBe("paused");
    expect(previousObserver.unobserve).toHaveBeenCalledWith(first.element);
    expect(previousObserver.disconnect).not.toHaveBeenCalled();

    detachSecond?.();
    expect(previousObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(removeVisibility).toHaveBeenCalledTimes(1);
    expect(removeMotion).toHaveBeenCalledTimes(1);

    attach(second.element);
    expect(observers).toHaveLength(2);
    detachSecond?.();
    previousObserver.report(second.element, true);
    expect(second.state()).toBe("paused");
    observers[1]!.report(second.element, true);
    expect(second.state()).toBe("running");
  });

  it("pauses opted-in animations while the window is unfocused", () => {
    const focusBound = animationElement();
    const plain = animationElement();
    attach(focusBound.element, { pauseWhenUnfocused: true });
    attach(plain.element);
    observers[0]!.report(focusBound.element, true);
    observers[0]!.report(plain.element, true);
    expect(focusBound.state()).toBe("running");

    focused = false;
    view.dispatchEvent(new Event("blur"));
    expect(focusBound.state()).toBe("paused");
    expect(focusBound.willChange()).toBe("auto");
    expect(plain.state()).toBe("running");

    focused = true;
    view.dispatchEvent(new Event("focus"));
    expect(focusBound.state()).toBe("running");
  });

  it("starts paused when attached to an unfocused window", () => {
    focused = false;
    const animation = animationElement();
    attach(animation.element, { pauseWhenUnfocused: true });
    observers[0]!.report(animation.element, true);
    expect(animation.state()).toBe("paused");
  });

  it("re-checks focus after blur, since iframes blur the window while the document keeps focus", () => {
    vi.useFakeTimers();
    const animation = animationElement();
    attach(animation.element, { pauseWhenUnfocused: true });
    observers[0]!.report(animation.element, true);

    view.dispatchEvent(new Event("blur"));
    expect(animation.state()).toBe("running");
    vi.runAllTimers();
    expect(animation.state()).toBe("running");

    view.dispatchEvent(new Event("blur"));
    focused = false;
    vi.runAllTimers();
    expect(animation.state()).toBe("paused");
  });

  it("listens for focus only while an opted-in animation is attached", () => {
    const addFocus = vi.spyOn(view, "addEventListener");
    const removeFocus = vi.spyOn(view, "removeEventListener");
    const plain = attach(animationElement().element);
    expect(addFocus).not.toHaveBeenCalled();

    const first = attach(animationElement().element, { pauseWhenUnfocused: true });
    const second = attach(animationElement().element, { pauseWhenUnfocused: true });
    expect(addFocus.mock.calls.map(([type]) => type)).toEqual(["focus", "blur"]);

    first?.();
    expect(removeFocus).not.toHaveBeenCalled();
    second?.();
    expect(removeFocus.mock.calls.map(([type]) => type)).toEqual(["focus", "blur"]);
    plain?.();
  });

  it("keeps unknown visibility static when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const animation = animationElement();
    attach(animation.element);
    expect(animation.state()).toBe("paused");
    expect(animation.willChange()).toBe("auto");
    expect(observers).toHaveLength(0);
  });
});
