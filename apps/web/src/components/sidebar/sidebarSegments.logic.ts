import {
  accountScopedKey,
  bucketByAccount,
  parseAccountScopedKey,
} from "@lecturn/client-runtime/relay";
import * as Schema from "effect/Schema";

import { resolveProjectStatusIndicator, type ThreadStatusPill } from "../Sidebar.logic";
import { sagaSidebarThreadOrder } from "../stave/staveSaga.logic";

/** Collapsed segment ids, per client. Collapse is display only: the account stays connected. */
export const SEGMENT_COLLAPSED_KEY = "lecturn:sidebar:segment-collapsed";
export const SegmentCollapsedSchema = Schema.Array(Schema.String);
export const NO_SEGMENTS_COLLAPSED: ReadonlyArray<string> = [];

/** Id of the segment for environments no account owns. It has no bar and never collapses. */
export const NO_ACCOUNT_SEGMENT_ID = "no-account";

/** DOM id of a segment's label, which names its list. */
export const segmentLabelDomId = (segmentId: string) => `sidebar-account-${segmentId}`;
/** DOM id of a segment's thread list, which its bar opens and closes. */
export const segmentListDomId = (segmentId: string) => `sidebar-account-${segmentId}-threads`;

interface EnvironmentScoped {
  readonly environmentId: string;
}

/**
 * Which account's segment each environment belongs to, or null while the
 * sidebar is one list: the build serves a single account, or fewer than two
 * accounts are known.
 */
export interface SidebarSegmentation {
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly accountByEnvironmentId: ReadonlyMap<string, string>;
  /** Short names that tell the accounts apart, where no bar does. */
  readonly accountLabels: ReadonlyMap<string, string>;
}

export function resolveSidebarSegmentation(input: {
  readonly multiAccountEnabled: boolean;
  readonly knownAccountIds: ReadonlyArray<string>;
  readonly accountByEnvironmentId: ReadonlyMap<string, string>;
  readonly accountLabels: ReadonlyMap<string, string>;
}): SidebarSegmentation | null {
  return input.multiAccountEnabled && input.knownAccountIds.length >= 2
    ? {
        knownAccountIds: input.knownAccountIds,
        accountByEnvironmentId: input.accountByEnvironmentId,
        accountLabels: input.accountLabels,
      }
    : null;
}

export interface SidebarSegment<Thread, Project> {
  /** The account id, or `NO_ACCOUNT_SEGMENT_ID`. */
  readonly id: string;
  readonly accountId: string | null;
  readonly collapsed: boolean;
  readonly threads: ReadonlyArray<Thread>;
  readonly projects: ReadonlyArray<Project>;
}

/**
 * One segment per known account in known-list order, kept even when empty so
 * its bar can say "Needs sign-in" or "No threads". Then one segment without an
 * account, last, for this device, direct, Tailscale, and SSH environments and
 * for relay entries that have no owner yet. That one is left out when empty,
 * unless a draft waits there for a project that has not loaded.
 */
export function buildSidebarSegments<
  Thread extends EnvironmentScoped,
  Project extends EnvironmentScoped,
>(input: {
  readonly segmentation: SidebarSegmentation;
  readonly collapsedSegmentIds: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<Thread>;
  readonly projects: ReadonlyArray<Project>;
  readonly keepNoAccountSegment?: boolean;
}): ReadonlyArray<SidebarSegment<Thread, Project>> {
  const { knownAccountIds, accountByEnvironmentId } = input.segmentation;
  const accountOf = (item: EnvironmentScoped) => accountByEnvironmentId.get(item.environmentId);
  const threads = bucketByAccount(input.threads, accountOf, knownAccountIds);
  const projects = bucketByAccount(input.projects, accountOf, knownAccountIds);
  return [...knownAccountIds, null].flatMap((accountId) => {
    const segment = {
      id: accountId ?? NO_ACCOUNT_SEGMENT_ID,
      accountId,
      collapsed: accountId !== null && input.collapsedSegmentIds.includes(accountId),
      threads: threads.find((bucket) => bucket.accountId === accountId)?.items ?? [],
      projects: projects.find((bucket) => bucket.accountId === accountId)?.items ?? [],
    };
    return accountId === null &&
      !input.keepNoAccountSegment &&
      segment.threads.length === 0 &&
      segment.projects.length === 0
      ? []
      : [segment];
  });
}

