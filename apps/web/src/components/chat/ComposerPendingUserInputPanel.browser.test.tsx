import { EnvironmentId, RuntimeRequestId, ThreadId } from "@lecturn/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-dismiss"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: true,
  responseCapability: "live",
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "One module at a time" },
        { label: "Big bang", description: "Everything at once" },
      ],
      multiSelect: false,
    },
  ],
};

const onDismiss = vi.fn();
let root: Root;
let container: HTMLDivElement;

function panel(responding = false, pendingUserInputs: PendingUserInput[] = [prompt]) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={pendingUserInputs}
      cwd="/repo"
      threadRef={threadRef}
      disabled={false}
      respondingRequestIds={responding ? [prompt.requestId] : []}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={onDismiss}
    />
  );
}

function dismissControl() {
  return container.querySelector<HTMLElement>("[data-pending-user-input-dismiss]");
}

function toggleControl() {
  return container.querySelector<HTMLButtonElement>("button[data-pending-user-input-toggle]");
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onDismiss.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(panel()));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ComposerPendingUserInputPanel", () => {
  it("offers dismiss only for async questions", async () => {
    expect(dismissControl()).not.toBeNull();
    await act(async () => root.render(panel(false, [{ ...prompt, dismissible: false }])));
    expect(dismissControl()).toBeNull();
  });

  it("removes the panel when no question is pending", async () => {
    await act(async () => root.render(panel(false, [])));
    expect(container.childElementCount).toBe(0);
  });

  it.each(["click", "Enter", " "])(
    "blocks %j dismissal while responding and restores it after the response settles",
    async (activation) => {
      const activate = async () => {
        const event =
          activation === "click"
            ? new MouseEvent("click", { bubbles: true, cancelable: true })
            : new KeyboardEvent("keydown", { key: activation, bubbles: true, cancelable: true });
        const escaped = vi.fn();
        document.addEventListener(event.type, escaped);
        try {
          await act(async () => dismissControl()!.dispatchEvent(event));
        } finally {
          document.removeEventListener(event.type, escaped);
        }
        expect(event.defaultPrevented).toBe(true);
        expect(escaped).not.toHaveBeenCalled();
      };

      await activate();
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
      onDismiss.mockClear();

      await act(async () => root.render(panel(true)));
      expect(dismissControl()!.getAttribute("aria-disabled")).toBe("true");
      expect(dismissControl()!.tabIndex).toBe(-1);
      await activate();
      await activate();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(toggleControl()!.getAttribute("aria-expanded")).toBe("true");

      await act(async () => root.render(panel()));
      expect(dismissControl()!.getAttribute("aria-disabled")).toBe("false");
      expect(dismissControl()!.tabIndex).toBe(0);
      await activate();
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
    },
  );
});
