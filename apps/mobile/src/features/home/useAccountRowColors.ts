import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { relayRouteTarget } from "@lecturn/client-runtime/connection";
import { mobileAccountSurfaceColor } from "../../lib/accountTint";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectAccounts } from "../cloud/knownAccounts";

import { accountRowColors, type AccountRow } from "./accountRowColors";

export function useAccountRowColors(items: ReadonlyArray<AccountRow>) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accounts = useConnectAccounts();
  return useMemo(() => {
    const relayTargets = new Map(
      [...catalog.entries.values()].map((entry) => [
        String(entry.target.environmentId),
        relayRouteTarget(entry),
      ]),
    );
    return accountRowColors(
      items,
      (id) => {
        const target = relayTargets.get(id);
        if (target === undefined) return undefined;
        return mobileAccountSurfaceColor(target.accountId, accounts);
      },
      accounts.length > 1,
    );
  }, [items, catalog, accounts]);
}
