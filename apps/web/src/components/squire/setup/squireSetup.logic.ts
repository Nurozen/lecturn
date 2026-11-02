import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@lecturn/client-runtime/state/runtime";
import {
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_COMPANION,
  DEFAULT_SQUIRE_PERMISSIONS,
  SquireEventToggles,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type Squire,
  type SquireActionLogEntry,
  type SquireBudgets,
  type SquireCardPayload,
  type SquireCompanion,
  type SquireDigest,
  type SquireGrantInput,
  type SquireId,
  type SquirePalette,
  type SquirePermissions,
  type SquireRole,
  type SquireSweepSettings,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";

type SquireProposalPayload = Extract<SquireCardPayload, { readonly type: "squire-proposal" }>;

/** P13.1 sections in render order. The Lead has no scope, events, rules, or triggers (P13.1). */
export type SquireSetupSectionId =
  | "identity"
  | "provider"
  | "brief"
  | "scope"
  | "events"
  | "permissions"
  | "rules"
  | "triggers"
  | "budgets"
  | "digest"
  | "sweep"
  | "companion"
  | "leadActions";

export interface SquireSetupDraft {
  readonly name: string;
  readonly brief: string;
  readonly homeProjectId: ProjectId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly modelSelection: ModelSelection | null;
  /** Who pays for turn summaries; null is "same as the Squire". */
  readonly summaryModelSelection: ModelSelection | null;
  readonly grants: ReadonlyArray<SquireGrantInput>;
  readonly events: SquireEventToggles;
  readonly permissions: SquirePermissions;
  readonly budgets: SquireBudgets;
  readonly undoWindowSeconds: number;
  readonly companion: SquireCompanion;
  /** Lead only. */
  readonly digest: SquireDigest | null;
  /** Lead only. */
  readonly sweep: SquireSweepSettings | null;
}

export interface SquireProviderOption {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  /** Null while `squire.providerSupport` has not answered: every provider is offered. */
  readonly supported: boolean | null;
  readonly reason: string | null;
}

export type SquireSetupSaveState =
  | { readonly canSave: true }
  | { readonly canSave: false; readonly reason: string };

const SQUIRE_SECTIONS: ReadonlyArray<SquireSetupSectionId> = [
  "identity",
  "provider",
  "brief",
  "scope",
  "events",
  "permissions",
  "rules",
  "triggers",
  "budgets",
  "companion",
];
const LEAD_SECTIONS: ReadonlyArray<SquireSetupSectionId> = [
  "identity",
  "provider",
  "brief",
  "permissions",
  "budgets",
  "digest",
  "sweep",
  "companion",
  "leadActions",
];

export function squireSetupSections(role: SquireRole): ReadonlyArray<SquireSetupSectionId> {
  return role === "lead" ? LEAD_SECTIONS : SQUIRE_SECTIONS;
}

// ── Companion ─────────────────────────────────────────────────

/** Gold is the Lead's alone (P16.2); a Squire picks from these. */
export const SQUIRE_PALETTE_CHOICES: ReadonlyArray<Exclude<SquirePalette, "gold">> = [
  "brass",
  "moonstone",
  "sage",
  "rose",
];

/** The Lead is always gold, and no other Squire ever is. */
export function squireCompanionForRole(
  companion: SquireCompanion,
  role: SquireRole,
): SquireCompanion {
  if (role === "lead") {
    return companion.palette === "gold" ? companion : { ...companion, palette: "gold" };
  }
  return companion.palette === "gold" ? { ...companion, palette: "brass" } : companion;
}

// ── Drafts ────────────────────────────────────────────────────

const DEFAULT_EVENTS = Schema.decodeSync(SquireEventToggles)({});
const SQUIRE_DEFAULT_UNDO_WINDOW_SECONDS = 10;
export const SQUIRE_DEFAULT_DIGEST: SquireDigest = { time: "09:00", push: false };
export const SQUIRE_MIN_SWEEP_INTERVAL_HOURS = 4;

const toGrantInput = (grant: SquireGrantInput): SquireGrantInput => ({
  kind: grant.kind,
  targetId: grant.targetId,
});

export function squireSetupDraftFromSquire(squire: Squire): SquireSetupDraft {
  return {
    name: squire.name,
    brief: squire.brief,
    homeProjectId: squire.homeProjectId,
    providerInstanceId: squire.providerInstanceId,
    modelSelection: squire.modelSelection,
    summaryModelSelection: squire.summaryModelSelection,
    grants: squire.role === "lead" ? [] : squire.grants.map(toGrantInput),
    events: squire.events,
    permissions: squire.permissions,
    budgets: squire.budgets,
    undoWindowSeconds: squire.undoWindowSeconds,
    companion: squireCompanionForRole(squire.companion, squire.role),
    digest: squire.role === "lead" ? squire.digest : null,
    sweep: squire.role === "lead" ? squire.sweep : null,
  };
}

/**
 * Whether the edit sheet may seed its draft from the record it has. The detail query shows its
 * persisted copy first while it refetches, and the form keeps the draft it opened with, so a
 * copy older than the snapshot's revision (or, before the snapshot arrives, any copy still
 * refetching) would show stale values such as an old undo window.
 */
export function squireSetupRecordReady(input: {
  readonly squire: Pick<Squire, "revision"> | null;
  readonly snapshotRevision: number | null;
  readonly refetching: boolean;
}): boolean {
  if (input.squire === null) return false;
  return input.snapshotRevision === null
    ? !input.refetching
    : input.squire.revision >= input.snapshotRevision;
}

/** A new Squire: defaults, the first project, and the first supported provider. */
export function squireSetupDraftForCreate(input: {
  readonly homeProjectId: ProjectId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
}): SquireSetupDraft {
  return {
    name: "",
    brief: "",
    homeProjectId: input.homeProjectId,
    providerInstanceId: input.providerInstanceId,
    modelSelection: null,
    summaryModelSelection: null,
    grants: [],
    events: DEFAULT_EVENTS,
    permissions: DEFAULT_SQUIRE_PERMISSIONS,
    budgets: DEFAULT_SQUIRE_BUDGETS,
    undoWindowSeconds: SQUIRE_DEFAULT_UNDO_WINDOW_SECONDS,
    companion: DEFAULT_SQUIRE_COMPANION,
    digest: null,
    sweep: null,
  };
}

/** Edit on a Lead proposal (P17.2): the proposal's fields over the create defaults. */
export function squireSetupDraftFromProposal(
  proposal: SquireProposalPayload,
  fallback: {
    readonly homeProjectId: ProjectId | null;
    readonly providerInstanceId: ProviderInstanceId | null;
  },
): SquireSetupDraft {
  const { manageSquires: _lead, ...permissions } = proposal.permissions;
  return {
    ...squireSetupDraftForCreate(fallback),
    name: proposal.name,
    brief: proposal.brief,
    grants: proposal.grants.map(toGrantInput),
    permissions,
    companion: squireCompanionForRole(proposal.companion, "squire"),
  };
}

// ── Provider and save ─────────────────────────────────────────

export function squireProviderOptions(
  providers: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly label: string }>,
  support: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly supported: boolean;
    readonly reason: string | null;
  }> | null,
): ReadonlyArray<SquireProviderOption> {
  return providers.map((provider) => {
    const known = support?.find((entry) => entry.instanceId === provider.instanceId);
    return {
      instanceId: provider.instanceId,
      label: provider.label,
      supported: known?.supported ?? null,
      reason: known === undefined || known.supported ? null : known.reason,
    };
  });
}

