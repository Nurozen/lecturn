import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@lecturn/contracts";

import { accountByEnvironmentIdAtom } from "../../cloud/connectAccounts";
import { AccountSurface } from "../AccountSurface";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";

export function ProjectsSettings() {
  const { search: value, scope } = useSettingsScope();
  const owners = useAtomValue(accountByEnvironmentIdAtom);
  // The page takes the owning account's surface when every selected member
  // belongs to one account.
  const selectedOwners = new Set(scope.members.map((member) => owners.get(member.environmentId)));
  const surfaceEnvironmentId =
    selectedOwners.size === 1 ? (scope.members[0]?.environmentId ?? null) : null;
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <AccountSurface
      environmentId={surfaceEnvironmentId}
      className="lecturn-settings-surface lecturn-project-settings flex min-h-0 flex-1 flex-col"
    >
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        </SettingsPageContainer>
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, checkouts and actions.
        </SettingsScopeNotice>
      )}
    </AccountSurface>
  );
}
