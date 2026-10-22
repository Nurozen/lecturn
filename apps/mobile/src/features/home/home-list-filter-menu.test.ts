import { EnvironmentId } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildEnvironmentFilterActions, buildHomeListFilterMenu } from "./home-list-filter-menu";

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      onEnvironmentChange: vi.fn(),
      onProjectChange,
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    for (const index of [0, 2]) {
      const item = projectMenu.items[index];
      if (item?.type !== "action") throw new Error("Expected project action");
      item.onPress();
    }
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });
});

it("groups matching environment names under their owning account and keeps attention visible", () => {
  const accounts = ["user_a", "user_b"].map((accountId) => ({
    accountId,
    email: `${accountId}@example.test`,
    label: accountId,
    preset: "jade",
    signedIn: true,
  }));
  const onEnvironmentChange = vi.fn();
  const menu = buildHomeListFilterMenu({
    environments: [
      { environmentId: EnvironmentId.make("a"), label: "Laptop" },
      { environmentId: EnvironmentId.make("b"), label: "Laptop" },
    ],
    projects: [],
    selectedEnvironmentId: null,
    selectedProjectKey: null,
    onEnvironmentChange,
    onProjectChange: vi.fn(),
    accountSections: {
      accounts,
      owners: new Map([
        ["a", "user_a"],
        ["b", "user_b"],
      ]),
    },
    accountAttention: new Map([["user_a", "1 awaiting approval"]]),
  });
  const environments = menu.items[0];
  if (environments?.type !== "submenu") throw new Error("Expected environments");
  const a = environments.items[1],
    b = environments.items[2];
  expect(a?.title).toContain("1 awaiting approval");
  if (b?.type !== "submenu" || b.items[0]?.type !== "action")
    throw new Error("Expected owned environment action");
  b.items[0].onPress();
  expect(onEnvironmentChange).toHaveBeenCalledWith("b");
});

describe("buildEnvironmentFilterActions", () => {
  const environments = [
    { environmentId: EnvironmentId.make("a"), label: "Laptop" },
    { environmentId: EnvironmentId.make("b"), label: "Laptop" },
    { environmentId: EnvironmentId.make("c"), label: "Desk" },
  ];

  it("lists environments flat without account sections, like upstream", () => {
    expect(
      buildEnvironmentFilterActions({
        environments,
        selectedEnvironmentId: EnvironmentId.make("b"),
      }),
    ).toEqual([
      { id: "all", title: "All environments", state: "off" },
      { id: '"a"', title: "Laptop", state: "off" },
      { id: '"b"', title: "Laptop", state: "on" },
      { id: '"c"', title: "Desk", state: "off" },
    ]);
  });

  it("groups environments per account with sign-in and attention labels", () => {
    const accounts = ["user_a", "user_b"].map((accountId) => ({
      accountId,
      email: `${accountId}@example.test`,
      label: accountId,
      preset: "jade",
      signedIn: accountId === "user_a",
    }));
    expect(
      buildEnvironmentFilterActions({
        environments,
        selectedEnvironmentId: null,
        accountSections: {
          accounts,
          owners: new Map([
            ["a", "user_a"],
            ["b", "user_b"],
          ]),
        },
        accountAttention: new Map([["user_a", "1 awaiting approval"]]),
      }),
    ).toEqual([
      { id: "all", title: "All environments", state: "on" },
      {
        id: "account:user_a",
        title: "user_a · 1 awaiting approval",
        subactions: [{ id: '"a"', title: "Laptop", state: "off" }],
      },
      {
        id: "account:user_b",
        title: "user_b · Sign in again",
        subactions: [{ id: '"b"', title: "Laptop", state: "off" }],
      },
      {
        id: "account:direct",
        title: "Direct connections",
        subactions: [{ id: '"c"', title: "Desk", state: "off" }],
      },
    ]);
  });
});
