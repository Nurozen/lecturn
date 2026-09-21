import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, LogOutIcon } from "lucide-react";

import { connectMultiAccount, hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ConnectAccountMenu } from "./ConnectAccountMenu";
import { CONNECT_PROFILE_PAGES } from "./connectProfilePages";
import { useConnectSignOut } from "./useConnectSignOut";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

export function LecturnConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredLecturnConnectSidebarSignIn />;
}

export function LecturnConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  // The account menu stands in for Clerk's popover once several accounts can be signed in.
  return connectMultiAccount ? <ConnectAccountMenu /> : <ConfiguredLecturnConnectSidebarAvatar />;
}

function ConfiguredLecturnConnectSidebarAvatar() {
  const { requestSignOut, signOutDialog } = useConnectSignOut();
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <>
      {signOutDialog}
      <UserButton
        appearance={{
          elements: {
            avatarBox: "size-7",
            userButtonPopoverActionButton__signOut: { display: "none" },
            userButtonPopoverActionButton__signOutAll: { display: "none" },
            // Clerk's multi-session popover. Its other-session rows carry no
            // element key, so the single-account guard keeps that list empty.
            userButtonPopoverActionButton__addAccount: { display: "none" },
            userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
          },
        }}
      >
        <UserButton.MenuItems>
          <UserButton.Action
            label="Sign out of Lecturn"
            labelIcon={<LogOutIcon className="size-4" />}
            onClick={requestSignOut}
          />
        </UserButton.MenuItems>
        {CONNECT_PROFILE_PAGES.map(({ label, url, Icon, render }) => (
          <UserButton.UserProfilePage
            key={url}
            label={label}
            labelIcon={<Icon className="size-4" />}
            url={url}
          >
            {render()}
          </UserButton.UserProfilePage>
        ))}
      </UserButton>
    </>
  );
}

function ConfiguredLecturnConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useLecturnConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to Lecturn Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
