import { afterEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { withAndroidAccess } from "./androidAccessCommand";
import { requireAndroidFullAccess } from "../lib/androidHostAccess";

vi.mock("../lib/androidHostAccess", () => ({ requireAndroidFullAccess: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("does not dispatch Full settings, creation or turns while native review is pending or canceled", async () => {
  const registry = AtomRegistry.make();
  try {
    for (const label of ["create", "import", "set-runtime-mode", "start-turn"]) {
      let cancel!: (error: Error) => void;
      vi.mocked(requireAndroidFullAccess).mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            cancel = reject;
          }),
      );
      const run = vi.fn(async () => AsyncResult.success("sent"));
      const command = withAndroidAccess({ label, run });
      const value = { input: { threadId: "thread", runtimeMode: "full-access" as const } };
      const pending = command.run(registry, value);
      expect(run).not.toHaveBeenCalled();
      cancel(new Error("User canceled native confirmation"));
      expect((await pending)._tag).toBe("Failure");
      expect(run).not.toHaveBeenCalled();
    }
  } finally {
    registry.dispose();
  }
});
it("preserves the original command input and receipt after authorization", async () => {
  const registry = AtomRegistry.make();
  try {
    const receipt = AsyncResult.success("receipt");
    const run = vi.fn(async () => receipt);
    const value = { input: { threadId: "thread" } };
    expect(await withAndroidAccess({ label: "create", run }).run(registry, value)).toBe(receipt);
    expect(requireAndroidFullAccess).toHaveBeenCalledWith("thread", undefined);
    expect(run).toHaveBeenCalledExactlyOnceWith(registry, value);
  } finally {
    registry.dispose();
  }
});

it("checks the inherited fork mode while leaving its wire input unchanged", async () => {
  const registry = AtomRegistry.make();
  try {
    const run = vi.fn(async () => AsyncResult.success("forked"));
    const value = { input: { threadId: "child", sourceThreadId: "parent" } };
    const command = withAndroidAccess({ label: "fork", run }, () => "approval-required");
    await command.run(registry, value);
    expect(requireAndroidFullAccess).toHaveBeenCalledWith("child", "approval-required");
    expect(run).toHaveBeenCalledExactlyOnceWith(registry, value);
    expect(value.input).not.toHaveProperty("runtimeMode");
  } finally {
    registry.dispose();
  }
});
