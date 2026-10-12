import { afterEach, expect, it, vi } from "vite-plus/test";
import { androidChatSnapshot, createAndroidChatPublisher } from "./androidChatWidget";
import type { AndroidHost } from "./androidHostAccess";

const snapshot = (text: string) => ({
  threadId: "thread",
  title: "Chat",
  messages: [{ role: "user" as const, text }],
});
function fixture() {
  const publishChatWidget = vi
    .fn<NonNullable<AndroidHost["publishChatWidget"]>>()
    .mockResolvedValue({ published: true });
  const host: AndroidHost = {
    protocolVersion: 2,
    publishChatWidget,
    getAccessState: vi.fn(),
    requestFullAccess: vi.fn(),
    openDeviceAccess: vi.fn(),
  };
  return { publishChatWidget, publisher: createAndroidChatPublisher(host) };
}
afterEach(() => vi.useRealTimers());
it("publishes only bounded recent conversation text, excluding tools, system and reasoning", () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: `${i}: ${"x".repeat(600)}`,
  }));
  const result = androidChatSnapshot({
    id: "thread",
    title: "a".repeat(150),
    messages: [
      ...messages,
      { role: "tool", text: "secret tool output" },
      { role: "reasoning", text: "private" },
      { role: "system", text: "system prompt" },
    ],
  });
  expect(result?.messages).toHaveLength(6);
  expect(result?.messages[0]?.text.startsWith("3:")).toBe(true);
  expect(
    result?.messages.every((message) => message.text.length === 500 && message.text.endsWith("…")),
  ).toBe(true);
  expect(result?.title).toHaveLength(100);
  expect(androidChatSnapshot({ id: "x".repeat(257), title: "", messages: [] })).toBeNull();
});
it("coalesces continuous tokens without waiting for streaming to stop and skips identical snapshots", async () => {
  vi.useFakeTimers();
  const { publisher, publishChatWidget } = fixture();
  for (let i = 0; i < 15; i++) {
    publisher.update(snapshot(String(i)));
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(publishChatWidget).toHaveBeenCalledTimes(1);
  expect(publishChatWidget).toHaveBeenLastCalledWith(snapshot("14"));
  publisher.update(snapshot("14"));
  await vi.advanceTimersByTimeAsync(1500);
  expect(publishChatWidget).toHaveBeenCalledTimes(1);
  publisher.close();
});
it("clears immediately on exit even with a publication in flight and never republishes afterward", async () => {
  vi.useFakeTimers();
  const { publisher, publishChatWidget } = fixture();
  let finish: (value: { published: boolean }) => void = () => undefined;
  publishChatWidget.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  publisher.update(snapshot("old"));
  await vi.advanceTimersByTimeAsync(1500);
  publisher.update(snapshot("late"));
  publisher.close();
  expect(publishChatWidget).toHaveBeenLastCalledWith(null);
  finish({ published: true });
  await vi.advanceTimersByTimeAsync(10000);
  expect(publishChatWidget).toHaveBeenCalledTimes(2);
});
it("bounds retries when native rejects publication", async () => {
  vi.useFakeTimers();
  const { publisher, publishChatWidget } = fixture();
  publishChatWidget.mockResolvedValue({ published: false });
  publisher.update(snapshot("hello"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(publishChatWidget).toHaveBeenCalledTimes(3);
  publisher.close();
});

it.each([true, false])(
  "republishes after clear and reconnect despite a stale receipt (accepted=%s)",
  async (accepted) => {
    vi.useFakeTimers();
    const { publisher, publishChatWidget } = fixture();
    let acknowledge: (value: { published: boolean }) => void = () => undefined;
    let nativeSnapshot: Parameters<NonNullable<AndroidHost["publishChatWidget"]>>[0] = null;
    publishChatWidget.mockImplementation(async (value) => {
      nativeSnapshot = value;
      return { published: true };
    });
    publishChatWidget.mockImplementationOnce((value) => {
      nativeSnapshot = value;
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    publisher.update(snapshot("same"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(nativeSnapshot).toEqual(snapshot("same"));
    publisher.update(null);
    publisher.update(snapshot("same"));
    expect(nativeSnapshot).toBeNull();
    acknowledge({ published: accepted });
    await vi.advanceTimersByTimeAsync(1500);
    expect(nativeSnapshot).toEqual(snapshot("same"));
    expect(publishChatWidget).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(publishChatWidget).toHaveBeenCalledTimes(3);
    publisher.close();
  },
);

it("keeps a disconnected widget clear when an old publication succeeds", async () => {
  vi.useFakeTimers();
  const { publisher, publishChatWidget } = fixture();
  let acknowledge: (value: { published: boolean }) => void = () => undefined;
  publishChatWidget.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  publisher.update(snapshot("old"));
  await vi.advanceTimersByTimeAsync(1500);
  publisher.update(null);
  acknowledge({ published: true });
  await vi.advanceTimersByTimeAsync(10000);
  expect(publishChatWidget.mock.calls.map(([value]) => value)).toEqual([snapshot("old"), null]);
  publisher.close();
});

it("honors a refresh requested while the previous publication receipt is pending", async () => {
  vi.useFakeTimers();
  const { publisher, publishChatWidget } = fixture();
  let acknowledge: (value: { published: boolean }) => void = () => undefined;
  publishChatWidget.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  publisher.update(snapshot("same"));
  await vi.advanceTimersByTimeAsync(1500);
  publisher.refresh();
  acknowledge({ published: true });
  await vi.advanceTimersByTimeAsync(1500);
  expect(publishChatWidget.mock.calls.map(([value]) => value)).toEqual([
    snapshot("same"),
    snapshot("same"),
  ]);
  publisher.close();
});
