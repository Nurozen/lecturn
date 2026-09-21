import type { MobileConnectAccount } from "../cloud/knownAccounts";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";

export interface AccountSectionContext {
  readonly accounts: ReadonlyArray<MobileConnectAccount>;
  readonly owners: ReadonlyMap<string, string>;
}
export function accountForEnvironment(
  context: AccountSectionContext,
  environmentId: string,
): string | null {
  const owner = context.owners.get(environmentId);
  return owner && context.accounts.some((account) => account.accountId === owner) ? owner : null;
}
export function accountAttention(
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      "hasPendingApprovals" | "hasPendingUserInput" | "hasActionableProposedPlan"
    >
  >,
): string {
  const approvals = threads.filter((thread) => thread.hasPendingApprovals).length;
  const inputs = threads.filter((thread) => thread.hasPendingUserInput).length;
  const plans = threads.filter((thread) => thread.hasActionableProposedPlan).length;
  return [
    plans ? `${plans} plans ready` : "",
    approvals ? `${approvals} awaiting approval` : "",
    inputs ? `${inputs} awaiting input` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
