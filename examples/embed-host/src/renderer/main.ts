import { reportPaneRect, sendBridge } from "@lecturn/embed/renderer";

import type { EmbedHostUi } from "../preload.ts";

interface Item {
  readonly id: string;
  readonly name: string;
}

const ITEMS: ReadonlyArray<Item> = [
  { id: "counter-a", name: "Counter A" },
  { id: "counter-b", name: "Counter B" },
  { id: "launch-checklist", name: "Launch checklist" },
];

const ui = (window as unknown as { readonly embedHostUi: EmbedHostUi }).embedHostUi;
const list = document.getElementById("items")!;
const statusLine = document.getElementById("status")!;
const paneTitle = document.getElementById("pane-title")!;
const paneOpen = document.getElementById("pane-open") as HTMLButtonElement;
const paneMenuButton = document.getElementById("pane-menu-button")!;

// lecturn:begin
reportPaneRect(document.getElementById("pane")!);
const mention = (item: Item) =>
  sendBridge({
    method: "lecturn/composer.insertMention",
    params: { ref: `ex:item/${item.id}`, label: item.name },
  });
// lecturn:end

for (const item of ITEMS) {
  const row = document.createElement("li");
  row.dataset["ref"] = `ex:item/${item.id}`;
  const name = document.createElement("span");
  name.textContent = item.name;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Mention";
  button.title = `Insert ${item.name} into the Lecturn composer`;
  button.addEventListener("click", () => mention(item));
  row.append(name, button);
  list.append(row);
}

ui.onStatus((text) => {
  statusLine.textContent = text;
});
// Lecturn asks the host to show an `ex:` reference the agent linked to.
ui.onFocus((ref) => {
  for (const row of list.querySelectorAll("li")) {
    row.toggleAttribute("data-focused", row.dataset["ref"] === ref);
  }
  list.querySelector("li[data-focused]")?.scrollIntoView({ block: "nearest" });
});

ui.onPaneHeader((state) => {
  paneTitle.textContent = state.title;
  paneTitle.title = state.title;
  paneOpen.disabled = !state.canOpenInLecturn;
});
paneOpen.addEventListener("click", () => ui.openInLecturn());
paneMenuButton.addEventListener("click", () => {
  const rect = paneMenuButton.getBoundingClientRect();
  ui.openPaneMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom) });
});
