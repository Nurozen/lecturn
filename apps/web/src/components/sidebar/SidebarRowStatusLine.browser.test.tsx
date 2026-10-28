import "../../index.css";

import { AlarmClockIcon, CheckIcon, PinIcon } from "lucide-react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SidebarRowStatusLine } from "./SidebarRowStatusLine";

// A nested card row in the default 256 px sidebar: the title shares the line
// with the markers and the status slot.
const ROW_WIDTH = 180;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  container.className = "dark";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Row = "plain" | "pinned" | "woke";

const actions = (
  <>
    <button
      type="button"
      aria-label="Snooze thread"
      className="inline-flex items-center rounded-md px-1.5 text-xs"
    >
      <AlarmClockIcon className="size-3.5" />
    </button>
    <button
      type="button"
      aria-label="Settle thread"
      className="-mr-1 inline-flex items-center gap-1 rounded-md px-1.5 text-xs"
    >
      <CheckIcon className="size-3.5" />
      Settle
    </button>
  </>
);

function line(row: Row, withActions: boolean, actionsOpen = false): ReactNode {
  return (
    <SidebarRowStatusLine
      markers={
        row === "pinned" ? (
          <PinIcon aria-label="Pinned" role="img" className="size-3 shrink-0" />
        ) : null
      }
      anchored={row !== "plain"}
      status={
        row === "woke" ? (
          <button type="button" className="inline-flex items-center gap-1 font-medium">
            <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
            <span role="status">Woke</span>
          </button>
        ) : (
          <span>8m</span>
        )
      }
      statusPersistent={row === "woke"}
      actions={withActions ? actions : null}
      actionsOpen={actionsOpen}
      slotHidden={false}
    >
      <span data-testid="title" className="min-w-0 flex-1 truncate text-sm font-medium">
        Make remote control work from the phone
      </span>
    </SidebarRowStatusLine>
  );
}

async function render(content: ReactNode) {
  await page.viewport(1440, 900);
  await act(async () =>
    root.render(
      // Clear of the page's corner, where the test pointer rests, so nothing is hovered.
      <div style={{ width: ROW_WIDTH, margin: 200 }}>
        <div data-testid="row" className="group/sidebar-row relative overflow-hidden px-2 py-1">
          {content}
        </div>
      </div>,
    ),
  );
  const row = container.querySelector<HTMLElement>('[data-testid="row"]')!;
  const find = (testId: string) => row.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    row,
    title: find("title")!,
    slot: find("sidebar-row-status-slot")!,
    status: find("sidebar-row-status")!,
    actions: find("sidebar-row-actions"),
    pin: row.querySelector<HTMLElement>('[aria-label="Pinned"]'),
  };
}

const box = (element: Element) => {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
};

async function hover(row: HTMLElement, actionsElement: HTMLElement) {
  await userEvent.hover(row);
  await vi.waitFor(() => {
    expect(row.matches(":hover")).toBe(true);
    expect(getComputedStyle(actionsElement).opacity).toBe("1");
  });
}

