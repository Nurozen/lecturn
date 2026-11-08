import { hasPhoneConnectAccount } from "../../lib/androidHostAccess";
import { PhoneConnectSidebarEntry } from "../cloud/PhoneConnectAccount";
import { useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ConnectAccountMenu } from "./ConnectAccountMenu";
import { useLecturnConnectAuthPrompt } from "./useLecturnConnectAuthPrompt";

/** `labelClassName` lets the phone icon rail keep the label for screen readers only. */
export function LecturnConnectSidebarSignIn({
  labelClassName,
}: { readonly labelClassName?: string } = {}) {
  if (hasPhoneConnectAccount()) return <PhoneConnectSidebarEntry labelClassName={labelClassName} />;
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredLecturnConnectSidebarSignIn labelClassName={labelClassName} />;
}

export function LecturnConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  // The account menu stands in for Clerk's popover once several accounts can be signed in.
  return <ConnectAccountMenu />;
}

function ConfiguredLecturnConnectSidebarSignIn({
  labelClassName,
}: {
  readonly labelClassName: string | undefined;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useLecturnConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span className={labelClassName}>Sign in to Lecturn Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