/**
 * The threads keyboard navigation walks, in the order they are on screen:
 * segment by segment, leaving out collapsed segments. Thread order, jump
 * hints, and range selection all read this one list.
 */
export function flattenSegmentsForNavigation<Thread>(
  segments: ReadonlyArray<{
    readonly collapsed: boolean;
    readonly orderedThreads: ReadonlyArray<Thread>;
  }>,
): ReadonlyArray<Thread> {
  return segments.flatMap((segment) => (segment.collapsed ? [] : segment.orderedThreads));
}

/** Bars stack at the edges of the scroll viewport, so each has the same fixed height. */
export const ACCOUNT_BAR_HEIGHT_REM = 1.75;
/** The rule that ends the last account's segment sticks under the bars. */
export const NO_ACCOUNT_RULE_HEIGHT_REM = 0.5;

export interface SegmentStickyLayout {
  /** Where the segment's bar, or rule, sticks. No `bottom`: it scrolls away below. */
  readonly top: string;
  readonly bottom?: string;
  /** How much of the viewport's edges bars can cover while a row of this segment shows. */
  readonly coveredTop: string;
  readonly coveredBottom: string;
}

/**
 * Sticky offsets per segment. At the top a bar sticks under the bars before
 * it, so what is scrolled past stays named. At the bottom only a bar with an
 * attention pill sticks, which is the one thing an account below the fold has
 * to say. A row is covered by its own and earlier bars above, and by later
 * attention bars below, and that is what it keeps clear of when scrolled to.
 */
export function layoutSegmentBars(
  segments: ReadonlyArray<{ readonly accountId: string | null; readonly attention: unknown }>,
): ReadonlyArray<SegmentStickyLayout> {
  const rem = (bars: number, extra = 0) => `${bars * ACCOUNT_BAR_HEIGHT_REM + extra}rem`;
  const sticksBelow = (segment: (typeof segments)[number]) =>
    segment.accountId !== null && segment.attention != null;
  return segments.map((segment, index) => {
    const barsBefore = segments.slice(0, index).filter((entry) => entry.accountId !== null).length;
    const stuckAfter = segments.slice(index + 1).filter(sticksBelow).length;
    return {
      top: rem(barsBefore),
      ...(sticksBelow(segment) ? { bottom: rem(stuckAfter) } : {}),
      coveredTop:
        segment.accountId === null
          ? rem(barsBefore, NO_ACCOUNT_RULE_HEIGHT_REM)
          : rem(barsBefore + 1),
      coveredBottom: rem(stuckAfter),
    };
  });
}

/** The one status a segment's bar shows: the most urgent among its threads. */
export function rollupAttention(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  return resolveProjectStatusIndicator(statuses);
}

/** Adds or removes one segment from the persisted collapsed list. */
export function toggleSegmentCollapsed(
  collapsedSegmentIds: ReadonlyArray<string>,
  segmentId: string,
): ReadonlyArray<string> {
  return collapsedSegmentIds.includes(segmentId)
    ? collapsedSegmentIds.filter((id) => id !== segmentId)
    : [...collapsedSegmentIds, segmentId];
}

/**
 * The settled rows a segment shows. Mirrors the unsegmented sidebar: a page of
 * the tail while the shelf is open, and the open thread always.
 */
export function pageSegmentSettledThreads<Thread>(input: {
  readonly settledThreads: ReadonlyArray<Thread>;
  readonly visibleCount: number;
  readonly shelfExpanded: boolean;
  readonly isRouteThread: (thread: Thread) => boolean;
}): { readonly rendered: ReadonlyArray<Thread>; readonly hiddenCount: number } {
  const page = input.settledThreads.slice(0, input.visibleCount);
  const routeThread = input.settledThreads.find(input.isRouteThread);
  const visible =
    routeThread === undefined || page.includes(routeThread) ? page : [...page, routeThread];
  return {
    rendered: input.shelfExpanded ? visible : routeThread === undefined ? [] : [routeThread],
    hiddenCount: input.settledThreads.length - visible.length,
  };
}

