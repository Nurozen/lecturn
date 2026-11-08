import { useAuth } from "@clerk/react";
import { DEFAULT_UNIFIED_SETTINGS } from "@lecturn/contracts/settings";
import { Link } from "@tanstack/react-router";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useLecturnConnectAuthPrompt } from "../clerk/useLecturnConnectAuthPrompt";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { LegacyFeaturesSection } from "./SettingsPanels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Features still settling in, and legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta">
        <NewDesignRow />
        {/* Clerk is only mounted when this build has Lecturn Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
      </SettingsSection>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

/** Lecturn keeps the classic look by default; the new design is off until turned on here. */
function NewDesignRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("new-design")}
      description="Try the new design: a true black dark mode, dimmer read threads, and simpler composer controls."
      resetAction={
        settings.redesignEnabled !== DEFAULT_UNIFIED_SETTINGS.redesignEnabled ? (
          <SettingResetButton
            label="new design"
            onClick={() =>
              updateSettings({ redesignEnabled: DEFAULT_UNIFIED_SETTINGS.redesignEnabled })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.redesignEnabled}
          onCheckedChange={(checked) => updateSettings({ redesignEnabled: Boolean(checked) })}
          aria-label="New design"
        />
      }
    />
  );
}

/** Signed out of Lecturn Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useLecturnConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description="Share a thread with a guest who watches it live in their browser and sends messages you approve. Sign in to Lecturn Connect to use guest links."
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          Sign in
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      description={
        <>
          Share a thread with a guest who watches it live in their browser and sends messages you
          approve. Needs Lecturn Connect: sign in and link this machine in{" "}
          <Link to="/settings/access" className="underline underline-offset-2">
            Sharing & access
          </Link>
          . While it is off, every guest link stops working.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label="Guest links"
        />
      }
    />
  );
}
