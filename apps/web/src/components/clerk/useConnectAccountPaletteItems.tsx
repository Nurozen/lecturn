import { useAtomValue } from "@effect/atom-react";
import { LogOutIcon, PanelLeftIcon, UserPlusIcon } from "lucide-react";

import { connectAccountProfilesAtom } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  NO_SEGMENTS_COLLAPSED,
  SEGMENT_COLLAPSED_KEY,
  SegmentCollapsedSchema,
} from "../sidebar/sidebarSegments.logic";
import {
  buildConnectAccountActionItems,
  connectAccountCommandsAtom,
  expandSegment,
  scrollToAccountSegment,
} from "./connectAccountCommands";
import { UNKNOWN_ACCOUNT_NAME } from "./ConnectAccountMenu.logic";

/** The command palette's Lecturn Connect account actions. */
export function useConnectAccountPaletteItems(): CommandPaletteActionItem[] {
  const known = useAtomValue(knownConnectAccountsAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const commands = useAtomValue(connectAccountCommandsAtom);
  const [, setCollapsedSegmentIds] = useLocalStorage(
    SEGMENT_COLLAPSED_KEY,
    NO_SEGMENTS_COLLAPSED,
    SegmentCollapsedSchema,
  );
  return buildConnectAccountActionItems({
    accounts: known.accountIds.map((accountId) => ({
      accountId,
      name: profiles.get(accountId)?.email ?? UNKNOWN_ACCOUNT_NAME,
    })),
    commands,
    goToAccount: (accountId) => {
      setCollapsedSegmentIds((collapsed) => expandSegment(collapsed, accountId));
      scrollToAccountSegment(accountId);
    },
    icons: {
      add: <UserPlusIcon className={ITEM_ICON_CLASS} />,
      goTo: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      signOut: <LogOutIcon className={ITEM_ICON_CLASS} />,
    },
  });
}
