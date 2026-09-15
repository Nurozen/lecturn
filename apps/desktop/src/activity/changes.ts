import { isViewedActivityThread } from "./interaction.ts";
// @effect-diagnostics globalDate:off -- The native UI compares client intent timestamps; tests inject its clock.
import type {
  DesktopActivityRow,
  DesktopActivitySnapshot,
  ActivityVisualState,
} from "@lecturn/contracts";
import {
  activityVisualPresentation,
  activityVisualState,
} from "@lecturn/client-runtime/state/activityContext";

export interface ActivityChange {
  rowId: string;
  state: ActivityVisualState;
  label: string;
}

const priority: Record<ActivityVisualState, number> = {
  attention: 0,
  failed: 1,
  complete: 2,
  active: 3,
  offline: 4,
  idle: 5,
};
const transient = (row: DesktopActivityRow) =>
  /^(sending|updating|pending)(\b|…)/i.test(row.status.trim());
const stateOf = (row: DesktopActivityRow) => row.visualState ?? activityVisualState(row);
const identity = (row: DesktopActivityRow) =>
  JSON.stringify([
    row.id,
    row.environmentId,
    row.projectId,
    row.watchId ? null : (row.threadId ?? null),
    row.watchId ?? null,
  ]);
const compact = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 120);

const checkEvents = {
  "action-required": { state: "attention", label: "needs attention" },
  failure: { state: "failed", label: "failed" },
  success: { state: "complete", label: "passed" },
  pending: { state: "active", label: "started" },
  cancelled: { state: "idle", label: "cancelled" },
  skipped: { state: "idle", label: "skipped" },
  neutral: { state: "idle", label: "finished" },
} as const;

function checksByName(row: DesktopActivityRow) {
  const groups = new Map<string, string[]>();
  for (const check of row.checks ?? []) {
    const statuses = groups.get(check.name) ?? [];
    statuses.push(check.status);
    groups.set(check.name, statuses);
  }
  return groups;
}

/** One semantic alert per publication. Undefined is the startup baseline; empty is an observed empty panel. */
export function activityChanges(
  previousRows: readonly DesktopActivityRow[] | null | undefined,
  nextRows: readonly DesktopActivityRow[],
  suppressedVisualRowIds: ReadonlySet<string> = new Set(),
): ActivityChange | undefined {
  if (previousRows == null) return undefined;
  const previous = new Map(previousRows.map((row) => [identity(row), row]));
  const candidates: (ActivityChange & { priority: number })[] = [];
  const add = (
    row: DesktopActivityRow,
    state: ActivityVisualState,
    label: string,
    rank = priority[state],
  ) => {
    candidates.push({ rowId: row.id, state, label, priority: rank });
  };
  for (const row of nextRows) {
    const prior = previous.get(identity(row));
    const state = stateOf(row);
    if (!prior) {
      if (
        !suppressedVisualRowIds.has(row.id) &&
        !transient(row) &&
        ["active", "attention", "failed"].includes(state)
      )
        add(row, state, `${compact(row.title)} · ${activityVisualPresentation[state].label}`);
      continue;
    }
    // An acknowledgement is temporary activity, but a resulting failure or request
    // for input must surface even when sending temporarily hid the previous state.
    const changedState = transient(prior)
      ? state === "failed" || state === "attention"
      : state !== stateOf(prior);
    if (!suppressedVisualRowIds.has(row.id) && !transient(row) && changedState)
      add(row, state, `${compact(row.title)} · ${activityVisualPresentation[state].label}`);
    if (!row.watchId) continue;
    const oldChecks = checksByName(prior);
    for (const [name, nextStatuses] of checksByName(row)) {
      const unmatchedOld = [...(oldChecks.get(name) ?? [])];
      const changed: string[] = [];
      for (const status of nextStatuses) {
        const match = unmatchedOld.indexOf(status);
        if (match >= 0) unmatchedOld.splice(match, 1);
        else changed.push(status);
      }
      for (const status of changed) {
        const event = checkEvents[status as keyof typeof checkEvents];
        if (!event) continue;
        // First observation of already finished jobs is catch-up, not a new completion.
        if (unmatchedOld.length === 0 && !["active", "attention", "failed"].includes(event.state))
          continue;
        const rank = ["cancelled", "skipped", "neutral"].includes(status)
          ? priority.complete
          : priority[event.state];
        add(row, event.state, `${compact(name)} ${event.label}`, rank);
      }
    }
  }
  const selected = candidates.toSorted(
    (left, right) =>
      left.priority - right.priority ||
      left.rowId.localeCompare(right.rowId) ||
      left.label.localeCompare(right.label),
  )[0];
  return selected
    ? { rowId: selected.rowId, state: selected.state, label: selected.label }
    : undefined;
}

