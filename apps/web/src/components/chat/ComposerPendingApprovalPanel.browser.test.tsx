import "../../index.css";

import { AppId, RuntimeRequestId } from "@lecturn/contracts";
import { ShieldIcon } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingApproval } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-1"),
  requestKind: "permission",
  createdAt: "2026-10-25T00:00:00.000Z",
  responseCapability: "live",
  options: [
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
    { decision: "cancel", label: "Cancel" },
  ],
  connectedAppTool: {
    appId: AppId.make("dev.example"),
    appName: "Example",
    toolName: "ex_window_flash",
    reason: "Flashes the Embed Host window",
    source: "app",
  },
};

// The banner as ChatComposer draws a pending approval.
async function render(width: number) {
  container.style.width = `${width}px`;
  await act(async () =>
    root.render(
      <ComposerBanner.Root variant="warning" density="spacious">
        <ComposerBanner.Row layout="approval">
          <ComposerBanner.Icon>
            <ShieldIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerPendingApprovalActions
              requestId={approval.requestId}
              canRespond
              isResponding={false}
              options={approval.options}
              onRespondToApproval={async () => undefined}
            />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>,
    ),
  );
}

function layout() {
  const title = container.querySelector<HTMLElement>('[data-testid="app-approval-title"]')!;
  const reason = container.querySelector<HTMLElement>('[data-testid="app-approval-reason"]')!;
  const actions = container.querySelector<HTMLElement>('[data-slot="composer-banner-actions"]')!;
  return {
    title,
    titleBox: title.getBoundingClientRect(),
    reasonBox: reason.getBoundingClientRect(),
    actionsBox: actions.getBoundingClientRect(),
  };
}

const actionsCenter = (box: DOMRect) => box.top + box.height / 2;

describe("ComposerPendingApprovalPanel for a connected app's tool", () => {
  it("keeps the actions beside the whole tool name while they fit", async () => {
    await render(560);
    const { title, titleBox, reasonBox, actionsBox } = layout();

    expect(title.textContent).toBe("Approve ex_window_flash");
    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    expect(actionsCenter(actionsBox)).toBeGreaterThan(titleBox.top);
    expect(actionsCenter(actionsBox)).toBeLessThan(titleBox.bottom);
    expect(actionsBox.left).toBeGreaterThanOrEqual(titleBox.right);
    expect(reasonBox.top).toBeGreaterThanOrEqual(titleBox.bottom);
  });

  it("wraps the actions to their own line instead of cutting the tool name short", async () => {
    await render(300);
    const { title, titleBox, reasonBox, actionsBox } = layout();

    expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
    expect(titleBox.height).toBeLessThan(20);
    expect(actionsBox.top).toBeGreaterThanOrEqual(titleBox.bottom);
    expect(reasonBox.top).toBeGreaterThanOrEqual(actionsBox.bottom);
  });
});
