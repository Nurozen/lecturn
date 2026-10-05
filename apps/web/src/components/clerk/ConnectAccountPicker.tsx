import { useProfileStableAccountId } from "../../cloud/useProfileStableAccountId";
import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState, type ReactNode } from "react";

import {
  accountPickerScope,
  accountPickerVisible,
  buildAccountPickerRows,
  openThreadEnvironmentIdAtom,
  readAccountPickerLastUsed,
  rememberAccountPickerChoice,
  resolvePickedAccount,
  selectionInScope,
  type AccountPickerRow,
  type AccountPickerSelection,
  type AccountPickerSurface,
} from "../../cloud/accountPicker";
import {
  accountByEnvironmentIdAtom,
  connectAccountProfilesAtom,
} from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom, type KnownConnectAccounts } from "../../cloud/knownAccounts";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The compact "which account?" select. Every surface that asks uses this one. */
export function ConnectAccountPicker(props: {
  readonly label: string;
  /** For a surface that already shows the label next to the picker. */
  readonly labelHidden?: boolean;
  readonly rows: ReadonlyArray<AccountPickerRow>;
  readonly accountId: string | null;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onSelect: (accountId: string) => void;
}) {
  const current = props.rows.find((row) => row.accountId === props.accountId);
  return (
    <label className={cn("flex min-w-0 items-center gap-2 text-sm", props.className)}>
      <span className={props.labelHidden ? "sr-only" : "shrink-0 text-muted-foreground"}>
        {props.label}
      </span>
      <Select
        modal={false}
        value={props.accountId}
        disabled={props.disabled ?? false}
        onValueChange={(value: string | null) => {
          const row = props.rows.find((candidate) => candidate.accountId === value);
          if (row && row.disabledReason === null) props.onSelect(row.accountId);
        }}
      >
        <SelectTrigger size="sm" className="w-auto min-w-0 max-w-72" aria-label={props.label}>
          <SelectValue>
            <span className="truncate">{current?.name ?? "Choose an account"}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.rows.map((row) =>
            row.disabledReason === null ? (
              <SelectItem hideIndicator key={row.accountId} value={row.accountId}>
                <span className="truncate">{row.name}</span>
              </SelectItem>
            ) : (
              <Tooltip key={row.accountId}>
                <TooltipTrigger
                  render={
                    // Stays focusable and hoverable so the reason can be read.
                    <SelectItem
                      hideIndicator
                      value={row.accountId}
                      aria-disabled="true"
                      className="cursor-not-allowed opacity-64"
                    />
                  }
                >
                  <span className="truncate">{row.name}</span>
                  <span className="sr-only">{row.disabledReason}</span>
                </TooltipTrigger>
                <TooltipPopup side="left" className="max-w-64">
                  {row.disabledReason}
                </TooltipPopup>
              </Tooltip>
            ),
          )}
        </SelectPopup>
      </Select>
    </label>
  );
}

export interface ConnectAccountPickerOptions {
  readonly label?: string;
  readonly labelHidden?: boolean;
  /** An account this surface was opened for. It outranks the open thread's owner. */
  readonly preferredAccountId?: string | null;
  /** False while the surface is closed but stays mounted, so its choice does not outlive it. */
  readonly open?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

export interface PickedConnectAccount {
  /** undefined follows Clerk's active account, as every surface did before accounts could be chosen. */
  readonly accountId: string | null | undefined;
  readonly email: string | null;
  readonly visible: boolean;
  readonly select: (accountId: string) => void;
  readonly picker: ReactNode;
}

const FOLLOWS_ACTIVE_ACCOUNT: PickedConnectAccount = {
  accountId: undefined,
  email: null,
  visible: false,
  select: () => undefined,
  picker: null,
};

/** What a picker reads. null while there is no choice to make, and then it reads nothing else. */
const accountPickerContextAtom = Atom.make((get) => {
  const known = get(knownConnectAccountsAtom);
  if (
    !accountPickerVisible({
      knownAccountIds: known.accountIds,
    })
  ) {
    return null;
  }
  const openEnvironmentId = get(openThreadEnvironmentIdAtom);
  return {
    known,
    profiles: get(connectAccountProfilesAtom),
    threadOwnerAccountId:
      openEnvironmentId === null
        ? null
        : (get(accountByEnvironmentIdAtom).get(openEnvironmentId) ?? null),
  };
}).pipe(Atom.withLabel("connect:account-picker-context"));

function useChosenConnectAccount(
  surface: AccountPickerSurface,
  options: ConnectAccountPickerOptions = {},
): PickedConnectAccount {
  const { userId: clerkUserId } = useAuth();
  const userId = useProfileStableAccountId(clerkUserId);
  const context = useAtomValue(accountPickerContextAtom);
  const scope = accountPickerScope(options);
  const [selection, setSelection] = useState<AccountPickerSelection | null>(null);
  if (selection !== null && selection.scope !== scope) {
    setSelection(null);
  }
  const visible = context !== null;
  const lastUsedAccountId = useMemo(
    () => (visible && scope !== null ? readAccountPickerLastUsed()[surface] : undefined),
    [scope, surface, visible],
  );
  if (context === null) {
    return FOLLOWS_ACTIVE_ACCOUNT;
  }
  const { known, profiles } = context;
  const accountId = resolvePickedAccount({
    knownAccountIds: known.accountIds,
    needsSignIn: known.needsSignIn,
    activeAccountId: userId ?? null,
    selectedAccountId: selectionInScope(selection, scope),
    preferredAccountId: options.preferredAccountId,
    threadOwnerAccountId: context.threadOwnerAccountId,
    lastUsedAccountId,
  });
  const select = (next: string) => {
    if (scope !== null) setSelection({ accountId: next, scope });
    rememberAccountPickerChoice(surface, next);
  };
  return {
    accountId,
    email: accountId ? (profiles.get(accountId)?.email ?? null) : null,
    visible,
    select,
    picker: (
      <ConnectAccountPicker
        label={options.label ?? "Account"}
        rows={buildAccountPickerRows({
          knownAccountIds: known.accountIds,
          needsSignIn: known.needsSignIn,
          profiles,
        })}
        accountId={accountId}
        onSelect={select}
        {...(options.labelHidden === undefined ? {} : { labelHidden: options.labelHidden })}
        {...(options.disabled === undefined ? {} : { disabled: options.disabled })}
        {...(options.className === undefined ? {} : { className: options.className })}
      />
    ),
  };
}

/** The account a surface acts as. With fewer than two accounts it follows the active account. */
export const useConnectAccountPicker = useChosenConnectAccount;

export const useKnownAccountsToChooseFrom = (): KnownConnectAccounts =>
  useAtomValue(knownConnectAccountsAtom);