/**
 * Groups in the order their first project has in `projects`. Grouping per
 * account hands them back account by account, which would override the user's
 * own project order. Each segment's order is a part of this one.
 */
export function inOriginalProjectOrder<Project, Group>(
  projects: ReadonlyArray<Project>,
  groups: ReadonlyArray<Group>,
  keyOfProject: (project: Project) => string,
  memberKeysOf: (group: Group) => ReadonlyArray<string>,
): ReadonlyArray<Group> {
  const indexByKey = new Map(projects.map((project, index) => [keyOfProject(project), index]));
  const firstIndex = (group: Group) =>
    Math.min(...memberKeysOf(group).map((key) => indexByKey.get(key) ?? projects.length));
  return groups
    .map((group) => ({ group, index: firstIndex(group) }))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.group);
}

/**
 * Adds the account's label to groups that share a name, for lists that show
 * groups of several accounts without account bars. A name nobody shares, and a
 * group no account owns, stay as they are.
 */
export function nameGroupsByAccount<
  Group extends { readonly projectKey: string; readonly displayName: string },
>(segmentation: SidebarSegmentation | null, groups: ReadonlyArray<Group>): ReadonlyArray<Group> {
  if (segmentation === null) return groups;
  const shared = new Set(
    groups
      .map((group) => group.displayName)
      .filter((name, index, names) => names.indexOf(name) !== index),
  );
  return groups.map((group) => {
    const { accountId } = parseAccountScopedKey(group.projectKey);
    if (accountId === null || !shared.has(group.displayName)) return group;
    const label =
      segmentation.accountLabels.get(accountId) ??
      `account ${segmentation.knownAccountIds.indexOf(accountId) + 1}`;
    return { ...group, displayName: `${group.displayName} (${label})` };
  });
}

/**
 * The ids a pinned drag may reorder: those of the moved thread's segment, in
 * the order given. Each segment is its own pinned block, so a drop never
 * rewrites, or waits on, another account's threads. Every id without segments.
 */
export function reorderIdsWithinSegment<Thread>(input: {
  readonly segments: ReadonlyArray<{ readonly pinnedThreads: ReadonlyArray<Thread> }> | null;
  readonly orderedIds: ReadonlyArray<string>;
  readonly movedId: string;
  readonly idOf: (thread: Thread) => string;
}): ReadonlyArray<string> {
  const segmentIds = input.segments
    ?.map((segment) => new Set(segment.pinnedThreads.map(input.idOf)))
    .find((ids) => ids.has(input.movedId));
  return segmentIds === undefined
    ? input.orderedIds
    : input.orderedIds.filter((id) => segmentIds.has(id));
}

/**
 * Runs `group` once per account, so the same repository on two accounts gives
 * two groups, and makes their keys unique. Without a segmentation it is
 * `group(projects)`.
 */
export function groupProjectsPerAccount<Project extends EnvironmentScoped, Group>(input: {
  readonly segmentation: SidebarSegmentation | null;
  readonly projects: ReadonlyArray<Project>;
  readonly group: (projects: ReadonlyArray<Project>) => ReadonlyArray<Group>;
  readonly rekey: (group: Group, key: (key: string) => string) => Group;
}): ReadonlyArray<Group> {
  const { segmentation } = input;
  if (segmentation === null) {
    return input.group(input.projects);
  }
  return bucketByAccount(
    input.projects,
    (project) => segmentation.accountByEnvironmentId.get(project.environmentId),
    segmentation.knownAccountIds,
  ).flatMap((bucket) =>
    input
      .group(bucket.items)
      .map((group) => input.rekey(group, (key) => accountScopedKey(key, bucket.accountId))),
  );
}

interface SegmentThread extends EnvironmentScoped {
  readonly projectId: string;
}

export interface SegmentSagaNode {
  readonly group: {
    readonly key: string;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  };
  readonly children: ReadonlyArray<SegmentSagaNode>;
}

/**
 * What the sidebar's list body reads. The body was written against one list,
 * so a segment hands it the same names narrowed to that segment's threads.
 */
