import type { ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { relayRouteTarget } from "@lecturn/client-runtime/connection";
import type { EnvironmentId } from "@lecturn/contracts";
import { environmentCatalog } from "../connection/catalog";
import { useConnectAccounts } from "../features/cloud/knownAccounts";
import { mobileAccountSurfaceColor } from "./accountTint";
import { AccountSurfaceColorContext, AccountSurfaceKeyContext } from "./accountTintContext";

export function AccountTintScope({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accounts = useConnectAccounts();
  const entry = catalog.entries.get(environmentId);
  const id = entry === undefined ? undefined : relayRouteTarget(entry)?.accountId;
  return (
    <AccountSurfaceKeyContext.Provider value={accounts.length > 1 ? id : undefined}>
      <AccountSurfaceColorContext.Provider value={mobileAccountSurfaceColor(id, accounts)}>
        {children}
      </AccountSurfaceColorContext.Provider>
    </AccountSurfaceKeyContext.Provider>
  );
}