/** The first supported provider, else the first whose support is unknown. */
export function squireDefaultProvider(
  options: ReadonlyArray<SquireProviderOption>,
): ProviderInstanceId | null {
  return (
    options.find((option) => option.supported === true)?.instanceId ??
    options.find((option) => option.supported === null)?.instanceId ??
    null
  );
}

export const SQUIRE_NO_SUPPORTED_PROVIDER = "No supported provider";

/** "No supported provider" when support is known and none is supported (plan 10b.1). */
export function squireSetupSaveState(
  draft: SquireSetupDraft,
  options: ReadonlyArray<SquireProviderOption>,
): SquireSetupSaveState {
  if (options.length > 0 && options.every((option) => option.supported === false)) {
    return { canSave: false, reason: SQUIRE_NO_SUPPORTED_PROVIDER };
  }
  if (draft.name.trim() === "") return { canSave: false, reason: "Give it a name" };
  if (draft.homeProjectId === null) return { canSave: false, reason: "Choose a home project" };
  if (draft.providerInstanceId === null) return { canSave: false, reason: "Choose a provider" };
  const selected = options.find((option) => option.instanceId === draft.providerInstanceId);
  if (selected?.supported === false) {
    return { canSave: false, reason: selected.reason ?? "This provider cannot run a Squire" };
  }
  if (draft.sweep?.schedule.kind === "interval") {
    if (draft.sweep.schedule.hours < SQUIRE_MIN_SWEEP_INTERVAL_HOURS) {
      return {
        canSave: false,
        reason: `Sweep at most every ${SQUIRE_MIN_SWEEP_INTERVAL_HOURS} hours`,
      };
    }
  }
  return { canSave: true };
}

