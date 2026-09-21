import { useAtomValue } from "@effect/atom-react";
import { accountScopedKey, parseAccountScopedKey } from "@lecturn/client-runtime/relay";
import { useMemo } from "react";

import {
  accountByEnvironmentIdAtom,
  accountMarkLabels,
  connectAccountProfilesAtom,
} from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { connectMultiAccount } from "../../cloud/publicConfig";
import type {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  groupProjectsPerAccount,
  inOriginalProjectOrder,
  nameGroupsByAccount,
  resolveSidebarSegmentation,
  type SidebarSegmentation,
} from "./sidebarSegments.logic";

function useKnownSidebarSegmentation(): SidebarSegmentation | null {
  const { accountIds } = useAtomValue(knownConnectAccountsAtom);
  const accountByEnvironmentId = useAtomValue(accountByEnvironmentIdAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const accountLabels = useMemo(() => accountMarkLabels(profiles), [profiles]);
  return useMemo(
    () =>
      resolveSidebarSegmentation({
        multiAccountEnabled: true,
        knownAccountIds: accountIds,
        accountByEnvironmentId,
        accountLabels,
      }),
    [accountByEnvironmentId, accountIds, accountLabels],
  );
}

/**
 * The accounts both sidebars split by, or null while they render as one list.
 * A single-account build subscribes to nothing.
 */
export const useSidebarSegmentation: () => SidebarSegmentation | null = connectMultiAccount
  ? useKnownSidebarSegmentation
  : () => null;

type BuildSnapshots = typeof buildSidebarProjectSnapshots;
type BuildKeyMap = typeof buildPhysicalToLogicalProjectKeyMap;

/**
 * Wraps `buildSidebarProjectSnapshots` to run once per account, so a repository
 * cloned under two accounts stays two groups. Keys of account-owned groups are
 * account-scoped, and the groups keep the order the projects came in, which a
 * segment shows its part of.
 */
export function snapshotsPerAccount(
  segmentation: SidebarSegmentation | null,
  build: BuildSnapshots,
): BuildSnapshots {
  if (segmentation === null) return build;
  return (input) => [
    ...inOriginalProjectOrder(
      input.projects,
      groupProjectsPerAccount({
        segmentation,
        projects: input.projects,
        group: (projects) => build({ ...input, projects }),
        rekey: (group, key): SidebarProjectSnapshot => ({
          ...group,
          projectKey: key(group.projectKey),
        }),
      }),
      (project) => `${project.environmentId}:${project.id}`,
      (group) => group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
    ),
  ];
}

/**
 * `snapshotsPerAccount` for a list without account bars: two accounts' groups
 * of one name carry their account's label.
 */
export function namedSnapshotsPerAccount(
  segmentation: SidebarSegmentation | null,
  build: BuildSnapshots,
): BuildSnapshots {
  if (segmentation === null) return build;
  const perAccount = snapshotsPerAccount(segmentation, build);
  return (input) => [...nameGroupsByAccount(segmentation, perAccount(input))];
}

/** The account a project page is about, when it was opened from that account's segment. */
export interface ProjectAccountScope {
  readonly accountId: string;
  readonly email: string | null;
  readonly accountByEnvironmentId: ReadonlyMap<string, string>;
}

function useKnownProjectAccountScope(projectKey: string): ProjectAccountScope | null {
  const accountByEnvironmentId = useAtomValue(accountByEnvironmentIdAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const { accountId } = parseAccountScopedKey(projectKey);
  const email = accountId === null ? null : (profiles.get(accountId)?.email ?? null);
  return useMemo(
    () => (accountId === null ? null : { accountId, email, accountByEnvironmentId }),
    [accountByEnvironmentId, accountId, email],
  );
}

/**
 * The account in an account-scoped project key, or null for a plain key. A
 * single-account build never scopes a key, so it parses nothing.
 */
export const useProjectAccountScope: (projectKey: string) => ProjectAccountScope | null =
  connectMultiAccount ? useKnownProjectAccountScope : () => null;

/**
 * Wraps `buildSidebarProjectSnapshots` for the project page. Under a scope it
 * groups that account's projects alone and gives the groups that account's
 * keys, so the page acts on the segment's members and on nobody else's.
 * Without one it is `build`.
 */
export function snapshotsOfAccountScope(
  scope: Pick<ProjectAccountScope, "accountId" | "accountByEnvironmentId"> | null,
  build: BuildSnapshots,
): BuildSnapshots {
  if (scope === null) return build;
  return (input) =>
    build({
      ...input,
      projects: input.projects.filter(
        (project) => scope.accountByEnvironmentId.get(project.environmentId) === scope.accountId,
      ),
    }).map((group) => ({
      ...group,
      projectKey: accountScopedKey(group.projectKey, scope.accountId),
    }));
}

/** Wraps `buildPhysicalToLogicalProjectKeyMap` to give the keys `snapshotsPerAccount` gives. */
export function projectKeyMapPerAccount(
  segmentation: SidebarSegmentation | null,
  build: BuildKeyMap,
): BuildKeyMap {
  if (segmentation === null) return build;
  return (input) =>
    new Map(
      groupProjectsPerAccount({
        segmentation,
        projects: input.projects,
        group: (projects) => [...build({ ...input, projects })],
        rekey: ([physicalKey, logicalKey], key): [string, string] => [physicalKey, key(logicalKey)],
      }),
    );
}
