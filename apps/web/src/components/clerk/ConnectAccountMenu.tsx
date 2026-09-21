import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, LogInIcon, LogOutIcon, PlusIcon, UserCogIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { connectAccountProfilesAtom } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { withActiveAccount } from "../../cloud/withActiveAccount";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildConnectAccountMenu, type ConnectAccountMenuRow } from "./ConnectAccountMenu.logic";
import { CONNECT_PROFILE_PAGES } from "./connectProfilePages";
import { useConnectSignOut } from "./useConnectSignOut";
import { useConnectSignIn } from "./useConnectSignIn";

/** Settings search lands here: the hash opens the menu and the id takes focus. */
export const CONNECT_ACCOUNT_MENU_TARGET_ID = "connect-accounts";

function AccountAvatar({
  row,
  className,
}: {
  readonly row: ConnectAccountMenuRow;
  readonly className?: string;
}) {
  return row.imageUrl ? (
    <img
      src={row.imageUrl}
      alt=""
      className={cn("size-6 shrink-0 rounded-full object-cover", className)}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[0.625rem] text-muted-foreground",
        className,
      )}
    >
      {row.initials}
    </span>
  );
}

/**
 * Clerk's profile takes custom pages as mount callbacks. Each mounted element
 * is kept here and filled through a portal, which is what `UserButton` does
 * for its `UserProfilePage` children.
 */
function useConnectProfilePages() {
  const [mounted, setMounted] = useState<ReadonlyMap<string, HTMLDivElement>>(new Map());
  const customPages = useMemo(() => {
    const slot = (key: string) => ({
      mount: (element: HTMLDivElement) =>
        setMounted((current) => new Map(current).set(key, element)),
      unmount: () =>
        setMounted((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
    });
    return CONNECT_PROFILE_PAGES.map(({ label, url }) => {
      const page = slot(`page:${url}`);
      const icon = slot(`icon:${url}`);
      return {
        label,
        url,
        mount: page.mount,
        unmount: page.unmount,
        mountIcon: icon.mount,
        unmountIcon: icon.unmount,
      };
    });
  }, []);
  const portals = CONNECT_PROFILE_PAGES.flatMap(({ url, Icon, render }) => {
    const page = mounted.get(`page:${url}`);
    const icon = mounted.get(`icon:${url}`);
    return [
      page ? createPortal(render(), page, `page:${url}`) : null,
      icon ? createPortal(<Icon className="size-4" />, icon, `icon:${url}`) : null,
    ];
  });
  return { customPages, portals };
}

/**
 * The Connect accounts signed in on this client, in place of Clerk's
 * `UserButton` popover. Only mounted while `connectMultiAccount` is on.
 */
export function ConnectAccountMenu() {
  const clerk = useClerk();
  const { isLoaded, userId } = useAuth();
  const known = useAtomValue(knownConnectAccountsAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const { requestSignOutAccount, requestSignOutAll, signOutDialog } = useConnectSignOut();
  const { customPages, portals } = useConnectProfilePages();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hash = useLocation({ select: (location) => location.hash });

  const targeted = hash.replace(/^#/, "") === CONNECT_ACCOUNT_MENU_TARGET_ID;
  const [seenHash, setSeenHash] = useState<string | null>(null);
  if (hash !== seenHash) {
    setSeenHash(hash);
    if (targeted) setOpen(true);
  }
  useEffect(() => {
    if (targeted) triggerRef.current?.focus();
  }, [targeted]);

  const { gate, authPrompt, addAccount, signInAgainAs } = useConnectSignIn();
  const model = buildConnectAccountMenu({
    knownAccountIds: known.accountIds,
    needsSignIn: known.needsSignIn,
    activeAccountId: userId ?? null,
    profiles,
    gate,
  });

  // Clerk's profile belongs to the active account, so the account is made active to open it.
  const asActive = (accountId: string, run: () => void) =>
    void withActiveAccount(accountId, run).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not switch accounts",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );

  if (!isLoaded || model.rows.length === 0) return null;

  const current = model.rows.find((row) => row.active) ?? model.rows[0]!;
  const attention = model.rows.some((row) => row.needsSignIn);

  return (
    <>
      {signOutDialog}
      {authPrompt}
      {portals}
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          ref={triggerRef}
          id={CONNECT_ACCOUNT_MENU_TARGET_ID}
          aria-label={
            attention ? "Lecturn Connect accounts, one needs sign-in" : "Lecturn Connect accounts"
          }
          className="relative rounded-lg p-1 outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-row-hover"
        >
          <AccountAvatar row={current} className="size-7 text-xs" />
          {attention ? (
            <span
              aria-hidden="true"
              className="absolute top-0.5 right-0.5 size-2 rounded-full bg-warning ring-2 ring-sidebar"
            />
          ) : null}
        </MenuTrigger>
        <MenuPopup align="end" side="top" className="w-72">
          <MenuGroup>
            <MenuGroupLabel>Lecturn Connect accounts</MenuGroupLabel>
            {model.rows.map((row) => (
              <MenuSub key={row.accountId}>
                <MenuSubTrigger className="min-h-10 sm:min-h-10">
                  <AccountAvatar row={row} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.name}</span>
                    {row.needsSignIn ? (
                      <span className="block text-warning text-xs">Needs sign-in</span>
                    ) : null}
                  </span>
                  {row.active ? (
                    <CheckIcon role="img" aria-label="Active account" className="size-4" />
                  ) : null}
                </MenuSubTrigger>
                <MenuSubPopup className="w-64">
                  {row.canManage ? (
                    <MenuItem
                      onClick={() =>
                        row.active
                          ? clerk.openUserProfile({ customPages })
                          : asActive(row.accountId, () => clerk.openUserProfile({ customPages }))
                      }
                    >
                      <UserCogIcon />
                      Manage account
                    </MenuItem>
                  ) : null}
                  {row.canActivate ? (
                    <MenuItem onClick={() => asActive(row.accountId, () => undefined)}>
                      <CheckIcon />
                      Make active
                    </MenuItem>
                  ) : null}
                  {row.needsSignIn ? (
                    <MenuItem onClick={() => signInAgainAs(row.accountId)}>
                      <LogInIcon />
                      Sign in again
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => requestSignOutAccount(row.accountId)}>
                    <LogOutIcon />
                    <span className="min-w-0 truncate">Sign out of {row.name}</span>
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            ))}
          </MenuGroup>
          <MenuSeparator />
          {model.addAccount === null ? null : model.addAccount.enabled ? (
            <MenuItem onClick={addAccount}>
              <PlusIcon />
              Add account
            </MenuItem>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  // Stays focusable and hoverable so the reason can be read.
                  <MenuItem
                    aria-disabled="true"
                    closeOnClick={false}
                    className="cursor-not-allowed opacity-64"
                  />
                }
              >
                <PlusIcon />
                <span className="min-w-0 flex-1">
                  <span className="block">Add account</span>
                  <span className="sr-only">{model.addAccount.reason}</span>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="left" className="max-w-64">
                {model.addAccount.reason}
              </TooltipPopup>
            </Tooltip>
          )}
          {model.canSignOutAll ? (
            <MenuItem onClick={requestSignOutAll}>
              <LogOutIcon />
              Sign out of all accounts
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </>
  );
}
