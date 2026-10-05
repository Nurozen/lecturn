import { useListedThreadShells } from "../../state/entities";
import { accountAttention } from "./accountSections";
import { useAtomValue } from "@effect/atom-react";
import { relayAccountByEnvironmentId } from "@lecturn/client-runtime/relay";
import { useMemo } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { useConnectAccounts } from "../cloud/knownAccounts";
import type { AccountSectionContext } from "./accountSections";
export function useAccountSections(): AccountSectionContext | undefined {
  const accounts = useConnectAccounts();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return useMemo(
    () =>
      accounts.length > 1
        ? {
            accounts,
            owners: relayAccountByEnvironmentId(
              [...catalog.entries.values()].map((entry) => entry.target),
            ),
          }
        : undefined,
    [accounts, catalog],
  );
}

export function useAccountAttention(context: AccountSectionContext | undefined) {
  const threads = useListedThreadShells();
  return useMemo(
    () =>
      new Map(
        context?.accounts.map((account) => [
          account.accountId,
          accountAttention(
            threads.filter(
              (thread) =>
                !thread.archivedAt &&
                context.owners.get(thread.environmentId) === account.accountId,
            ),
          ),
        ]) ?? [],
      ),
    [context, threads],
  );
}
