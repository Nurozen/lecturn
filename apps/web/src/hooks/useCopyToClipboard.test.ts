import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("recovers a desktop app clipboard permission denial while restoring focus and selection", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Write permission denied"));
    const range = { saved: true };
    const selection = {
      rangeCount: 1,
      getRangeAt: () => ({ cloneRange: () => range }),
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    class Element {
      focus = vi.fn();
    }
    const active = new Element();
    const input = {
      value: "",
      readOnly: false,
      style: { cssText: "" },
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const copy = vi.fn(() => input.value === "Decision **source**");
    vi.stubGlobal("HTMLElement", Element);
    vi.stubGlobal("window", { desktopBridge: {} });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", {
      activeElement: active,
      getSelection: () => selection,
      createElement: () => input,
      body: { appendChild: vi.fn() },
      execCommand: copy,
    });
    await expect(writeTextToClipboard("Decision **source**", "decision")).resolves.toBe(true);
    expect(copy).toHaveBeenCalledExactlyOnceWith("copy");
    expect(input.remove).toHaveBeenCalledOnce();
    expect(active.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  it("does not report copied when both desktop clipboard paths reject", async () => {
    const cause = new Error("Write permission denied");
    const input = {
      value: "",
      readOnly: false,
      style: { cssText: "" },
      setAttribute: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("window", { desktopBridge: {} });
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(cause) } });
    vi.stubGlobal("document", {
      activeElement: null,
      getSelection: () => null,
      createElement: () => input,
      body: { appendChild: vi.fn() },
      execCommand: () => false,
    });
    await expect(writeTextToClipboard("Decision", "decision")).rejects.toBeInstanceOf(
      ClipboardWriteError,
    );
    expect(input.remove).toHaveBeenCalledOnce();
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
