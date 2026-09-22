import { accountTintColor } from "@lecturn/shared/accountTint";

/** Only decoration is account-owned. Reading, action and status palettes remain theme-owned. */
export function mobileAccountSurfaceColor(
  accountId: string | undefined,
  accounts: ReadonlyArray<{ readonly accountId: string; readonly preset: string }>,
): string | undefined {
  if (!accountId) return undefined;
  const owner = accounts.find((account) => account.accountId === accountId);
  return owner ? accountTintColor(owner.preset) : undefined;
}