// Key order is not meaningful in these records, so compare canonical JSON.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const grantKey = (grant: SquireGrantInput) => `${grant.kind}\u0000${grant.targetId}`;
const sameGrants = (a: ReadonlyArray<SquireGrantInput>, b: ReadonlyArray<SquireGrantInput>) => {
  const left = new Set(a.map(grantKey));
  const right = new Set(b.map(grantKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
};

type SquireUpdatePatch = Partial<Omit<SquireSetupDraft, "homeProjectId">>;

/** Only the changed keys, so an unrelated concurrent edit is not reset (SquireUpdateInput). */
export function squireUpdatePatch(squire: Squire, draft: SquireSetupDraft): SquireUpdatePatch {
  const patch: { -readonly [K in keyof SquireUpdatePatch]: SquireUpdatePatch[K] } = {};
  if (draft.name.trim() !== squire.name) patch.name = draft.name.trim();
  if (draft.brief !== squire.brief) patch.brief = draft.brief;
  // Neither can be cleared once set; null in the draft means "leave as is".
  if (draft.providerInstanceId !== null && draft.providerInstanceId !== squire.providerInstanceId) {
    patch.providerInstanceId = draft.providerInstanceId;
  }
  if (draft.modelSelection !== null && !same(draft.modelSelection, squire.modelSelection)) {
    patch.modelSelection = draft.modelSelection;
  }
  if (!same(draft.summaryModelSelection, squire.summaryModelSelection)) {
    patch.summaryModelSelection = draft.summaryModelSelection;
  }
  if (squire.role !== "lead") {
    if (!sameGrants(draft.grants, squire.grants)) patch.grants = draft.grants;
    if (!same(draft.events, squire.events)) patch.events = draft.events;
  }
  if (!same(draft.permissions, squire.permissions)) patch.permissions = draft.permissions;
  if (!same(draft.budgets, squire.budgets)) patch.budgets = draft.budgets;
  if (draft.undoWindowSeconds !== squire.undoWindowSeconds) {
    patch.undoWindowSeconds = draft.undoWindowSeconds;
  }
  const companion = squireCompanionForRole(draft.companion, squire.role);
  if (!same(companion, squire.companion)) patch.companion = companion;
  if (squire.role === "lead") {
    if (!same(draft.digest, squire.digest)) patch.digest = draft.digest;
    if (draft.sweep !== null && !same(draft.sweep, squire.sweep)) patch.sweep = draft.sweep;
  }
  return patch;
}

// ── Scope tree ────────────────────────────────────────────────

type ContainerKind = "project" | "staveSpace" | "staveSaga";

/** A project, Stave space, or saga a grant can name. */
export interface SquireScopeContainer {
  readonly kind: ContainerKind;
  readonly targetId: string;
}

export type SquireScopeNode =
  | {
      readonly kind: "staveSaga" | "staveSpace";
      readonly targetId: string;
      readonly label: string;
      readonly children: ReadonlyArray<SquireScopeNode>;
    }
  | {
      readonly kind: "project";
      readonly targetId: ProjectId;
      readonly label: string;
    };

export interface SquireScopeProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly stave?:
    | {
        readonly spaceId: string;
        readonly isSaga: boolean;
        readonly memberOf?: string | undefined;
      }
    | null
    | undefined;
}

/**
 * The Watches tree: saga, then its member spaces, then each space's projects; a saga's own
 * coordinating project sits directly under the saga, as the server scopes it (SquireContainers).
 * A project in a space appears only under it; projects outside Stave stay at the top.
 */
export function squireScopeTree(
  projects: ReadonlyArray<SquireScopeProject>,
): ReadonlyArray<SquireScopeNode> {
  const sagaChildren = new Map<string, SquireScopeNode[]>();
  const spaceChildren = new Map<string, SquireScopeNode[]>();
  const spaceSaga = new Map<string, string | null>();
  const plain: SquireScopeNode[] = [];
  const childrenOf = (map: Map<string, SquireScopeNode[]>, id: string) => {
    const existing = map.get(id);
    if (existing !== undefined) return existing;
    const created: SquireScopeNode[] = [];
    map.set(id, created);
    return created;
  };
  for (const project of projects) {
    const node: SquireScopeNode = { kind: "project", targetId: project.id, label: project.title };
    const stave = project.stave;
    if (stave === null || stave === undefined) {
      plain.push(node);
    } else if (stave.isSaga) {
      childrenOf(sagaChildren, stave.spaceId).push(node);
    } else {
      childrenOf(spaceChildren, stave.spaceId).push(node);
      if (!spaceSaga.get(stave.spaceId)) spaceSaga.set(stave.spaceId, stave.memberOf ?? null);
    }
  }
  const standalone: SquireScopeNode[] = [];
  for (const [spaceId, children] of spaceChildren) {
    const space: SquireScopeNode = {
      kind: "staveSpace",
      targetId: spaceId,
      label: spaceId,
      children,
    };
    const sagaId = spaceSaga.get(spaceId) ?? null;
    if (sagaId === null) standalone.push(space);
    else childrenOf(sagaChildren, sagaId).push(space);
  }
  const sagas = [...sagaChildren].map(([sagaId, children]): SquireScopeNode => ({
    kind: "staveSaga",
    targetId: sagaId,
    label: sagaId,
    children,
  }));
  return [...sagas, ...standalone, ...plain];
}

export function squireScopeHas(
  grants: ReadonlyArray<SquireGrantInput>,
  kind: SquireGrantInput["kind"],
  targetId: string,
): boolean {
  return grants.some((grant) => grant.kind === kind && grant.targetId === targetId);
}

/** The nearest granted container among `containers` (innermost first), if any. */
export function squireScopeCoveringContainer(
  grants: ReadonlyArray<SquireGrantInput>,
  containers: ReadonlyArray<SquireScopeContainer>,
): SquireScopeContainer | null {
  return (
    containers.find((container) => squireScopeHas(grants, container.kind, container.targetId)) ??
    null
  );
}

/**
 * Watched through its own grant or any enclosing container's (project, space, saga), unless
 * excluded: an exclusion beats every grant (P2.1).
 */
export function squireScopeThreadChecked(
  grants: ReadonlyArray<SquireGrantInput>,
  threadId: ThreadId,
  containers: ReadonlyArray<SquireScopeContainer>,
): boolean {
  if (squireScopeHas(grants, "exclusion", threadId)) return false;
  return (
    squireScopeHas(grants, "thread", threadId) ||
    squireScopeCoveringContainer(grants, containers) !== null
  );
}

export function squireScopeToggleContainer(
  grants: ReadonlyArray<SquireGrantInput>,
  kind: ContainerKind,
  targetId: string,
  /** A project's thread ids, whose thread grants and exclusions the project grant replaces. */
  childThreadIds: ReadonlyArray<ThreadId> = [],
): ReadonlyArray<SquireGrantInput> {
  const children = new Set<string>(childThreadIds);
  const rest = grants.filter(
    (grant) =>
      !(grant.kind === kind && grant.targetId === targetId) &&
      !((grant.kind === "thread" || grant.kind === "exclusion") && children.has(grant.targetId)),
  );
  return squireScopeHas(grants, kind, targetId) ? rest : [...rest, { kind, targetId }];
}

/** Unchecking a thread inside a granted container records an `exclusion` (P2). */
export function squireScopeToggleThread(
  grants: ReadonlyArray<SquireGrantInput>,
  threadId: ThreadId,
  containers: ReadonlyArray<SquireScopeContainer>,
): ReadonlyArray<SquireGrantInput> {
  const checked = squireScopeThreadChecked(grants, threadId, containers);
  const covered = squireScopeCoveringContainer(grants, containers) !== null;
  const rest = grants.filter(
    (grant) =>
      !((grant.kind === "thread" || grant.kind === "exclusion") && grant.targetId === threadId),
  );
  if (checked) return covered ? [...rest, { kind: "exclusion", targetId: threadId }] : rest;
  return covered ? rest : [...rest, { kind: "thread", targetId: threadId }];
}

// ── Lead actions (P17.6) ──────────────────────────────────────

export type SquireLeadControl = "pause" | "resume" | "rescope" | "forward" | "merge";

export interface SquireLeadActionRow {
  readonly logEntryId: number;
  readonly control: SquireLeadControl;
  readonly squireId: SquireId | null;
  readonly toSquireId: SquireId | null;
  readonly cardCount: number;
  readonly reason: string | null;
  readonly at: string;
  readonly reverted: boolean;
}

const CONTROLS: ReadonlySet<string> = new Set(["pause", "resume", "rescope", "forward", "merge"]);
const stringOr = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * The Lead's control actions, newest first: each `action.executed` row whose data is
 * `action: "control"`, marked reverted when a `control.reverted` row names it.
 */
export function squireLeadActionRows(
  entries: ReadonlyArray<SquireActionLogEntry>,
): ReadonlyArray<SquireLeadActionRow> {
  const reverted = new Set<number>();
  for (const entry of entries) {
    if (entry.kind === "control.reverted" && typeof entry.data.logEntryId === "number") {
      reverted.add(entry.data.logEntryId);
    }
  }
  return entries
    .flatMap((entry): ReadonlyArray<SquireLeadActionRow> => {
      const { data } = entry;
      if (entry.kind !== "action.executed" || data.action !== "control") return [];
      if (typeof data.control !== "string" || !CONTROLS.has(data.control)) return [];
      return [
        {
          logEntryId: entry.id,
          control: data.control as SquireLeadControl,
          squireId: stringOr(data.squireId) as SquireId | null,
          toSquireId: stringOr(data.toSquireId) as SquireId | null,
          cardCount: Array.isArray(data.cardIds) ? data.cardIds.length : 0,
          reason: stringOr(data.reason),
          at: entry.createdAt,
          reverted: reverted.has(entry.id),
        },
      ];
    })
    .toSorted((a, b) => b.logEntryId - a.logEntryId);
}

export function squireLeadActionText(
  row: SquireLeadActionRow,
  nameOf: (id: SquireId) => string,
): string {
  const target = row.squireId === null ? "a Squire" : nameOf(row.squireId);
  const to = row.toSquireId === null ? "another Squire" : nameOf(row.toSquireId);
  switch (row.control) {
    case "pause":
      return `Paused ${target}`;
    case "resume":
      return `Resumed ${target}`;
    case "rescope":
      return `Changed what ${target} watches`;
    case "forward":
      return `Forwarded an item to ${to}`;
    case "merge":
      return `Merged ${row.cardCount > 0 ? `${row.cardCount} items` : "items"}`;
  }
}

/** The server's refusal message, shown inline; the fallback when it has none. */
export function squireCommandError(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim() !== "" ? failure.message : fallback;
}
