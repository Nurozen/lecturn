import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { decideAddAccountGate } from "@lecturn/client-runtime/relay";
import { useLocation } from "@tanstack/react-router";
import { CheckIcon, LogInIcon, LogOutIcon, PlusIcon, UserCogIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  connectAccountProfilesAtom,
  readClerkSingleSessionMode,
} from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { environmentCatalog } from "../../connection/catalog";
import { isElectron } from "../../env";
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
import {
  buildConnectAccountMenu,
  isOAuthFlowPendingError,
  unexpectedSignInToReject,
  type ConnectAccountMenuRow,
  type PendingSignInAgain,
} from "./ConnectAccountMenu.logic";
import { CONNECT_PROFILE_PAGES } from "./connectProfilePages";
import { useConnectSignOut } from "./useConnectSignOut";
import { runConnectSignOut } from "./useConnectSignOut.logic";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

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
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const unlisted = useAtomValue(environmentCatalog.unlistedRelayEnvironmentIdsValueAtom);
  const { openAuthPrompt, authPrompt } = useLecturnConnectAuthPrompt();
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

  // The desktop shell runs one browser sign-in at a time and rejects a second
  // from inside Clerk's own component, where nothing else reports it.
  useEffect(() => {
    if (!isElectron) return;
    const report = (event: PromiseRejectionEvent) => {
      if (!isOAuthFlowPendingError(event.reason)) return;
      event.preventDefault();
      toastManager.add({
        type: "warning",
        title: "A sign-in is already waiting in your browser",
        description: "Finish or close it there, then try again.",
      });
    };
    window.addEventListener("unhandledrejection", report);
    return () => window.removeEventListener("unhandledrejection", report);
  }, []);

  const gate = decideAddAccountGate({
    multiAccountEnabled: true,
    clerkSingleSessionMode: readClerkSingleSessionMode(clerk),
    targets: [...catalog.entries.values()].map((entry) => entry.target),
    unlistedRelayEnvironmentIds: unlisted,
    knownAccountCount: known.accountIds.length,
  });
  const model = buildConnectAccountMenu({
    knownAccountIds: known.accountIds,
    needsSignIn: known.needsSignIn,
    activeAccountId: userId ?? null,
    profiles,
    gate,
  });

  // Somebody new who came out of "Sign in again" past a closed gate is signed out again.
  const signInAgain = useRef<PendingSignInAgain | null>(null);
  useEffect(() => {
    const pending = signInAgain.current;
    if (pending === null) return;
    if (!known.needsSignIn.includes(pending.expectedAccountId)) {
      signInAgain.current = null;
      return;
    }
    const rejected = unexpectedSignInToReject({
      pending,
      knownAccountIds: known.accountIds,
      needsSignIn: known.needsSignIn,
    });
    if (rejected === null) return;
    signInAgain.current = null;
    toastManager.add({
      type: "warning",
      title: "That account was not added",
      description: rejected.reason,
    });
    void runConnectSignOut({
      clerk,
      targets: [rejected.accountId],
      // A new account cannot have published this computer.
      host: { _tag: "none" },
      multiAccount: true,
      unpublish: async () => undefined,
      stayUrl: window.location.href,
    }).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not sign that account out",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  }, [clerk, known]);

  const signIn = () => {
    try {
      openAuthPrompt();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: isOAuthFlowPendingError(cause)
          ? "A sign-in is already waiting in your browser"
          : "Could not open sign-in",
        description: isOAuthFlowPendingError(cause)
          ? "Finish or close it there, then try again."
          : cause instanceof Error
            ? cause.message
            : undefined,
      });
    }
  };

  // Publishing, billing, teams, and Clerk's profile follow the active account.
  const activate = (accountId: string) => {
    const session = clerk.client?.signedInSessions.find((entry) => entry.user?.id === accountId);
    if (!session) return;
    void clerk.setActive({ session: session.id }).catch((cause: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not switch accounts",
        description: cause instanceof Error ? cause.message : undefined,
      }),
    );
  };

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
                    <MenuItem onClick={() => clerk.openUserProfile({ customPages })}>
                      <UserCogIcon />
                      Manage account
                    </MenuItem>
                  ) : null}
                  {row.canActivate ? (
                    <MenuItem onClick={() => activate(row.accountId)}>
                      <CheckIcon />
                      Make active
                    </MenuItem>
                  ) : null}
                  {row.needsSignIn ? (
                    <MenuItem
                      onClick={() => {
                        signInAgain.current = {
                          expectedAccountId: row.accountId,
                          knownAccountIds: known.accountIds,
                          gate,
                        };
                        signIn();
                      }}
                    >
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
            <MenuItem
              onClick={() => {
                signInAgain.current = null;
                signIn();
              }}
            >
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
