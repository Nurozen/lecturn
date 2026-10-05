import { accountTintColor } from "@lecturn/shared/accountTint";

/** Multiple accounts tint decoration; a single account keeps the original theme. */
export function mobileAccountSurfaceColor(
  accountId: string | undefined,
  accounts: ReadonlyArray<{ readonly accountId: string; readonly preset: string }>,
): string | undefined {
  if (!accountId || accounts.length < 2) return undefined;
  const owner = accounts.find((account) => account.accountId === accountId);
  return owner ? accountTintColor(owner.preset) : undefined;
}
