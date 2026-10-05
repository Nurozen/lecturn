import type { ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
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
  const target = catalog.entries.get(environmentId)?.target;
  const id = target?._tag === "RelayConnectionTarget" ? target.accountId : undefined;
  return (
    <AccountSurfaceKeyContext.Provider value={accounts.length > 1 ? id : undefined}>
      <AccountSurfaceColorContext.Provider value={mobileAccountSurfaceColor(id, accounts)}>
        {children}
      </AccountSurfaceColorContext.Provider>
    </AccountSurfaceKeyContext.Provider>
  );
}
