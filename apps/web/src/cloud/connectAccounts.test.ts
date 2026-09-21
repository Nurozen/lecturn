import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));

import { relayAccountByEnvironmentId } from "@lecturn/client-runtime/relay";

import {
  accountEmailWhenSeveral,
  accountMarkLabels,
  buildAccountMarks,
  mergeAccountProfiles,
  readClerkSingleSessionMode,
  type ConnectAccountProfiles,
} from "./connectAccounts";

const profiles: ConnectAccountProfiles = new Map([
  ["account-a", { email: "ada@work.example" }],
  ["account-b", { email: "grace@home.example" }],
]);
const owners = new Map([
  ["env-a", "account-a"],
  ["env-b", "account-b"],
]);

describe("buildAccountMarks", () => {
  const marks = (input: Partial<Parameters<typeof buildAccountMarks>[0]>) =>
    buildAccountMarks({
      multiAccountEnabled: true,
      knownAccountIds: ["account-a", "account-b"],
      profiles,
      accountByEnvironmentId: owners,
      ...input,
    });

  it("marks relay environments by owner once two accounts are known", () => {
    expect([...marks({})]).toEqual([
      ["env-a", { label: "ada", email: "ada@work.example" }],
      ["env-b", { label: "grace", email: "grace@home.example" }],
    ]);
  });

  it("shows nothing with fewer than two known accounts", () => {
    expect(marks({ knownAccountIds: ["account-a"] }).size).toBe(0);
    expect(marks({ knownAccountIds: [] }).size).toBe(0);
  });

  it("shows nothing while the build serves a single account", () => {
    expect(marks({ multiAccountEnabled: false }).size).toBe(0);
  });

  it("leaves direct, SSH, primary, and untagged relay environments unmarked", () => {
    const result = marks({
      accountByEnvironmentId: relayAccountByEnvironmentId([
        { _tag: "RelayConnectionTarget", environmentId: "env-a", accountId: "account-a" },
        { _tag: "RelayConnectionTarget", environmentId: "env-untagged" },
        { _tag: "BearerConnectionTarget", environmentId: "env-direct" },
        { _tag: "SshConnectionTarget", environmentId: "env-ssh" },
        { _tag: "PrimaryConnectionTarget", environmentId: "env-primary" },
      ]),
    });
    expect([...result.keys()]).toEqual(["env-a"]);
  });

  it("leaves out an owner that is no longer known or has no email yet", () => {
    expect([...marks({ knownAccountIds: ["account-a", "account-c"] }).keys()]).toEqual(["env-a"]);
  });
});

describe("accountMarkLabels", () => {
  it("falls back to the domain, then the whole email, when local parts collide", () => {
    expect([
      ...accountMarkLabels(
        new Map([
          ["a", { email: "sam@work.example" }],
          ["b", { email: "Sam@home.example" }],
          ["c", { email: "lee@home.example" }],
          ["d", { email: "sam@home.example" }],
        ]),
      ),
    ]).toEqual([
      ["a", "work.example"],
      ["b", "Sam@home.example"],
      ["c", "lee"],
      ["d", "sam@home.example"],
    ]);
  });
});

describe("mergeAccountProfiles", () => {
  it("refreshes signed-in accounts, keeps known ones, and drops the rest", () => {
    const next = mergeAccountProfiles({
      current: profiles,
      knownAccountIds: ["account-b", "account-c"],
      users: [
        {
          id: "account-c",
          primaryEmailAddress: { emailAddress: "lin@work.example" },
          hasImage: true,
          imageUrl: "https://img.example/lin",
        },
        { id: "account-d", primaryEmailAddress: { emailAddress: "other@work.example" } },
      ],
    });
    expect([...next]).toEqual([
      ["account-b", { email: "grace@home.example" }],
      ["account-c", { email: "lin@work.example", imageUrl: "https://img.example/lin" }],
    ]);
  });

  it("ignores Clerk's generated placeholder image", () => {
    const next = mergeAccountProfiles({
      current: new Map(),
      knownAccountIds: ["account-a"],
      users: [
        {
          id: "account-a",
          primaryEmailAddress: { emailAddress: "ada@work.example" },
          hasImage: false,
          imageUrl: "https://img.example/placeholder",
        },
      ],
    });
    expect(next.get("account-a")).toEqual({ email: "ada@work.example" });
  });
});

describe("accountEmailWhenSeveral", () => {
  const email = (input: Partial<Parameters<typeof accountEmailWhenSeveral>[0]>) =>
    accountEmailWhenSeveral({
      multiAccountEnabled: true,
      knownAccountIds: ["account-a", "account-b"],
      profiles,
      accountId: "account-a",
      ...input,
    });

  it("names the account only when two or more are known", () => {
    expect(email({})).toBe("ada@work.example");
    expect(email({ knownAccountIds: ["account-a"] })).toBeNull();
    expect(email({ multiAccountEnabled: false })).toBeNull();
    expect(email({ accountId: null })).toBeNull();
    expect(email({ accountId: "account-c" })).toBeNull();
  });
});

describe("readClerkSingleSessionMode", () => {
  it("reads the loaded environment's setting", () => {
    const clerk = (singleSessionMode: unknown) => ({
      __internal_environment: { authConfig: { singleSessionMode } },
    });
    expect(readClerkSingleSessionMode(clerk(false))).toBe(false);
    expect(readClerkSingleSessionMode(clerk(true))).toBe(true);
  });

  it("reads anything else as unknown", () => {
    expect(readClerkSingleSessionMode(null)).toBeUndefined();
    expect(readClerkSingleSessionMode({})).toBeUndefined();
    expect(readClerkSingleSessionMode({ __internal_environment: null })).toBeUndefined();
    expect(
      readClerkSingleSessionMode({
        __internal_environment: { authConfig: { singleSessionMode: "false" } },
      }),
    ).toBeUndefined();
    expect(
      readClerkSingleSessionMode({
        get __internal_environment(): never {
          throw new Error("not loaded");
        },
      }),
    ).toBeUndefined();
  });
});
