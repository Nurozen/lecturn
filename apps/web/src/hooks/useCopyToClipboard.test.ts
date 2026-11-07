import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@lecturn/shared/composerContextClipboard";

import { ClipboardWriteError, writeTextToClipboard } from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
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
});
