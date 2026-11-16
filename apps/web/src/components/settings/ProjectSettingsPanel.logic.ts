import type { ProjectIconOverride } from "@lecturn/contracts";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import {
  namedSnapshotsPerAccount,
  snapshotsOfAccountScope,
  type ProjectAccountScope,
} from "../sidebar/accountProjectGroups";
import type { SidebarSegmentation } from "../sidebar/sidebarSegments.logic";

export const SCRATCH_PROJECT_TITLE = "No project";
const SCRATCH_PROJECT_ICON = {
  kind: "lucide",
  name: "message-square-dashed",
  color: "gray",
} as const satisfies ProjectIconOverride;

export function buildSettingsProjectGroups(options: {
  input: Parameters<typeof buildSidebarProjectSnapshots>[0];
  accountScope: ProjectAccountScope | null;
  segmentation: SidebarSegmentation | null;
  segmentAccounts: boolean;
}) {
  const build = options.accountScope
    ? snapshotsOfAccountScope(options.accountScope, buildSidebarProjectSnapshots)
    : options.segmentAccounts
      ? namedSnapshotsPerAccount(options.segmentation, buildSidebarProjectSnapshots)
      : buildSidebarProjectSnapshots;
  return build(options.input).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

export function defaultProjectIcon(project: Pick<Project, "isScratch">) {
  return { faviconPath: null, projectIcon: project.isScratch ? SCRATCH_PROJECT_ICON : null };
}

export function hasDefaultProjectIcon(
  project: Pick<Project, "isScratch" | "faviconPath" | "projectIcon">,
): boolean {
  if (project.faviconPath != null) return false;
  const icon = project.projectIcon ?? null;
  if (!project.isScratch) return icon === null;
  return (
    icon?.kind === "lucide" &&
    icon.name === SCRATCH_PROJECT_ICON.name &&
    icon.color === SCRATCH_PROJECT_ICON.color
  );
}
