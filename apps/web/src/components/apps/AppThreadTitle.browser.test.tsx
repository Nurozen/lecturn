import "../../index.css";

import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const MAC = EnvironmentId.make("mac");
const PROJECT = ProjectId.make("hopper-38mm");
const THREAD = scopeThreadRef(MAC, ThreadId.make("t-counter"));
let appBound = true;

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : { environmentId: MAC, projectId: PROJECT, title: "Counter baseline" }) as never,
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          appBinding: appBound
            ? { appId: AppId.make("com.example.rocket"), workspaceRoot: "/work/hopper-38mm" }
            : null,
        }) as never,
}));

import { AppThreadTitleBeside } from "./AppThreadTitle";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  appBound = true;
  container = document.createElement("div");
  container.className = "dark";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The user row as the timeline draws it: a right-aligned column holding the bubble.
const userRow = (
  <div className="pb-4">
    <div className="group flex flex-col items-end gap-1">
      <div
        data-testid="bubble"
        className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground"
      >
        <p className="text-sm">Read the counter and add one.</p>
      </div>
    </div>
  </div>
);

async function renderOpening(width: number) {
  await page.viewport(1440, 900);
  await act(async () =>
    root.render(
      <div className="chat-content-lane" style={{ width }}>
        <AppThreadTitleBeside threadRef={THREAD} shown>
          {userRow}
        </AppThreadTitleBeside>
      </div>,
    ),
  );
}

function rect(testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element).not.toBeNull();
  return element!.getBoundingClientRect();
}

describe("AppThreadTitleBeside", () => {
  it("sets an app thread's title level with its opening message", async () => {
    await renderOpening(736);

    const title = rect("app-thread-title");
    const bubble = rect("bubble");
    // One row: the title on the left, the bubble on the right, neither overlapping the other.
    expect(title.right).toBeLessThan(bubble.left);
    const lane = container.querySelector(".chat-content-lane")!.getBoundingClientRect();
    expect(title.left).toBeCloseTo(lane.left, 0);
    expect(bubble.right).toBeCloseTo(lane.right, 0);
    const titleCenter = title.top + title.height / 2;
    const bubbleCenter = bubble.top + bubble.height / 2;
    expect(Math.abs(titleCenter - bubbleCenter)).toBeLessThanOrEqual(4);
  });

  it("wraps a long title in its half rather than running under the message", async () => {
    await renderOpening(736);
    await act(async () =>
      root.render(
        <div className="chat-content-lane" style={{ width: 736 }}>
          <AppThreadTitleBeside threadRef={THREAD} shown>
            <div className="group flex flex-col items-end gap-1">
              <div data-testid="bubble" className="max-w-[80%] p-3">
                <p className="text-sm">
                  {"Simulate the baseline and check the design. ".repeat(4)}
                </p>
              </div>
            </div>
          </AppThreadTitleBeside>
        </div>,
      ),
    );

    expect(rect("app-thread-title").right).toBeLessThan(rect("bubble").left);
  });

  it("leaves a thread that is not an app's as it was", async () => {
    appBound = false;
    await renderOpening(736);

    expect(container.querySelector('[data-testid="app-thread-title"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-thread-opening"]')).toBeNull();
    expect(rect("bubble").width).toBeGreaterThan(0);
  });
});
