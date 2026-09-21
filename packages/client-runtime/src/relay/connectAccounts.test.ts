import { describe, expect, it } from "vite-plus/test";

import {
  MAX_CONNECT_ACCOUNTS,
  accountScopedKey,
  bucketByAccount,
  decideAddAccountGate,
  parseAccountScopedKey,
  relayAccountByEnvironmentId,
  type AccountOwnedTarget,
} from "./connectAccounts.ts";

const relay = (environmentId: string, accountId?: string): AccountOwnedTarget => ({
  _tag: "RelayConnectionTarget",
  environmentId,
  ...(accountId === undefined ? {} : { accountId }),
});
const direct: AccountOwnedTarget = { _tag: "BearerConnectionTarget", environmentId: "direct" };
const ssh: AccountOwnedTarget = { _tag: "SshConnectionTarget", environmentId: "ssh" };
const primary: AccountOwnedTarget = { _tag: "PrimaryConnectionTarget", environmentId: "primary" };

const decide = (input: Partial<Parameters<typeof decideAddAccountGate>[0]>) =>
  decideAddAccountGate({
    multiAccountEnabled: true,
    clerkSingleSessionMode: false,
    targets: [relay("env-a", "account-a"), direct, ssh, primary],
    unlistedRelayEnvironmentIds: new Set(),
    knownAccountCount: 1,
    ...input,
  });

const blocked = (reason: string) => ({ available: false, reason });

describe("decideAddAccountGate", () => {
  it("is available with the constant on, multi-session on, owned relay entries, and room", () => {
    expect(decide({})).toEqual({ available: true });
    expect(decide({ targets: [], knownAccountCount: 0 })).toEqual({ available: true });
  });

  it("is off while the build serves a single account, whatever else holds", () => {
    expect(decide({ multiAccountEnabled: false })).toEqual(blocked("disabled"));
    expect(
      decide({
        multiAccountEnabled: false,
        clerkSingleSessionMode: true,
        targets: [relay("env-untagged")],
        knownAccountCount: MAX_CONNECT_ACCOUNTS,
      }),
    ).toEqual(blocked("disabled"));
  });

  it("needs Clerk to report multi-session, and treats unknown as single-session", () => {
    expect(decide({ clerkSingleSessionMode: true })).toEqual(blocked("single-session"));
    expect(decide({ clerkSingleSessionMode: undefined })).toEqual(blocked("single-session"));
  });

  it("blocks on an untagged relay entry", () => {
    expect(decide({ targets: [relay("env-a", "account-a"), relay("env-untagged")] })).toEqual(
      blocked("unowned-environments"),
    );
  });

  it("ignores untagged entries the registry holds as unlisted", () => {
    expect(
      decide({
        targets: [relay("env-untagged")],
        unlistedRelayEnvironmentIds: new Set(["env-untagged"]),
      }),
    ).toEqual({ available: true });
    // An unlisted id that is no longer an entry changes nothing.
    expect(
      decide({
        targets: [relay("env-untagged"), relay("env-other")],
        unlistedRelayEnvironmentIds: new Set(["env-untagged", "env-gone"]),
      }),
    ).toEqual(blocked("unowned-environments"));
  });

  it("never counts direct, SSH, or primary environments as unowned", () => {
    expect(decide({ targets: [direct, ssh, primary] })).toEqual({ available: true });
  });

  it("stops at the account limit", () => {
    expect(decide({ knownAccountCount: MAX_CONNECT_ACCOUNTS - 1 })).toEqual({ available: true });
    expect(decide({ knownAccountCount: MAX_CONNECT_ACCOUNTS })).toEqual(blocked("account-limit"));
  });
});

describe("relayAccountByEnvironmentId", () => {
  it("maps tagged relay environments to their account and nothing else", () => {
    expect([
      ...relayAccountByEnvironmentId([
        relay("env-a", "account-a"),
        relay("env-b", "account-b"),
        relay("env-untagged"),
        { ...direct, accountId: "account-a" },
        ssh,
        primary,
      ]),
    ]).toEqual([
      ["env-a", "account-a"],
      ["env-b", "account-b"],
    ]);
  });
});

describe("bucketByAccount", () => {
  const owners: Record<string, string | undefined> = {
    "env-a1": "account-a",
    "env-b1": "account-b",
    "env-a2": "account-a",
    "env-gone": "account-gone",
  };
  const bucket = (ids: ReadonlyArray<string>) =>
    bucketByAccount(ids, (id) => owners[id], ["account-b", "account-a"]);

  it("follows account order, keeps item order, and puts unowned items last", () => {
    expect(bucket(["direct", "env-a1", "env-b1", "env-a2", "env-gone"])).toEqual([
      { accountId: "account-b", items: ["env-b1"] },
      { accountId: "account-a", items: ["env-a1", "env-a2"] },
      { accountId: null, items: ["direct", "env-gone"] },
    ]);
  });

  it("leaves out empty buckets", () => {
    expect(bucket(["env-a1"])).toEqual([{ accountId: "account-a", items: ["env-a1"] }]);
    expect(bucket([])).toEqual([]);
  });
});

describe("accountScopedKey", () => {
  it("scopes a key to its account and gives the plain key back", () => {
    const scoped = accountScopedKey("github.com/nurozen/lecturn", "user_a");
    expect(scoped).not.toBe(accountScopedKey("github.com/nurozen/lecturn", "user_b"));
    expect(parseAccountScopedKey(scoped).key).toBe("github.com/nurozen/lecturn");
  });

  it("leaves a key that no account owns as it is", () => {
    expect(accountScopedKey("env:/work/lecturn", null)).toBe("env:/work/lecturn");
    expect(parseAccountScopedKey("env:/work/lecturn")).toEqual({
      key: "env:/work/lecturn",
      accountId: null,
    });
  });

  it("reads the account back out of a scoped key", () => {
    expect(parseAccountScopedKey(accountScopedKey("env:/work/lecturn", "user_2abC9"))).toEqual({
      key: "env:/work/lecturn",
      accountId: "user_2abC9",
    });
  });

  it("leaves a key that only contains the marker whole", () => {
    for (const key of ["env:/work/@account:team/lecturn", "env:/work/lecturn@account:"]) {
      expect(parseAccountScopedKey(key)).toEqual({ key, accountId: null });
    }
  });

  it("leaves a saga split key whole, physical part included", () => {
    const split = `${accountScopedKey("github.com/nurozen/lecturn", "user_a")}::env:/work/lecturn`;
    expect(parseAccountScopedKey(split)).toEqual({ key: split, accountId: null });
  });
});
