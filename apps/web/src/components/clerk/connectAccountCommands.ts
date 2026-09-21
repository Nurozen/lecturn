import { Atom } from "effect/unstable/reactivity";
import type { ReactNode } from "react";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { segmentListDomId } from "../sidebar/sidebarSegments.logic";

/** What the command palette needs from the mounted Connect host to run account actions. */
export interface ConnectAccountCommands {
  /** Why "Add account" is closed, or null when it is open. */
  readonly addAccountBlockedReason: string | null;
  readonly addAccount: () => void;
  readonly signOut: (accountId: string) => void;
  readonly signOutAll: () => void;
}

/**
 * null until `ConnectAccountCommandsHost` has mounted: the palette also renders
 * without Clerk, the host never does. Kept apart from the host so reading it
 * does not pull Clerk into a client without Lecturn Connect.
 */
export const connectAccountCommandsAtom = Atom.make<ConnectAccountCommands | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("connect:account-commands"),
);

/**
 * Lecturn Connect account actions. Empty unless several accounts can be
 * served, so a single-account build keeps exactly the actions it had.
 * `commands` is null until the Connect host that runs them has mounted.
 */
export function buildConnectAccountActionItems(input: {
  readonly multiAccountEnabled: boolean;
  readonly accounts: ReadonlyArray<{ readonly accountId: string; readonly name: string }>;
  readonly commands: ConnectAccountCommands | null;
  readonly goToAccount: (accountId: string) => void;
  readonly icons: {
    readonly add: ReactNode;
    readonly goTo: ReactNode;
    readonly signOut: ReactNode;
  };
}): CommandPaletteActionItem[] {
  const { commands } = input;
  if (!input.multiAccountEnabled || commands === null) {
    return [];
  }
  const several = input.accounts.length >= 2;
  const shared = ["lecturn connect", "account"];
  const blocked = commands.addAccountBlockedReason;
  return [
    {
      kind: "action",
      value: "action:connect-account:add",
      searchTerms: ["Add Lecturn Connect account", ...shared, "sign in", "login"],
      title: "Add Lecturn Connect account",
      ...(blocked === null ? {} : { description: blocked, disabled: true }),
      icon: input.icons.add,
      run: async () => commands.addAccount(),
    },
    ...(several ? input.accounts : []).map((account): CommandPaletteActionItem => ({
      kind: "action",
      value: `action:connect-account:go-to:${account.accountId}`,
      searchTerms: [`Go to account ${account.name}`, ...shared, "segment", "sidebar"],
      title: `Go to account ${account.name}`,
      icon: input.icons.goTo,
      run: async () => input.goToAccount(account.accountId),
    })),
    ...input.accounts.map((account): CommandPaletteActionItem => ({
      kind: "action",
      value: `action:connect-account:sign-out:${account.accountId}`,
      searchTerms: [`Sign out of ${account.name}`, ...shared, "log out", "logout"],
      title: `Sign out of ${account.name}`,
      icon: input.icons.signOut,
      run: async () => commands.signOut(account.accountId),
    })),
    ...(several
      ? [
          {
            kind: "action" as const,
            value: "action:connect-account:sign-out-all",
            searchTerms: ["Sign out of all accounts", ...shared, "log out", "logout", "every"],
            title: "Sign out of all accounts",
            icon: input.icons.signOut,
            run: async () => commands.signOutAll(),
          },
        ]
      : []),
  ];
}

/** Opens an account's sidebar segment when it is collapsed. */
export function expandSegment(
  collapsedSegmentIds: ReadonlyArray<string>,
  accountId: string,
): ReadonlyArray<string> {
  return collapsedSegmentIds.includes(accountId)
    ? collapsedSegmentIds.filter((id) => id !== accountId)
    : collapsedSegmentIds;
}

/** Scrolls the sidebar to an account's segment, once it has been expanded and rendered. */
export function scrollToAccountSegment(accountId: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      document.getElementById(segmentListDomId(accountId))?.scrollIntoView({ block: "start" }),
    ),
  );
}
