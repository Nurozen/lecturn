import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { mobileAccountSurfaceColor } from "../../lib/accountTint";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectAccounts } from "../cloud/knownAccounts";

import { accountRowColors, type AccountRow } from "./accountRowColors";

export function useAccountRowColors(items: ReadonlyArray<AccountRow>) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accounts = useConnectAccounts();
  return useMemo(() => {
    const targets = new Map(
      [...catalog.entries.values()].map((entry) => [
        String(entry.target.environmentId),
        entry.target,
      ]),
    );
    return accountRowColors(
      items,
      (id) => {
        const target = targets.get(id);
        if (target?._tag !== "RelayConnectionTarget") return undefined;
        return mobileAccountSurfaceColor(target.accountId, accounts);
      },
      accounts.length > 1,
    );
  }, [items, catalog, accounts]);
}
