import { EnvironmentId, GuestMessageId, ThreadId } from "@lecturn/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { requireAndroidFullAccess } from "../lib/androidHostAccess";
import { threadEnvironment } from "./threads";

const resolveGuestMessageRun = vi.hoisted(() => vi.fn());

vi.mock("../lib/androidHostAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/androidHostAccess")>()),
  requireAndroidFullAccess: vi.fn(),
}));
vi.mock("@lecturn/client-runtime/state/threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lecturn/client-runtime/state/threads")>();
  return {
    ...actual,
    createThreadEnvironmentAtoms: (
      ...args: Parameters<typeof actual.createThreadEnvironmentAtoms>
    ) => {
      const commands = actual.createThreadEnvironmentAtoms(...args);
      return {
        ...commands,
        resolveGuestMessage: { ...commands.resolveGuestMessage, run: resolveGuestMessageRun },
      };
    },
  };
});
afterEach(() => vi.resetAllMocks());

const guestMessage = (decision: "send" | "dismiss") => ({
  environmentId: EnvironmentId.make("environment"),
  input: {
    threadId: ThreadId.make("thread"),
    guestMessageId: GuestMessageId.make("guest-message"),
    decision,
  },
});

it("does not send a guest message as a turn while native review is pending or canceled", async () => {
  const registry = AtomRegistry.make();
  try {
    let cancel!: (error: Error) => void;
    vi.mocked(requireAndroidFullAccess).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          cancel = reject;
        }),
    );
    const pending = threadEnvironment.resolveGuestMessage.run(registry, guestMessage("send"));
    await vi.waitFor(() => expect(requireAndroidFullAccess).toHaveBeenCalled());
    // An unknown shell falls back to the default mode, which is reviewed.
    expect(requireAndroidFullAccess).toHaveBeenCalledWith("thread", undefined);
    expect(resolveGuestMessageRun).not.toHaveBeenCalled();
    cancel(new Error("User canceled native confirmation"));
    expect((await pending)._tag).toBe("Failure");
    expect(resolveGuestMessageRun).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});

it("dismisses a guest message without a native review", async () => {
  const registry = AtomRegistry.make();
  try {
    const receipt = AsyncResult.success("dismissed");
    resolveGuestMessageRun.mockResolvedValueOnce(receipt);
    const value = guestMessage("dismiss");
    expect(await threadEnvironment.resolveGuestMessage.run(registry, value)).toBe(receipt);
    expect(requireAndroidFullAccess).not.toHaveBeenCalled();
    expect(resolveGuestMessageRun).toHaveBeenCalledExactlyOnceWith(registry, value);
  } finally {
    registry.dispose();
  }
});