export interface SidebarListScope<Thread, Node> {
  readonly pinnedThreads: ReadonlyArray<Thread>;
  readonly activeThreads: ReadonlyArray<Thread>;
  readonly snoozedThreads: ReadonlyArray<Thread>;
  readonly visibleSnoozedThreads: ReadonlyArray<Thread>;
  readonly settledThreads: ReadonlyArray<Thread>;
  readonly renderedSettledThreads: ReadonlyArray<Thread>;
  /** Visual order of the rows, which is also the keyboard order. */
  readonly orderedThreads: ReadonlyArray<Thread>;
  readonly scopedSagaTree: ReadonlyArray<Node>;
  /** `environmentId:projectId` keys the draft block keeps, or null for all. */
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
}

export interface SidebarSegmentView<Thread, Node> extends SidebarListScope<Thread, Node> {
  /** The account id, or `NO_ACCOUNT_SEGMENT_ID`. */
  readonly id: string;
  readonly accountId: string | null;
  readonly collapsed: boolean;
  readonly attention: ThreadStatusPill | null;
  readonly hasRows: boolean;
  /** Settled rows behind "Show more". */
  readonly hiddenSettledCount: number;
  /** Which drafts the segment's draft block keeps, inside `scopedProjectKeys`. */
  readonly ownsEnvironment: OwnsEnvironment;
}

/** The segment an environment's threads and drafts show in. */
export function segmentIdOfEnvironment(
  segmentation: SidebarSegmentation,
  environmentId: string,
): string {
  const accountId = segmentation.accountByEnvironmentId.get(environmentId);
  return accountId !== undefined && segmentation.knownAccountIds.includes(accountId)
    ? accountId
    : NO_ACCOUNT_SEGMENT_ID;
}

export type OwnsEnvironment = (environmentId: string) => boolean;
export const OWNS_EVERY_ENVIRONMENT: OwnsEnvironment = () => true;

/**
 * Per segment id, whether an environment's drafts show there. It asks the
 * environment, never the loaded projects: a draft outlives its project shell
 * while the environment is offline, needs sign-in, or is still starting. Built
 * apart from the views so the memoized draft block keeps still while thread
 * shells stream in.
 */
export function buildSegmentEnvironmentFilters(
  segmentation: SidebarSegmentation,
): ReadonlyMap<string, OwnsEnvironment> {
  return new Map(
    [...segmentation.knownAccountIds, NO_ACCOUNT_SEGMENT_ID].map((segmentId) => [
      segmentId,
      (environmentId: string) => segmentIdOfEnvironment(segmentation, environmentId) === segmentId,
    ]),
  );
}

/**
 * What one segment's shelves remember on their own, so "Show more" or a shelf
 * toggle in one account leaves the others alone. What a segment never touched
 * follows the one-list sidebar's setting.
 */
export interface SegmentShelfState {
  readonly snoozedExpanded?: boolean | undefined;
  readonly settledExpanded?: boolean | undefined;
  readonly settledVisibleCount?: number | undefined;
}
export type SegmentShelves = ReadonlyMap<string, SegmentShelfState>;
export const NO_SEGMENT_SHELVES: SegmentShelves = new Map();

export function changeSegmentShelf(
  shelves: SegmentShelves,
  segmentId: string,
  change: (shelf: SegmentShelfState) => SegmentShelfState,
): SegmentShelves {
  return new Map(shelves).set(segmentId, change(shelves.get(segmentId) ?? {}));
}

/** Back to the first settled page everywhere, as the one list does when the project scope flips. */
export function resetSegmentSettledPages(shelves: SegmentShelves): SegmentShelves {
  return new Map(
    [...shelves].map(([segmentId, shelf]) => [
      segmentId,
      { ...shelf, settledVisibleCount: undefined },
    ]),
  );
}

export interface SidebarSegmentViewsInput<Thread, Node> extends Omit<
  SidebarListScope<Thread, Node>,
  "orderedThreads" | "renderedSettledThreads" | "visibleSnoozedThreads"
