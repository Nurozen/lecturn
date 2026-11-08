import "../../index.css";

import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProjectsHeading } from "./SidebarProjectsHeading";

// The heading's width inside the framed hierarchy of the default 256 px sidebar.
const HEADING_WIDTH = 206;

it("keeps both shelf toggles on one line at the default sidebar width", async () => {
  const container = document.createElement("div");
  container.className = "dark";
  container.style.width = `${HEADING_WIDTH}px`;
  const toggle = { expanded: false, onToggle: () => {} };
  await using _screen = await render(
    <ul>
      <SidebarProjectsHeading working={{ ...toggle, count: 1 }} snoozed={{ ...toggle, count: 2 }} />
    </ul>,
    { container, router: false },
  );
  const working = page.getByRole("button", { name: /Working/ });
  const snoozed = page.getByRole("button", { name: /Snoozed/ });
  await expect.element(snoozed).toBeVisible();
  const heading = working.element().closest("li")!.getBoundingClientRect();
  for (const [button, label, count] of [
    [working, "Working", "(1)"],
    [snoozed, "Snoozed", "(2)"],
  ] as const) {
    const labelBox = button.getByText(label).element();
    expect(labelBox.scrollWidth).toBeLessThanOrEqual(labelBox.clientWidth);
    expect(button.element().getBoundingClientRect().height).toBe(labelBox.clientHeight);
    const countBox = button.getByText(count).element().getBoundingClientRect();
    expect(countBox.right).toBeLessThanOrEqual(heading.right);
  }
});

it("keeps the Projects label beside a single shelf toggle", async () => {
  const container = document.createElement("div");
  container.style.width = `${HEADING_WIDTH}px`;
  const toggle = { expanded: false, onToggle: () => {} };
  await using _screen = await render(
    <ul>
      <SidebarProjectsHeading working={{ ...toggle, count: 0 }} snoozed={{ ...toggle, count: 2 }} />
    </ul>,
    { container, router: false },
  );
  const label = page.getByText("Projects").element();
  await expect.element(page.getByRole("button", { name: /Snoozed/ })).toBeVisible();
  expect(label.getBoundingClientRect().width).toBeGreaterThan(1);
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
});
