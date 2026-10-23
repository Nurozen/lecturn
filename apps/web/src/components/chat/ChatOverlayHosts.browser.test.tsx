import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { BranchRestoreConfirmHost, openBranchRestoreConfirm } from "./ChatOverlayHosts";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const dialog = () => document.querySelector('[role="alertdialog"]');

describe("BranchRestoreConfirmHost", () => {
  it("shows only its thread's request, confirms it once, and drops it when the thread changes", async () => {
    const onConfirm = vi.fn();
    const host = (threadKey: string) => (
      <AppAtomRegistryProvider>
        <BranchRestoreConfirmHost
          threadKey={threadKey}
          threadBranch="feature/restore"
          canWriteSourceControl
          onConfirm={onConfirm}
        />
      </AppAtomRegistryProvider>
    );
    await act(() => root.render(host("env:a")));

    await act(() => openBranchRestoreConfirm("env:b"));
    expect(dialog()).toBeNull();

    await act(() => openBranchRestoreConfirm("env:a"));
    const confirm = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Switch branch",
    );
    await act(() => confirm?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await act(() => openBranchRestoreConfirm("env:a"));
    expect(dialog()).not.toBeNull();
    await act(() => root.render(host("env:b")));
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
