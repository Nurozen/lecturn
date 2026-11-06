import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useAndroidChatBridge } from "./useAndroidChatBridge";
import type { AndroidHost } from "../lib/androidHostAccess";

// The real window: the hook listens on it, and the host bridge lives on it.
const target = window as unknown as Window & {
  symbaHost?: AndroidHost;
  __lecturnComposeRequested?: boolean;
};
const focusComposer = vi.fn();
const publishChatWidget = vi.fn().mockResolvedValue({ published: true });
function Chat({ scope, ready = true }: { scope: string; ready?: boolean }) {
  const composerExpanded = useAndroidChatBridge({
    scope,
    thread: ready
      ? { id: scope, title: "Chat", messages: [{ role: "assistant", text: scope }] }
      : null,
    focusComposer,
  });
  return <output>{composerExpanded ? "expanded" : "collapsed"}</output>;
}
// Fake timers, the host bridge and frame stubs live for one test; disposing restores them.
function setup(): Disposable {
  vi.useFakeTimers();
  vi.clearAllMocks();
  publishChatWidget.mockReset().mockResolvedValue({ published: true });
  Object.assign(target, {
    symbaHost: {
      protocolVersion: 2,
      publishChatWidget,
      getAccessState: vi.fn(),
      requestFullAccess: vi.fn(),
      openDeviceAccess: vi.fn(),
    },
  });
  delete target.__lecturnComposeRequested;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  return {
    [Symbol.dispose]() {
      delete target.symbaHost;
      delete target.__lecturnComposeRequested;
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}
it("clears the old environment/thread before publishing the newly selected conversation and clears on unmount", async () => {
  using _env = setup();
  await using screen = await render(<Chat scope="a/thread" />, { router: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(publishChatWidget).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "a/thread" }),
  );
  await screen.rerender(<Chat scope="b/thread" />);
  expect(publishChatWidget).toHaveBeenLastCalledWith(null);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(publishChatWidget).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "b/thread" }),
  );
  await screen.unmount();
  expect(publishChatWidget).toHaveBeenLastCalledWith(null);
});
it("consumes an early compose request and later events by focusing only", async () => {
  using _env = setup();
  target.__lecturnComposeRequested = true;
  await using screen = await render(<Chat scope="a/thread" />, { router: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  expect(focusComposer).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).toBe("expanded");
  expect(target.__lecturnComposeRequested).toBe(false);
  await act(async () => {
    target.dispatchEvent(new Event("lecturn:compose"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  expect(focusComposer).toHaveBeenCalledTimes(2);
  await screen.unmount();
  await act(async () => {
    target.dispatchEvent(new Event("lecturn:compose"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  expect(focusComposer).toHaveBeenCalledTimes(2);
});
it("supports older hosts without a widget publisher", async () => {
  using _env = setup();
  delete target.symbaHost?.publishChatWidget;
  await using _screen = await render(<Chat scope="a/thread" />, { router: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(publishChatWidget).not.toHaveBeenCalled();
});

it("clears when sign-out removes the environment and waits for a ready composer before consuming Reply", async () => {
  using _env = setup();
  target.__lecturnComposeRequested = true;
  await using screen = await render(<Chat scope="a/thread" ready={false} />, { router: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
  expect(focusComposer).not.toHaveBeenCalled();
  expect(target.__lecturnComposeRequested).toBe(true);
  await screen.rerender(<Chat scope="a/thread" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(focusComposer).toHaveBeenCalledTimes(1);
  expect(publishChatWidget).toHaveBeenLastCalledWith(
    expect.objectContaining({ threadId: "a/thread" }),
  );
  await screen.rerender(<Chat scope="a/thread" ready={false} />);
  expect(publishChatWidget).toHaveBeenLastCalledWith(null);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(publishChatWidget).toHaveBeenLastCalledWith(null);
});

it("recovers exhausted native rejections on resume without a new chat render", async () => {
  using _env = setup();
  publishChatWidget.mockResolvedValue({ published: false });
  await using _screen = await render(<Chat scope="a/thread" />, { router: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(publishChatWidget.mock.calls.filter(([value]) => value !== null)).toHaveLength(3);
  let nativeSnapshot: Parameters<NonNullable<AndroidHost["publishChatWidget"]>>[0] = null;
  publishChatWidget.mockImplementation(async (snapshot) => {
    nativeSnapshot = snapshot;
    return { published: true };
  });
  await act(async () => {
    target.dispatchEvent(new Event("lecturn:chat-visible"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(nativeSnapshot).toEqual({
    threadId: "a/thread",
    title: "Chat",
    messages: [{ role: "assistant", text: "a/thread" }],
  });
  const count = publishChatWidget.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(publishChatWidget).toHaveBeenCalledTimes(count);
});

it.each([true, false])(
  "pagehide stays cleared across a late receipt and React update (revoked=%s)",
  async (revoked) => {
    using _env = setup();
    let nativeSnapshot: Parameters<NonNullable<AndroidHost["publishChatWidget"]>>[0] = null;
    let acknowledge: (value: { published: boolean }) => void = () => undefined;
    let pending = true;
    publishChatWidget.mockImplementation((snapshot) => {
      nativeSnapshot = snapshot;
      if (snapshot && pending) {
        pending = false;
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      }
      return Promise.resolve({ published: true });
    });
    await using screen = await render(<Chat scope="a/thread" />, { router: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(nativeSnapshot).not.toBeNull();
    await act(async () => {
      target.dispatchEvent(new Event("pagehide"));
    });
    expect(nativeSnapshot).toBeNull();
    await screen.rerender(<Chat scope="a/thread" ready={!revoked} />);
    await act(async () => {
      acknowledge({ published: true });
      target.dispatchEvent(new Event("lecturn:chat-visible"));
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(nativeSnapshot).toBeNull();
    await act(async () => {
      target.dispatchEvent(new Event("pageshow"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    if (revoked) expect(nativeSnapshot).toBeNull();
    else expect(nativeSnapshot).toEqual(expect.objectContaining({ threadId: "a/thread" }));
  },
);