> {
  readonly segmentation: SidebarSegmentation;
  readonly collapsedSegmentIds: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<EnvironmentScoped & { readonly id: string }>;
  readonly environmentFilters: ReadonlyMap<string, OwnsEnvironment>;
  /** A draft waits in an environment no account owns. */
  readonly hasNoAccountDrafts: boolean;
  /** Hierarchy mode: projects are headers, and settled rows page per project. */
  readonly nestSagaProjects: boolean;
  readonly nestedSettledThreads: ReadonlyArray<Thread>;
  readonly collapsedProjectKeys: ReadonlySet<string>;
  readonly settledVisibleCount: number;
  readonly shelves: SegmentShelves;
  readonly isRouteThread: (thread: Thread) => boolean;
  readonly statusOf: (thread: Thread) => ThreadStatusPill | null;
}

/**
 * Narrows the sidebar's partitioned lists to each segment. Pinned, the shelves,
 * and the project tree are all per segment, and every list keeps the order the
 * sidebar gave it.
 */
export function buildSidebarSegmentViews<
  Thread extends SegmentThread,
  Node extends SegmentSagaNode,
>(input: SidebarSegmentViewsInput<Thread, Node>): ReadonlyArray<SidebarSegmentView<Thread, Node>> {
  return buildSidebarSegments({
    segmentation: input.segmentation,
    collapsedSegmentIds: input.collapsedSegmentIds,
    threads: [
      ...input.pinnedThreads,
      ...input.activeThreads,
      ...input.snoozedThreads,
      ...input.settledThreads,
    ],
    projects: input.projects,
    keepNoAccountSegment: input.hasNoAccountDrafts,
  }).map((segment) => {
    const own = new Set(segment.threads);
    const mine = (threads: ReadonlyArray<Thread>) => threads.filter((thread) => own.has(thread));
    const environmentIds = new Set(segment.projects.map((project) => project.environmentId));
    const shelf = input.shelves.get(segment.id) ?? {};
    const snoozedShelfExpanded = shelf.snoozedExpanded ?? input.snoozedShelfExpanded;
    const settledShelfExpanded = shelf.settledExpanded ?? input.settledShelfExpanded;
    const settledThreads = mine(input.settledThreads);
    const settledPage = pageSegmentSettledThreads({
      settledThreads,
      visibleCount: shelf.settledVisibleCount ?? input.settledVisibleCount,
      shelfExpanded: settledShelfExpanded,
      isRouteThread: input.isRouteThread,
    });
    const scopedSagaTree = input.scopedSagaTree.filter((node) =>
      node.group.memberProjectRefs.some((ref) => environmentIds.has(ref.environmentId)),
    );
    const pinnedThreads = mine(input.pinnedThreads);
    const activeThreads = mine(input.activeThreads);
    const snoozedThreads = mine(input.snoozedThreads);
    // The open thread keeps its row behind a closed shelf, as in the one list.
    const visibleSnoozedThreads = snoozedShelfExpanded
      ? snoozedThreads
      : snoozedThreads.filter(input.isRouteThread);
    const rows = [
      ...pinnedThreads,
      ...activeThreads,
      ...visibleSnoozedThreads,
      ...(input.nestSagaProjects ? mine(input.nestedSettledThreads) : settledPage.rendered),
    ];
    return {
      id: segment.id,
      accountId: segment.accountId,
      collapsed: segment.collapsed,
      attention: rollupAttention([...pinnedThreads, ...activeThreads].map(input.statusOf)),
      hasRows: segment.threads.length > 0 || (input.nestSagaProjects && scopedSagaTree.length > 0),
      hiddenSettledCount: settledPage.hiddenCount,
      pinnedThreads,
      activeThreads,
      snoozedThreads,
      visibleSnoozedThreads,
      settledThreads,
      renderedSettledThreads: settledPage.rendered,
      orderedThreads: input.nestSagaProjects
        ? sagaSidebarThreadOrder<Thread, SegmentSagaNode>(
            scopedSagaTree,
            input.collapsedProjectKeys,
            rows,
          )
        : rows,
      scopedSagaTree,
      scopedProjectKeys: input.scopedProjectKeys,
      snoozedShelfExpanded,
      settledShelfExpanded,
      ownsEnvironment: input.environmentFilters.get(segment.id) ?? OWNS_EVERY_ENVIRONMENT,
    };
  });
}
