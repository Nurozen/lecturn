import { useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ConnectAccountMenu } from "./ConnectAccountMenu";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

export function LecturnConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredLecturnConnectSidebarSignIn />;
}

export function LecturnConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  // The account menu stands in for Clerk's popover once several accounts can be signed in.
  return <ConnectAccountMenu />;
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
