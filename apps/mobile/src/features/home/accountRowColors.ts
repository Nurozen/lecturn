import { accountTintColor } from "@lecturn/shared/accountTint";

export interface AccountRow {
  readonly key: string;
  readonly type: string;
  readonly account?: { readonly preset: string } | null;
  readonly thread?: { readonly environmentId: string };
  readonly item?: { readonly thread: { readonly environmentId: string } };
  readonly pendingTask?: { readonly message: { readonly environmentId: string } };
  readonly group?: { readonly projects: ReadonlyArray<{ readonly environmentId: string }> };
}

/** Ownership follows each actual environment; aggregate groups never borrow an arbitrary owner. */
export function accountRowColors(
  items: ReadonlyArray<AccountRow>,
  colorForEnvironment: (id: string) => string | undefined,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let inherited: string | undefined;
  for (const item of items) {
    if (item.type === "account-header") {
      inherited = item.account ? accountTintColor(item.account.preset) : undefined;
    } else if (item.group) {
      const colors = new Set(
        item.group.projects.map((project) => colorForEnvironment(project.environmentId)),
      );
      inherited = colors.size === 1 ? [...colors][0] : undefined;
    }
    const environment =
      item.thread?.environmentId ??
      item.item?.thread.environmentId ??
      item.pendingTask?.message.environmentId;
    const color = environment ? colorForEnvironment(environment) : inherited;
    if (color) result.set(item.key, color);
  }
  return result;
}
