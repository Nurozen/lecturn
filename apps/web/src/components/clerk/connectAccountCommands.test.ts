import { describe, expect, it, vi } from "vite-plus/test";

import { buildRootGroups, filterCommandPaletteGroups } from "../CommandPalette.logic";
import { buildConnectAccountActionItems, expandSegment } from "./connectAccountCommands";

const commands = () => ({
  addAccountBlockedReason: null as string | null,
  addAccount: vi.fn(),
  signOut: vi.fn(),
  signOutAll: vi.fn(),
});
const accounts = [
  { accountId: "account-a", name: "a@example.com" },
  { accountId: "account-b", name: "b@example.com" },
];
const icons = { add: null, goTo: null, signOut: null };

describe("buildConnectAccountActionItems", () => {
  it("adds nothing to a single-account build, so the palette keeps exactly its actions", () => {
    const items = buildConnectAccountActionItems({
      multiAccountEnabled: false,
      accounts,
      commands: commands(),
      goToAccount: vi.fn(),
      icons,
    });
    expect(items).toEqual([]);
    const settings = {
      kind: "action" as const,
      value: "action:settings",
      searchTerms: ["settings"],
      title: "Open settings",
      icon: null,
      run: async () => {},
    };
    expect(buildRootGroups({ actionItems: [settings, ...items], recentThreadItems: [] })).toEqual(
      buildRootGroups({ actionItems: [settings], recentThreadItems: [] }),
    );
  });

  it("adds nothing until the Connect host is there to run the actions", () => {
    expect(
      buildConnectAccountActionItems({
        multiAccountEnabled: true,
        accounts,
        commands: null,
        goToAccount: vi.fn(),
        icons,
      }),
    ).toEqual([]);
  });

  it("offers add and sign-out for one account, without go-to or sign-out-of-all", () => {
    const items = buildConnectAccountActionItems({
      multiAccountEnabled: true,
      accounts: accounts.slice(0, 1),
      commands: commands(),
      goToAccount: vi.fn(),
      icons,
    });
    expect(items.map((item) => item.title)).toEqual([
      "Add Lecturn Connect account",
      "Sign out of a@example.com",
    ]);
  });

  it("offers go-to and sign-out per account, and sign-out of all, with two accounts", async () => {
    const run = commands();
    const goToAccount = vi.fn();
    const items = buildConnectAccountActionItems({
      multiAccountEnabled: true,
      accounts,
      commands: run,
      goToAccount,
      icons,
    });
    expect(items.map((item) => item.title)).toEqual([
      "Add Lecturn Connect account",
      "Go to account a@example.com",
      "Go to account b@example.com",
      "Sign out of a@example.com",
      "Sign out of b@example.com",
      "Sign out of all accounts",
    ]);
    expect(new Set(items.map((item) => item.value)).size).toBe(items.length);
    for (const item of items) await item.run();
    expect(run.addAccount).toHaveBeenCalledOnce();
    expect(goToAccount.mock.calls).toEqual([["account-a"], ["account-b"]]);
    expect(run.signOut.mock.calls).toEqual([["account-a"], ["account-b"]]);
    expect(run.signOutAll).toHaveBeenCalledOnce();
  });

  it("shows a closed add-account gate as a disabled action that says why", () => {
    const [add] = buildConnectAccountActionItems({
      multiAccountEnabled: true,
      accounts,
      commands: { ...commands(), addAccountBlockedReason: "Sign out of one to add another." },
      goToAccount: vi.fn(),
      icons,
    });
    expect(add).toMatchObject({
      disabled: true,
      description: "Sign out of one to add another.",
    });
  });

  it("is found by account email and by what it does", () => {
    const items = buildConnectAccountActionItems({
      multiAccountEnabled: true,
      accounts,
      commands: commands(),
      goToAccount: vi.fn(),
      icons,
    });
    const search = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: buildRootGroups({ actionItems: items, recentThreadItems: [] }),
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
      }).flatMap((group) => group.items.map((item) => item.title));
    expect(search("b@example")).toEqual([
      "Go to account b@example.com",
      "Sign out of b@example.com",
    ]);
    expect(search("sign out of all")).toContain("Sign out of all accounts");
  });
});

describe("expandSegment", () => {
  it("opens a collapsed segment and leaves the rest as they were", () => {
    const collapsed = ["account-a", "account-b"];
    expect(expandSegment(collapsed, "account-a")).toEqual(["account-b"]);
    expect(expandSegment(collapsed, "account-c")).toBe(collapsed);
  });
});
