/**
 * The embed guest as a user drives it: type into the composer, answer an app
 * tool's approval, read the timeline's card rows. Selectors are the ones the
 * web client renders for every surface, not embed-only test hooks.
 */
import type { Locator, Page } from "playwright-core";

import { until } from "./harness.ts";

/** Set on the guest's window by `watchApprovalCards`. */
interface ApprovalWatch {
  __embedHostApprovalCards?: Set<string>;
}

export interface CounterCard {
  readonly state: string | null;
  readonly count: string | undefined;
}

export function embedPage(guest: Page) {
  // Approval cards name an app tool by its declared MCP title (FIXI), not its id.
  const approvalGroup = (toolTitle: string) =>
    guest.locator(`[data-app-tool-approval="true"][aria-label="Approve ${toolTitle}"]`);
  const cardRows = guest.locator('[data-timeline-row-kind="mcp-app"]');

  const readCard = async (row: Locator): Promise<CounterCard | undefined> => {
    const unable = row.getByText(/Unable to load/);
    if ((await unable.count()) > 0) {
      throw new Error(`A counter card failed: ${(await unable.first().textContent())?.trim()}`);
    }
    const card = row.frameLocator("iframe").locator(".card");
    if ((await card.count()) === 0) return undefined;
    const state = await card.getAttribute("data-state");
    if (state === "pending") return undefined;
    return { state, count: (await card.locator("#count").textContent())?.trim() };
  };

  return {
    /** Pastes like a user, so the message is exactly what a user would type. */
    async send(text: string) {
      const editor = guest.locator('[data-testid="composer-editor"]');
      await editor.waitFor({ state: "visible", timeout: 60_000 });
      await editor.evaluate((element, message) => {
        (element as HTMLElement).focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", message);
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      }, text);
      await guest.locator("button.lecturn-composer-send:enabled").click({ timeout: 15_000 });
    },

    async waitForReply(text: string, timeoutMs: number) {
      await guest.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs });
    },

    /**
     * The composer sends its own mode with the next message, so a mode set
     * elsewhere counts only once the composer shows it.
     */
    async waitForRuntimeMode(label: string) {
      await guest
        // Anchored: "Auto" is also the start of "Auto-accept edits".
        .locator('[aria-label="Runtime mode"]', { hasText: new RegExp(`^\\s*${label}\\s*$`) })
        .waitFor({ state: "visible", timeout: 30_000 });
    },

    async waitForApproval(toolTitle: string, timeoutMs: number) {
      await approvalGroup(toolTitle).waitFor({ state: "attached", timeout: timeoutMs });
    },

    /** Clicks Approve on the banner row that asks for `toolTitle`, then waits for it to go. */
    async approve(toolTitle: string, timeoutMs: number) {
      const group = approvalGroup(toolTitle);
      await group.waitFor({ state: "attached", timeout: timeoutMs });
      const row = guest.locator("[data-composer-banner-row]", { has: group });
      await row.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 15_000 });
      await group.waitFor({ state: "detached", timeout: 15_000 });
    },

    /**
     * Records the tool name of every app approval card that appears from now
     * on, however briefly, until the page reloads.
     */
    async watchApprovalCards() {
      await guest.evaluate(() => {
        const watch = window as ApprovalWatch;
        watch.__embedHostApprovalCards = new Set();
        const record = () => {
          for (const element of document.querySelectorAll("[data-app-tool-approval]")) {
            watch.__embedHostApprovalCards!.add(element.getAttribute("aria-label") ?? "");
          }
        };
        record();
        new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
      });
      return () =>
        guest.evaluate(() => [...((window as ApprovalWatch).__embedHostApprovalCards ?? [])]);
    },

    /** Resolves once `count` card rows have each received their tool result. */
    async loadedCards(count: number, timeoutMs: number) {
      return until(`${count} loaded counter cards`, timeoutMs, async () => {
        if ((await cardRows.count()) < count) return undefined;
        const cards: Array<CounterCard> = [];
        for (const row of await cardRows.all()) {
          const card = await readCard(row);
          if (card === undefined) return undefined;
          cards.push(card);
        }
        return cards;
      });
    },

    workRowTexts: () => guest.locator('[data-timeline-row-kind="work"]').allTextContents(),
  };
}
