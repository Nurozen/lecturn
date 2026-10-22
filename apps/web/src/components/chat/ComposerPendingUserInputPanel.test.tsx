import { EnvironmentId, RuntimeRequestId, ThreadId } from "@lecturn/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

import type { PendingUserInput } from "../../session-logic";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

let renderer: ReactTestRenderer;
const onDismiss = vi.fn();

function panel(responding = false, pendingUserInputs: PendingUserInput[] = [prompt]) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={pendingUserInputs}
      cwd="/repo"
      threadRef={threadRef}
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
  return renderer.root.find(
    (node) => node.type === "span" && node.props["data-pending-user-input-dismiss"],
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", new EventTarget());
  onDismiss.mockClear();
  await act(async () => {
    renderer = create(panel());
  });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("ComposerPendingUserInputPanel", () => {
  it("offers dismiss only for async questions", async () => {
    expect(dismissControl()).toBeDefined();
    await act(async () => {
      renderer.update(panel(false, [{ ...prompt, dismissible: false }]));
    });
    expect(
      renderer.root.findAll((node) => node.props["data-pending-user-input-dismiss"]),
    ).toHaveLength(0);
  });

  it("removes the panel when no question is pending", async () => {
    await act(async () => renderer.update(panel(false, [])));
    expect(renderer.toJSON()).toBeNull();
  });

  it.each(["click", "Enter", " "])(
    "blocks %j dismissal while responding and restores it after the response settles",
    async (activation) => {
      const activate = async () => {
        const event = {
          key: activation,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        };
        await act(async () => {
          const control = dismissControl();
          if (activation === "click") control.props.onClick(event);
          else control.props.onKeyDown(event);
        });
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
      };

      await activate();
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
      onDismiss.mockClear();

      await act(async () => renderer.update(panel(true)));
      expect(dismissControl().props["aria-disabled"]).toBe(true);
      expect(dismissControl().props.tabIndex).toBe(-1);
      await activate();
      await activate();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(
        renderer.root.find(
          (node) => node.type === "button" && node.props["data-pending-user-input-toggle"],
        ).props["aria-expanded"],
      ).toBe(true);

      await act(async () => renderer.update(panel()));
      expect(dismissControl().props["aria-disabled"]).toBe(false);
      expect(dismissControl().props.tabIndex).toBe(0);
      await activate();
      expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
    },
  );
});