describe("SidebarRowStatusLine", () => {
  it.each(["plain", "pinned", "woke"] as const)(
    "gives a %s row's title the same width at rest with or without hover actions",
    async (row) => {
      const bare = await render(line(row, false));
      expect(bare.row.matches(":hover")).toBe(false);
      const bareTitleWidth = bare.title.getBoundingClientRect().width;
      const bareSlotWidth = bare.slot.getBoundingClientRect().width;

      const full = await render(line(row, true));
      expect(full.row.matches(":hover")).toBe(false);
      expect(full.actions).not.toBeNull();
      expect(getComputedStyle(full.actions!).opacity).toBe("0");
      expect(getComputedStyle(full.actions!).position).toBe("absolute");
      expect(full.title.getBoundingClientRect().width).toBeCloseTo(bareTitleWidth, 1);
      // The slot holds only the status (min-w-8 = 32 px), never the actions' width.
      expect(full.slot.getBoundingClientRect().width).toBeCloseTo(bareSlotWidth, 1);
      expect(full.slot.getBoundingClientRect().width).toBeCloseTo(
        Math.max(32, full.status.getBoundingClientRect().width),
        1,
      );
      expect(full.actions!.getBoundingClientRect().width).toBeGreaterThan(bareSlotWidth);
    },
  );

  it("keeps a pinned row's pin and status in place, uncovered, when the row is hovered", async () => {
    const view = await render(line("pinned", true));
    const pinAtRest = box(view.pin!);
    const statusAtRest = box(view.status);
    const titleAtRest = view.title.getBoundingClientRect().width;

    await hover(view.row, view.actions!);

    expect(box(view.pin!)).toEqual(pinAtRest);
    expect(box(view.status)).toEqual(statusAtRest);
    expect(getComputedStyle(view.status).opacity).toBe("1");
    // The actions open left of the pin, taking their room from the title.
    expect(view.actions!.getBoundingClientRect().right).toBeLessThanOrEqual(pinAtRest.left);
    expect(view.title.getBoundingClientRect().right).toBeLessThanOrEqual(
      view.actions!.getBoundingClientRect().left,
    );
    expect(view.title.getBoundingClientRect().width).toBeLessThan(titleAtRest);
    const settle = view.row.querySelector('[aria-label="Settle thread"]')!;
    const settleBox = settle.getBoundingClientRect();
    expect(
      settle.contains(
        document.elementFromPoint(
          settleBox.left + settleBox.width / 2,
          settleBox.top + settleBox.height / 2,
        ),
      ),
    ).toBe(true);

    await userEvent.unhover(view.row);
    await vi.waitFor(() => expect(getComputedStyle(view.actions!).position).toBe("absolute"));
    expect(view.title.getBoundingClientRect().width).toBeCloseTo(titleAtRest, 1);
  });

  it("keeps the Woke label in place and visible when the row is hovered", async () => {
    const view = await render(line("woke", true));
    const statusAtRest = box(view.status);

    await hover(view.row, view.actions!);

    expect(box(view.status)).toEqual(statusAtRest);
    expect(getComputedStyle(view.status).opacity).toBe("1");
    expect(view.actions!.getBoundingClientRect().right).toBeLessThanOrEqual(statusAtRest.left);
    await userEvent.unhover(view.row);
  });

  it("shows a plain row's actions in the status's place on hover", async () => {
    const view = await render(line("plain", true));
    const slotAtRest = box(view.slot);

    await hover(view.row, view.actions!);

    await vi.waitFor(() => expect(getComputedStyle(view.status).opacity).toBe("0"));
    expect(view.actions!.getBoundingClientRect().right).toBeCloseTo(slotAtRest.right, 1);
    await userEvent.unhover(view.row);
  });

  it("reveals a pinned row's actions for keyboard focus without moving the pin", async () => {
    const view = await render(line("pinned", true));
    const pinAtRest = box(view.pin!);

    await userEvent.keyboard("{Tab}");

    expect(document.activeElement?.getAttribute("aria-label")).toBe("Snooze thread");
    await vi.waitFor(() => expect(getComputedStyle(view.actions!).opacity).toBe("1"));
    expect(getComputedStyle(view.actions!).position).toBe("static");
    expect(box(view.pin!)).toEqual(pinAtRest);
    expect(view.actions!.getBoundingClientRect().right).toBeLessThanOrEqual(pinAtRest.left);
  });

  it("keeps the actions shown and the pin in place while the snooze menu is open", async () => {
    const atRest = await render(line("pinned", true));
    const pinAtRest = box(atRest.pin!);

    const open = await render(line("pinned", true, true));
    expect(open.row.matches(":hover")).toBe(false);
    expect(getComputedStyle(open.actions!).position).toBe("static");
    expect(box(open.pin!)).toEqual(pinAtRest);
    expect(open.actions!.getBoundingClientRect().right).toBeLessThanOrEqual(pinAtRest.left);
  });
});
