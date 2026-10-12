import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import {
  namedSnapshotsPerAccount,
  snapshotsOfAccountScope,
  type ProjectAccountScope,
} from "../sidebar/accountProjectGroups";
import type { SidebarSegmentation } from "../sidebar/sidebarSegments.logic";

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