const promptOrigin = (row: DesktopActivityRow) =>
  row.threadId ? JSON.stringify([row.environmentId, row.threadId]) : null;

/** Correlate user prompts with their delayed starts without muting later autonomous work. */
export class ActivityChangeTracker {
  private previous: readonly DesktopActivityRow[] | undefined;
  private readonly tokens = new Map<string, string>();
  private readonly awaitingStart = new Set<string>();
  private readonly stableStates = new Map<string, ActivityVisualState>();
  private readonly seenIntents = new Map<string, NonNullable<DesktopActivityRow["userAction"]>>();
  private readonly pendingIntents = new Map<
    string,
    NonNullable<DesktopActivityRow["userAction"]>
  >();

  update(
    rows: readonly DesktopActivityRow[],
    now = Date.now(),
    suppressedRows: ReadonlySet<string> = new Set(),
  ): ActivityChange | undefined {
    const presentOrigins = new Set(rows.map(promptOrigin).filter((origin) => origin !== null));
    const intentOrigins = new Set(rows.filter((row) => row.userAction).map(promptOrigin));
    // The producer removes a failed command's intent; do not let that failed
    // request suppress an unrelated later transition within the expiry window.
    for (const origin of this.pendingIntents.keys())
      if (presentOrigins.has(origin) && !intentOrigins.has(origin))
        this.pendingIntents.delete(origin);
    for (const row of rows) {
      const origin = promptOrigin(row);
      const intent = row.userAction;
      if (!origin || !intent) continue;
      const seen = this.seenIntents.get(origin);
      if (seen?.id === intent.id || (seen && seen.at > intent.at)) continue;
      this.seenIntents.delete(origin);
      this.seenIntents.set(origin, intent);
      if (this.previous !== undefined && now >= intent.at && now - intent.at <= 30_000)
        this.pendingIntents.set(origin, intent);
    }
    for (const [origin, intent] of this.pendingIntents)
      if (now - intent.at > 30_000 || now < intent.at) this.pendingIntents.delete(origin);
    while (this.seenIntents.size > 256) {
      const oldest = this.seenIntents.keys().next().value!;
      this.seenIntents.delete(oldest);
      this.pendingIntents.delete(oldest);
    }
    const newest = new Map<string, string>();
    for (const row of rows) {
      const origin = promptOrigin(row);
      if (origin && row.userPromptAt && row.userPromptAt > (newest.get(origin) ?? ""))
        newest.set(origin, row.userPromptAt);
    }
    const submitted = new Set<string>();
    for (const [origin, token] of newest) {
      if (token <= (this.tokens.get(origin) ?? "")) continue;
      this.tokens.delete(origin);
      this.tokens.set(origin, token);
      if (this.previous !== undefined) {
        submitted.add(origin);
        this.awaitingStart.add(origin);
      }
    }
    // The bounded panel can rotate through many projects over a long app session.
    while (this.tokens.size > 256) {
      const oldest = this.tokens.keys().next().value!;
      this.tokens.delete(oldest);
      this.awaitingStart.delete(oldest);
    }
    const previousByIdentity = new Map(this.previous?.map((row) => [identity(row), row]));
    const suppress = new Set(suppressedRows);
    const consumed = new Set<string>();
    const consumedIntents = new Set<string>();
    const intentMatches = (
      kind: NonNullable<DesktopActivityRow["userAction"]>["kind"],
      state: ActivityVisualState,
    ) =>
      kind === "start"
        ? state === "active"
        : kind === "stop"
          ? state === "idle"
          : kind === "settle"
            ? state === "complete"
            : state === "idle" || state === "active";
    for (const row of rows) {
      const origin = promptOrigin(row);
      const prior = previousByIdentity.get(identity(row));
      const state = stateOf(row);
      const urgent = state === "attention" || state === "failed";
      const intent = origin ? this.pendingIntents.get(origin) : undefined;
      // Responding to a blocker can finish its send receipt before the shell
      // starts. Restoring that same old attention state is not a new request.
      const restoredBlocker = Boolean(
        origin &&
        (intent?.kind === "start" || this.awaitingStart.has(origin)) &&
        prior &&
        transient(prior) &&
        !transient(row) &&
        state === "attention" &&
        this.stableStates.get(identity(row)) === "attention" &&
        !/failed|error/i.test(row.status),
      );
      if (restoredBlocker) suppress.add(row.id);
      const matchingIntent =
        intent &&
        !transient(row) &&
        (!prior || state !== stateOf(prior)) &&
        intentMatches(intent.kind, state);
      if (!urgent && matchingIntent) {
        suppress.add(row.id);
        if (origin && !row.watchId) consumedIntents.add(origin);
      }
      if (
        origin &&
        !row.watchId &&
        prior &&
        state !== stateOf(prior) &&
        !transient(row) &&
        ((urgent && !restoredBlocker) || (intent?.kind === "start" && state === "complete"))
      )
        consumedIntents.add(origin);
      const manualStateChanged =
        prior &&
        (Boolean(row.userSettled) !== Boolean(prior.userSettled) ||
          Boolean(row.userStopped) !== Boolean(prior.userStopped));
      if (
        !urgent &&
        (manualStateChanged ||
          (origin &&
            (submitted.has(origin) || (this.awaitingStart.has(origin) && state === "active"))))
      )
        suppress.add(row.id);
      // PR checks may already be active while the agent is still starting; only
      // the conversation row consumes its prompt, never the associated CI row.
      if (
        origin &&
        !row.watchId &&
        !transient(row) &&
        this.awaitingStart.has(origin) &&
        (state === "active" ||
          (prior &&
            state !== stateOf(prior) &&
            ((urgent && !restoredBlocker) || state === "complete")))
      )
        consumed.add(origin);
    }
    for (const origin of consumed) this.awaitingStart.delete(origin);
    for (const origin of consumedIntents) this.pendingIntents.delete(origin);
    const result = activityChanges(this.previous, rows, suppress);
    const presentIdentities = new Set(rows.map(identity));
    for (const key of this.stableStates.keys())
      if (!presentIdentities.has(key)) this.stableStates.delete(key);
    for (const row of rows) if (!transient(row)) this.stableStates.set(identity(row), stateOf(row));
    this.previous = rows;
    return result;
  }
}

/** Restored/cached activity is visible immediately, but only subsequent live changes alert. */
export class ActivitySnapshotChangeTracker {
  private readonly environments = new Map<string, ActivityChangeTracker>();

  update(snapshot: DesktopActivitySnapshot): ActivityChange | undefined {
    const ready = new Set(
      snapshot.readyEnvironmentIds ?? snapshot.rows.map((row) => row.environmentId),
    );
    for (const id of this.environments.keys()) {
      if (!ready.has(id)) this.environments.delete(id);
    }
    const changes: ActivityChange[] = [];
    for (const id of ready) {
      let tracker = this.environments.get(id);
      if (!tracker) {
        tracker = new ActivityChangeTracker();
        this.environments.set(id, tracker);
      }
      const rows = snapshot.rows.filter((row) => row.environmentId === id);
      const suppressed = new Set(
        rows
          .filter((row) => isViewedActivityThread(row, snapshot.viewedThread))
          .map((row) => row.id),
      );
      const change = tracker.update(rows, Date.now(), suppressed);
      if (change) changes.push(change);
    }
    return changes.toSorted(
      (a, b) => priority[a.state] - priority[b.state] || a.rowId.localeCompare(b.rowId),
    )[0];
  }
}
