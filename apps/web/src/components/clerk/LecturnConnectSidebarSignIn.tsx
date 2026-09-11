import { UserButton, useAuth } from "@clerk/react";
import { CreditCardIcon, LogInIcon, LogOutIcon, ServerIcon, SmartphoneIcon } from "lucide-react";

import { BillingAccount } from "../cloud/BillingAccount";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { LecturnConnectUserProfilePage } from "./LecturnConnectUserProfilePage";
import { useConnectSignOut } from "./useConnectSignOut";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

export function LecturnConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredLecturnConnectSidebarSignIn />;
}

export function LecturnConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredLecturnConnectSidebarAvatar />;
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
        <UserButton.UserProfilePage
          label="Billing"
          labelIcon={<CreditCardIcon className="size-4" />}
          url="billing"
        >
          <BillingAccount embedded />
        </UserButton.UserProfilePage>
        <UserButton.UserProfilePage
          label="Mobile clients"
          labelIcon={<SmartphoneIcon className="size-4" />}
          url="mobile-clients"
        >
          <MobileClientsUserProfilePage />
        </UserButton.UserProfilePage>
        <UserButton.UserProfilePage
          label="Lecturn Connect"
          labelIcon={<ServerIcon className="size-4" />}
          url="lecturn-connect"
        >
          <LecturnConnectUserProfilePage />
        </UserButton.UserProfilePage>
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
