/**
 * The Lead's overlap risk items: deterministic server logic run
 * when a summary is stored and when a thread's PR, settle, archive, delete,
 * or branch state changes. Two tracked threads, tracked by any Squires
 * (including the same one), overlap when their open change sets share a
 * (repository identity, repo-relative path). Items are raised under the
 * Lead's name and never wake it.
 *
 * Owner: `owner_squire_id` is the owning Squire of the thread the
 * recommendation lands first; every thread's own Squire is in the payload
 * (`threads[].squireId`), which is where the intersection is taken per thread.
 *
 * @module squire/SquireOverlap
 */
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type RunId,
  SquireCardId,
  SquireCardPayload,
  type SquireId,
  SquireTurnSummary,
  ThreadId,
  TrimmedNonEmptyString,
  isUnknownUnionMember,
} from "@lecturn/contracts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { SquireHooks } from "./squireHooks.ts";
import { isFixtureWorkspaceRoot } from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import { parseSquireNameStatus } from "./SquireSummaryInput.ts";
import { isSquireThread } from "./squireThread.ts";
import {
  type SquireToolContext,
  type SquireToolHandler,
  type SquireToolKit,
  SquireToolRegistry,
} from "./squireToolKit.ts";

export type SquireOverlapError = PersistenceSqlError | SquireScope.SquireScopeError;

export class SquireOverlap extends Context.Service<
  SquireOverlap,
  {
    /** Raises, grows, shrinks, or outdates the overlap items of pairs that include the thread. */
    readonly detect: (threadId: ThreadId) => Effect.Effect<void, SquireOverlapError>;
    /** Re-checks the thread's open overlap items after a PR, settle, archive, delete, or branch change. */
    readonly onThreadChanged: (threadId: ThreadId) => Effect.Effect<void, SquireOverlapError>;
  }
>()("lecturn/squire/SquireOverlap") {}

/** Shared lockfiles say nothing about colliding work. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "Package.resolved",
  "flake.lock",
  "packages.lock.json",
  "gradle.lockfile",
]);

const normalizePath = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "");
const isLockfile = (path: string) => LOCKFILES.has(normalizePath(path).split("/").at(-1) ?? "");

/** Repository identity plus the unordered thread set. */
export const overlapDedupeKey = (identity: string, threadIds: ReadonlyArray<ThreadId>) =>
  `overlap:${identity}:${[...new Set(threadIds)].toSorted().join("|")}`;

// FNV-1a, so card ids stay short and stable for a dedupe key.
const shortHash = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
};

const decodeSummary = Schema.decodeUnknownOption(Schema.fromJsonString(SquireTurnSummary));
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardPayload));
const encodePayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBranchData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ branch: Schema.String })),
);
const decodeEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ source: Schema.optionalKey(Schema.String) })),
);

type OverlapPayload = Extract<SquireCardPayload, { readonly type: "overlap" }>;

const overlapPayloadOf = (card: SquireRepository.SquireCardRow): OverlapPayload | null => {
  const payload = Option.getOrNull(decodePayload(card.payload_json));
  if (payload === null || isUnknownUnionMember(payload)) return null;
  return payload.type === "overlap" ? payload : null;
};

/** Model-raised items keep the model's paths; only expiry applies to them. */
const isToolCard = (card: SquireRepository.SquireCardRow) =>
  Option.getOrNull(decodeEvidence(card.evidence_json))?.source === "tool";

const BRANCH_KIND = "overlap.branch";
const SUMMARY_WINDOW = 200;
/**
 * A stored summary is compared only with threads summarized this recently,
 * at most CANDIDATE_LIMIT of them, so its cost does not grow with history. A
 * quiet thread is compared again when either side next stores a summary.
 */
export const OVERLAP_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const OVERLAP_CANDIDATE_LIMIT = 100;

interface PullRequestRank {
  readonly number: number;
  /** Higher is further along: open, then approved, passing, mergeable; drafts last. */
  readonly score: number;
}

interface InRangeSummary {
  readonly runId: RunId;
  readonly identity: string;
  readonly paths: ReadonlyArray<string>;
}

interface ThreadState {
  readonly threadId: ThreadId;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly title: string;
  /** The driver the thread runs on now, so every surface names the same provider. */
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly branch: string | null;
  readonly owner: SquireId | null;
  /** Why the thread no longer has an open change set; null while it does. */
  readonly out: "deleted" | "archived" | "settled" | "untracked" | null;
  /** Its change boundary (last PR merge or close, or head-branch change), epoch ms. */
  readonly boundary: number;
  readonly pr: PullRequestRank | null;
  readonly inRange: ReadonlyArray<InRangeSummary>;
}

const isSettled = (shell: OrchestrationV2ThreadShell) =>
  shell.settledOverride === "settled" || shell.settledAt !== null;

const msOf = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** The recommended landing order: further-along PR first, then older PR, then thread id. */
const landingOrder = (a: ThreadState, b: ThreadState) =>
  (b.pr?.score ?? -1) - (a.pr?.score ?? -1) ||
  (a.pr?.number ?? Number.MAX_SAFE_INTEGER) - (b.pr?.number ?? Number.MAX_SAFE_INTEGER) ||
  (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);

const recommendationFor = (ordered: ReadonlyArray<ThreadState>) => {
  const [first, ...rest] = ordered;
  if (first === undefined) return "";
  const lead = first.pr === null ? first.title : `#${first.pr.number}`;
  return `Land ${lead} first, then rebase ${rest.map((state) => state.title).join(" and ")}`;
};

const listPaths = (paths: ReadonlyArray<string>) =>
  paths.length <= 3
    ? paths.join(", ")
    : `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;

const sortedUnique = (paths: Iterable<string>) => [...new Set(paths)].toSorted();

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const rankFromLink = (
  link: NonNullable<OrchestrationV2ThreadShell["pullRequests"]>[number],
): PullRequestRank => {
  const snapshot = link.snapshot;
  if (snapshot === null) return { number: link.number, score: 16 };
  return {
    number: link.number,
    score:
      16 +
      (snapshot.reviewDecision === "approved" ? 4 : 0) +
      (snapshot.checksState === "passing" ? 2 : 0) +
      (snapshot.mergeability === "mergeable" ? 1 : 0) -
      (snapshot.isDraft ? 8 : 0),
  };
};

const rankFromSummary = (
  pullRequest: NonNullable<SquireTurnSummary["pullRequest"]>,
): PullRequestRank => ({
  number: pullRequest.number,
  score:
    16 +
    (pullRequest.review === "approved" ? 4 : 0) +
    (pullRequest.checks.failed === 0 && pullRequest.checks.passed > 0 ? 2 : 0) +
    (pullRequest.mergeable === "mergeable" ? 1 : 0),
});

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* SquireScope.SquireScope;
  const hooks = yield* SquireHooks;
  const registry = yield* SquireToolRegistry;
  const checkpoints = yield* Effect.serviceOption(CheckpointStore.CheckpointStore);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const providerInstances = yield* Effect.serviceOption(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
  );
  // A summary declares the driver its turn reported; a fixture thread declares one it does not
  // run on, so the thread's own instance decides when it is known.
  const driverOf = (instanceId: ProviderInstanceId) =>
    Option.isNone(providerInstances)
      ? Effect.succeed(undefined)
      : providerInstances.value
          .getInstance(instanceId)
          .pipe(Effect.map((instance) => instance?.driverKind));
  const isFixtureProject = (projectId: ProjectId) =>
    Option.isNone(config) || Option.isNone(projects)
      ? Effect.succeed(false)
      : projects.value
          .get(projectId, { includeDeleted: true })
          .pipe(
            Effect.map(
              (project) =>
                Option.isSome(project) &&
                isFixtureWorkspaceRoot(config.value.baseDir, project.value.workspaceRoot),
            ),
          );
  // One writer at a time, so two summaries stored together never race the
  // open (kind, dedupe_key) index or lose each other's merged paths.
  const lock = Semaphore.makeUnsafe(1);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * Paths the cumulative checkpoint `name-status` diff from before the first
   * in-range run to the latest checkpoint still touches ("its latest diff").
   * None when the thread has no usable checkpoints (fixtures): the summary
   * union stands alone.
   */
  const touchedPaths = Effect.fn("SquireOverlap.touchedPaths")(
    function* (threadId: ThreadId, projectId: ProjectId | null, runIds: ReadonlySet<RunId>) {
      if (Option.isNone(checkpoints) || runIds.size === 0) return Option.none<Set<string>>();
      // A fixture thread's scripted turns change nothing on disk; its summaries stand alone.
      if (projectId !== null && (yield* isFixtureProject(projectId))) {
        return Option.none<Set<string>>();
      }
      const records = yield* projections.getThreadRecords(threadId, [
        "checkpoints",
        "checkpointScopes",
      ]);
      const usable = records.checkpoints.filter(
        (checkpoint) =>
          (checkpoint.status === "ready" || checkpoint.status === "stale") &&
          checkpoint.runId !== null,
      );
      const first = usable
        .filter((checkpoint) => checkpoint.runId !== null && runIds.has(checkpoint.runId))
        .toSorted((a, b) => a.ordinalWithinScope - b.ordinalWithinScope)[0];
      if (first === undefined) return Option.none<Set<string>>();
      const latest = usable
        .filter((checkpoint) => checkpoint.scopeId === first.scopeId)
        .toSorted((a, b) => b.ordinalWithinScope - a.ordinalWithinScope)[0];
      const parent = records.checkpoints.find(
        (checkpoint) => checkpoint.id === first.parentCheckpointId,
      );
      const checkpointScope = records.checkpointScopes.find(
        (candidate) => candidate.id === first.scopeId,
      );
      if (latest === undefined || parent === undefined || checkpointScope === undefined) {
        return Option.none<Set<string>>();
      }
      const diff = yield* checkpoints.value.diffCheckpoints({
        cwd: checkpointScope.cwd,
        fromCheckpointRef: parent.ref,
        toCheckpointRef: latest.ref,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
        format: "name-status",
      });
      return Option.some(
        new Set(parseSquireNameStatus(diff).map((file) => normalizePath(file.path))),
      );
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Squire overlap checkpoint diff failed", {
            threadId,
            cause: String(cause),
          }).pipe(Effect.as(Option.none<Set<string>>())),
        ),
      ),
  );

  /** Per operation: the Lead, its overlap cards, branch rows, and memoized thread reads. */
  const session = Effect.fn("SquireOverlap.session")(function* (
    lead: SquireRepository.SquireRow,
    storedThreadId: ThreadId | null,
  ) {
    const squires = new Map((yield* repository.listSquires).map((row) => [row.id, row]));
    const cards = [...(yield* repository.listCards({ squireId: lead.id, kinds: ["overlap"] }))];
    const branchRows = new Map<ThreadId, Array<SquireRepository.SquireActionLogRow>>();
    for (const row of yield* repository.listActionLog({
      squireId: lead.id,
      kinds: [BRANCH_KIND],
      limit: 100_000,
    })) {
      if (row.thread_id === null) continue;
      branchRows.set(row.thread_id, [...(branchRows.get(row.thread_id) ?? []), row]);
    }
    const states = new Map<ThreadId, ThreadState | null>();
    const touched = new Map<ThreadId, Option.Option<Set<string>>>();

    /** Records a head-branch change; the latest change is the branch boundary. */
    const branchBoundary = Effect.fn("SquireOverlap.branchBoundary")(function* (
      threadId: ThreadId,
      branch: string,
      newestSummaryAt: number,
      now: string,
    ) {
      const rows = branchRows.get(threadId) ?? [];
      const last = rows.at(-1);
      const lastBranch = last ? Option.getOrNull(decodeBranchData(last.data_json))?.branch : null;
      if (last === undefined || lastBranch !== branch) {
        // A change first seen when a summary is stored belongs to that run,
        // so the boundary sits just before that summary.
        const at =
          last !== undefined && threadId === storedThreadId && Number.isFinite(newestSummaryAt)
            ? DateTime.formatIso(DateTime.makeUnsafe(Math.min(msOf(now), newestSummaryAt - 1)))
            : now;
        const row = {
          squire_id: lead.id,
          kind: BRANCH_KIND,
          room_id: null,
          post_id: null,
          trigger_id: null,
          task_id: null,
          thread_id: threadId,
          card_id: null,
          event_id: null,
          run_id: null,
          invocation_key: null,
          execution_key: null,
          data_json: encodeJson({ branch }),
          created_at: at,
        };
        const id = yield* repository.insertActionLog(row);
        rows.push({ ...row, id });
        branchRows.set(threadId, rows);
      }
      return rows.length >= 2 ? msOf(rows.at(-1)?.created_at) : Number.NEGATIVE_INFINITY;
    });

    const load = Effect.fn("SquireOverlap.load")(function* (threadId: ThreadId) {
      if (states.has(threadId)) return states.get(threadId) ?? null;
      const shell = yield* projections.getThreadShell(threadId);
      if (shell !== null && isSquireThread(shell)) {
        states.set(threadId, null);
        return null;
      }
      const trackers = shell === null ? [] : yield* scope.trackersOf(threadId);
      const active = trackers.find((id) => squires.get(id)?.status === "active");
      const summaries = (yield* repository.listThreadSummaries({
        threadId,
        limit: SUMMARY_WINDOW,
      })).flatMap((row) => {
        const summary = Option.getOrNull(decodeSummary(row.summary_json));
        return summary === null ? [] : [{ row, summary }];
      });
      const newest = summaries[0];

      let boundary = Number.NEGATIVE_INFINITY;
      let pr: PullRequestRank | null = null;
      // A thread without its own branch is named by its linked PR's head branch.
      let prHead: string | null = null;
      const links = (shell?.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed");
      if (links.length > 0) {
        for (const link of links) {
          const state = link.snapshot?.state ?? "open";
          if (state === "open") {
            const rank = rankFromLink(link);
            if (pr === null || rank.score > pr.score) {
              pr = rank;
              prHead = link.snapshot?.headBranch ?? prHead;
            }
            continue;
          }
          if (pr === null) prHead = link.snapshot?.headBranch ?? prHead;
          const snapshot = link.snapshot;
          const at = msOf(snapshot?.mergedAt ?? snapshot?.closedAt ?? snapshot?.syncedAt);
          boundary = Math.max(boundary, at);
        }
      } else {
        // Fixture threads carry their PR only in the summary.
        const withPr = summaries.find((entry) => entry.summary.pullRequest !== null);
        const pullRequest = withPr?.summary.pullRequest;
        if (withPr !== undefined && pullRequest) {
          if (pullRequest.merged || pullRequest.closed) {
            boundary = Math.max(boundary, msOf(withPr.row.created_at));
          } else {
            pr = rankFromSummary(pullRequest);
          }
        }
      }
      if (shell !== null && shell.deletedAt === null && shell.archivedAt === null) {
        boundary = Math.max(
          boundary,
          yield* branchBoundary(
            threadId,
            shell.branch ?? "",
            msOf(newest?.row.created_at),
            yield* nowIso,
          ),
        );
      }

      const inRange = summaries
        .filter((entry) => msOf(entry.row.created_at) > boundary)
        .map((entry): InRangeSummary => ({
          runId: entry.row.run_id,
          identity: entry.summary.projectId ?? shell?.projectId ?? entry.summary.project,
          paths: entry.summary.files.entries
            .map((file) => normalizePath(file.path))
            .filter((path) => !isLockfile(path)),
        }));
      const instanceDriver = shell === null ? undefined : yield* driverOf(shell.providerInstanceId);
      const state: ThreadState = {
        threadId,
        shell,
        title: shell?.title || newest?.summary.threadTitle || threadId,
        provider:
          instanceDriver ??
          newest?.summary.provider ??
          ProviderDriverKind.make(shell?.providerInstanceId ?? "unknown"),
        providerInstanceId: shell?.providerInstanceId ?? null,
        branch: shell?.branch ?? prHead,
        owner: active ?? trackers[0] ?? null,
        out:
          shell === null || shell.deletedAt !== null
            ? "deleted"
            : shell.archivedAt !== null
              ? "archived"
              : isSettled(shell)
                ? "settled"
                : trackers.length === 0
                  ? "untracked"
                  : null,
        boundary,
        pr,
        inRange,
      };
      states.set(threadId, state);
      return state;
    });

    /** The thread's open change set for one repository, minus paths its latest diff dropped. */
    const changeSet = Effect.fn("SquireOverlap.changeSet")(function* (
      state: ThreadState,
      identity: string,
      withTouched: boolean,
    ) {
      const paths = new Set(
        state.inRange
          .filter((entry) => entry.identity === identity)
          .flatMap((entry) => entry.paths),
      );
      if (!withTouched || paths.size === 0) return paths;
      let latest = touched.get(state.threadId);
      if (latest === undefined) {
        latest = yield* touchedPaths(
          state.threadId,
          state.shell?.projectId ?? null,
          new Set(state.inRange.map((entry) => entry.runId)),
        );
        touched.set(state.threadId, latest);
      }
      if (Option.isNone(latest)) return paths;
      const still = latest.value;
      return new Set([...paths].filter((path) => still.has(path)));
    });

    const identitiesOf = (state: ThreadState) =>
      new Set(state.inRange.map((entry) => entry.identity));

    /** Paths of the pair's dismissed (or accepted) items never re-raise. */
    const remembered = (key: string) =>
      new Set(
        cards
          .filter(
            (card) =>
              card.dedupe_key === key &&
              (card.status === "dismissed" || card.status === "resolved"),
          )
          .flatMap((card) => overlapPayloadOf(card)?.paths ?? []),
      );

    const openCards = () =>
      cards.filter((card) => card.status === "open" && overlapPayloadOf(card) !== null);

    return {
      lead,
      cards,
      load,
      changeSet,
      identitiesOf,
      remembered,
      openCards,
    };
  });

  type Session = Effect.Success<ReturnType<typeof session>>;

  /** Shared paths for a detector pair, or null when either thread has no open change set. */
  const sharedPaths = Effect.fn("SquireOverlap.sharedPaths")(function* (
    s: Session,
    a: ThreadState,
    b: ThreadState,
    identity: string,
  ) {
    if (a.out !== null || b.out !== null) return null;
    const cheapA = yield* s.changeSet(a, identity, false);
    const cheapB = yield* s.changeSet(b, identity, false);
    if (![...cheapA].some((path) => cheapB.has(path))) return [];
    const setA = yield* s.changeSet(a, identity, true);
    const setB = yield* s.changeSet(b, identity, true);
    const dropped = s.remembered(overlapDedupeKey(identity, [a.threadId, b.threadId]));
    return sortedUnique([...setA].filter((path) => setB.has(path) && !dropped.has(path)));
  });

  const payloadFor = (
    identity: string,
    ordered: ReadonlyArray<ThreadState>,
    paths: ReadonlyArray<string>,
    recommendation: string,
  ): OverlapPayload => ({
    type: "overlap",
    repository: TrimmedNonEmptyString.make(identity),
    threads: ordered.map((state) => ({
      threadId: state.threadId,
      // Only tracked threads reach here, so each has its own Squire.
      squireId: state.owner as SquireId,
      branch: state.branch,
      ...(state.pr === null ? {} : { pullRequest: state.pr.number }),
      provider: state.provider,
      ...(state.providerInstanceId === null
        ? {}
        : { providerInstanceId: state.providerInstanceId }),
    })),
    paths: paths.map((path) => TrimmedNonEmptyString.make(path)),
    recommendation,
  });

  const textFor = (ordered: ReadonlyArray<ThreadState>, paths: ReadonlyArray<string>) => ({
    title: `Overlap: ${ordered.map((state) => state.title).join(" and ")}`,
    why: `Both changed ${listPaths(paths)}, and neither change has merged.`,
  });

  const logCard = (
    s: Session,
    cardId: SquireCardId,
    data: Record<string, unknown>,
    now: string,
    extra: { readonly runId?: string | null; readonly invocationKey?: string | null } = {},
  ) =>
    repository.insertActionLog({
      squire_id: s.lead.id,
      kind: "card.created",
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: cardId,
      event_id: null,
      run_id: extra.runId ?? null,
      invocation_key: extra.invocationKey ?? null,
      execution_key: null,
      data_json: encodeJson({ kind: "overlap", origin: "lead", ...data }),
      created_at: now,
    });

  const insertCard = Effect.fn("SquireOverlap.insertCard")(function* (
    s: Session,
    input: {
      readonly id: SquireCardId;
      readonly key: string;
      readonly identity: string;
      readonly ordered: ReadonlyArray<ThreadState>;
      readonly paths: ReadonlyArray<string>;
      readonly recommendation: string;
      readonly why?: string;
      readonly source: "detector" | "tool";
      readonly now: string;
    },
  ) {
    const first = input.ordered[0];
    const text = textFor(input.ordered, input.paths);
    const row: SquireRepository.SquireCardRow = {
      id: input.id,
      squire_id: s.lead.id,
      owner_squire_id: first?.owner ?? s.lead.id,
      kind: "overlap",
      status: "open",
      target_thread_id: null,
      project_id:
        first?.shell?.projectId === input.identity ? ProjectId.make(input.identity) : null,
      title: text.title,
      why: input.why ?? text.why,
      payload_json: encodePayload(
        payloadFor(input.identity, input.ordered, input.paths, input.recommendation),
      ),
      evidence_json: encodeJson({ source: input.source }),
      trigger_json: "{}",
      intent_json: null,
      origin: "lead",
      steer_kind: null,
      routed_task_id: null,
      rule_id: null,
      finding_key: null,
      escalate_at: null,
      opened_at: null,
      executes_at: null,
      attempt: 0,
      command_id: null,
      execution_key: null,
      dedupe_key: input.key,
      replaced_count: 0,
      ask_json: null,
      resolution: null,
      created_at: input.now,
      updated_at: input.now,
    };
    yield* repository.insertCard(row);
    s.cards.push(row);
    return row;
  });

  /** New paths mark the item "updated"; a shrink only rewrites it. */
  const rewriteCard = Effect.fn("SquireOverlap.rewriteCard")(function* (
    s: Session,
    card: SquireRepository.SquireCardRow,
    ordered: ReadonlyArray<ThreadState>,
    paths: ReadonlyArray<string>,
    recommendation: string,
    now: string,
  ) {
    const before = overlapPayloadOf(card);
    if (before === null) return false;
    const grew = paths.some((path) => !before.paths.includes(TrimmedNonEmptyString.make(path)));
    if (sameSet(sortedUnique(before.paths), paths) && before.recommendation === recommendation) {
      return false;
    }
    const replacedCount = card.replaced_count + (grew ? 1 : 0);
    const text = textFor(ordered, paths);
    const updated = yield* repository.updateCard({
      id: card.id,
      fromStatuses: ["open"],
      patch: {
        title: text.title,
        why: isToolCard(card) ? card.why : text.why,
        owner_squire_id: ordered[0]?.owner ?? card.owner_squire_id,
        payload_json: encodePayload(payloadFor(before.repository, ordered, paths, recommendation)),
        replaced_count: replacedCount,
      },
      updatedAt: now,
    });
    if (Option.isSome(updated)) {
      const index = s.cards.findIndex((candidate) => candidate.id === card.id);
      if (index >= 0) s.cards[index] = updated.value;
      if (grew) {
        yield* logCard(s, card.id, { updated: true, replacedCount, paths }, now);
      }
    }
    return grew;
  });

  const outdateCard = Effect.fn("SquireOverlap.outdateCard")(function* (
    s: Session,
    card: SquireRepository.SquireCardRow,
    now: string,
  ) {
    const updated = yield* repository.updateCard({
      id: card.id,
      fromStatuses: ["open"],
      patch: { status: "outdated", resolution: "outdated" },
      updatedAt: now,
    });
    if (Option.isSome(updated)) {
      const index = s.cards.findIndex((candidate) => candidate.id === card.id);
      if (index >= 0) s.cards[index] = updated.value;
    }
  });

  /**
   * Obsolescence for one open item: outdated when a thread left (merged or closed PR,
   * settled, archived, deleted, untracked) or its change boundary moved past
   * the item; otherwise a detector item follows its current shared paths and
   * outdates when none remain. An ordinary new turn changes neither.
   */
  const reconcile = Effect.fn("SquireOverlap.reconcile")(function* (
    s: Session,
    card: SquireRepository.SquireCardRow,
    now: string,
  ) {
    const payload = overlapPayloadOf(card);
    if (payload === null) return;
    const states: Array<ThreadState> = [];
    for (const thread of payload.threads) {
      const state = yield* s.load(thread.threadId);
      if (state === null || state.out !== null || state.boundary >= msOf(card.created_at)) {
        return yield* outdateCard(s, card, now);
      }
      states.push(state);
    }
    const ordered = states.toSorted(landingOrder);
    if (isToolCard(card)) {
      yield* rewriteCard(
        s,
        card,
        ordered,
        sortedUnique(payload.paths),
        payload.recommendation,
        now,
      );
      return;
    }
    const [a, b] = states;
    if (a === undefined || b === undefined) return yield* outdateCard(s, card, now);
    const shared = (yield* sharedPaths(s, a, b, payload.repository)) ?? [];
    if (shared.length === 0) return yield* outdateCard(s, card, now);
    yield* rewriteCard(s, card, ordered, shared, recommendationFor(ordered), now);
  });

  const involves = (card: SquireRepository.SquireCardRow, threadId: ThreadId) =>
    overlapPayloadOf(card)?.threads.some((thread) => thread.threadId === threadId) ?? false;

  const withLead = Effect.fn("SquireOverlap.withLead")(function* <A, E, R>(
    body: (s: Session) => Effect.Effect<A, E, R>,
    storedThreadId: ThreadId | null = null,
  ): Effect.fn.Return<A | undefined, E | SquireOverlapError, R> {
    const lead = yield* repository.getLead;
    // Only the Lead raises overlap items; without one there is no queue to hold them.
    if (Option.isNone(lead) || lead.value.lifecycle === "deleting") return undefined;
    return yield* body(yield* session(lead.value, storedThreadId));
  });

  const detect: SquireOverlap["Service"]["detect"] = (threadId) =>
    withLead(
      (s) =>
        Effect.gen(function* () {
          const now = yield* nowIso;
          const self = yield* s.load(threadId);
          if (self === null) return;
          const handled = new Set<string>();
          if (self.out === null) {
            // Open items with quieter threads are re-checked by the reconcile below.
            const candidates = yield* repository.listRecentlySummarizedThreadIds({
              since: DateTime.formatIso(
                DateTime.makeUnsafe(Date.parse(now) - OVERLAP_ACTIVE_WINDOW_MS),
              ),
              limit: OVERLAP_CANDIDATE_LIMIT,
            });
            for (const otherId of candidates) {
              if (otherId === threadId) continue;
              const other = yield* s.load(otherId);
              if (other === null || other.out !== null) continue;
              const ordered = [self, other].toSorted(landingOrder);
              for (const identity of s.identitiesOf(self)) {
                if (!s.identitiesOf(other).has(identity)) continue;
                const key = overlapDedupeKey(identity, [threadId, otherId]);
                const shared = (yield* sharedPaths(s, self, other, identity)) ?? [];
                const open = s
                  .openCards()
                  .find((card) => card.dedupe_key === key && card.kind === "overlap");
                if (open !== undefined) {
                  handled.add(open.id);
                  if (shared.length === 0) {
                    if (!isToolCard(open)) yield* outdateCard(s, open, now);
                    continue;
                  }
                  const merged = isToolCard(open)
                    ? sortedUnique([...(overlapPayloadOf(open)?.paths ?? []), ...shared])
                    : shared;
                  yield* repository.transaction(
                    rewriteCard(
                      s,
                      open,
                      ordered,
                      merged,
                      isToolCard(open)
                        ? (overlapPayloadOf(open)?.recommendation ?? recommendationFor(ordered))
                        : recommendationFor(ordered),
                      now,
                    ),
                  );
                  continue;
                }
                if (shared.length === 0) continue;
                // The retention prune deletes old settled items, so a count can
                // land on an id a kept item still holds.
                const taken = new Set<string>(s.cards.map((card) => card.id));
                let generation = s.cards.filter((card) => card.dedupe_key === key).length;
                const idFor = (n: number) =>
                  SquireCardId.make(`card:overlap:${s.lead.id}:${shortHash(key)}:${n}`);
                while (taken.has(idFor(generation))) generation++;
                const id = idFor(generation);
                yield* repository.transaction(
                  Effect.gen(function* () {
                    yield* insertCard(s, {
                      id,
                      key,
                      identity,
                      ordered,
                      paths: shared,
                      recommendation: recommendationFor(ordered),
                      source: "detector",
                      now,
                    });
                    yield* logCard(s, id, { dedupeKey: key, paths: shared }, now);
                  }),
                );
              }
            }
          }
          for (const card of s.openCards()) {
            if (handled.has(card.id) || !involves(card, threadId)) continue;
            yield* reconcile(s, card, now);
          }
        }),
      threadId,
    ).pipe(lock.withPermits(1), Effect.asVoid);

  const onThreadChanged: SquireOverlap["Service"]["onThreadChanged"] = (threadId) =>
    withLead((s) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        // Loading records a head-branch change even before any item exists.
        yield* s.load(threadId);
        for (const card of s.openCards()) {
          if (involves(card, threadId)) yield* reconcile(s, card, now);
        }
      }),
    ).pipe(lock.withPermits(1), Effect.asVoid);

  // ── squire_raise_overlap ──

  const RaiseOverlapArgs = Schema.Struct({
    threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    reason: Schema.String,
    recommendation: Schema.String,
  });

  const raiseOverlap = Effect.fn("SquireOverlap.raiseOverlap")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
  ) {
    const decoded = yield* kit.decodeArgs(RaiseOverlapArgs, ctx.args);
    if (!decoded.ok) {
      return yield* kit.refuse(
        ctx,
        "invalid-arguments",
        `Invalid arguments for ${ctx.tool}: ${decoded.message}`,
      );
    }
    const args = decoded.value;
    const threadIds = [...new Set(args.threadIds)].toSorted();
    if (threadIds.length < 2) {
      return yield* kit.refuse(ctx, "invalid-arguments", "Name at least two different threads.");
    }
    return yield* withLead((s) =>
      Effect.gen(function* () {
        const states: Array<ThreadState> = [];
        for (const threadId of threadIds) {
          const state = yield* s.load(threadId);
          if (state === null || state.out !== null || state.shell === null) {
            return yield* kit.refuse(
              ctx,
              "scope",
              `${threadId} is not a tracked thread with unmerged changes.`,
              { threadId },
            );
          }
          states.push(state);
        }
        const identity = sortedUnique(
          states.map((state) => state.shell?.projectId ?? state.threadId),
        ).join("+");
        const key = overlapDedupeKey(identity, threadIds);
        const dropped = s.remembered(key);
        const paths = sortedUnique(
          args.paths.map(normalizePath).filter((path) => !isLockfile(path) && !dropped.has(path)),
        );
        if (paths.length === 0) {
          return yield* kit.refuse(
            ctx,
            "dismissed",
            "The user already dismissed these paths for these threads, or they are lockfiles.",
          );
        }
        const ordered = states.toSorted(landingOrder);
        const recommendation = args.recommendation.trim() || recommendationFor(ordered);
        const open = s.openCards().find((card) => card.dedupe_key === key);
        return yield* kit.commit(
          ctx,
          null,
          Effect.gen(function* () {
            if (open !== undefined) {
              const merged = sortedUnique([...(overlapPayloadOf(open)?.paths ?? []), ...paths]);
              const grew = yield* rewriteCard(s, open, ordered, merged, recommendation, ctx.now);
              return {
                result: kit.ok(
                  grew ? "Merged the paths into the open overlap item." : "Already raised.",
                  { outcome: grew ? "updated" : "unchanged", cardId: open.id },
                ),
              };
            }
            const id = SquireCardId.make(`card:overlap:${s.lead.id}:${ctx.key.slice(0, 24)}`);
            yield* insertCard(s, {
              id,
              key,
              identity,
              ordered,
              paths,
              recommendation,
              ...(args.reason.trim() ? { why: args.reason.trim() } : {}),
              source: "tool",
              now: ctx.now,
            });
            yield* kit.logRow(
              ctx,
              "card.created",
              { kind: "overlap", origin: "lead", dedupeKey: key, paths },
              { cardId: id },
            );
            // The Lead's own items never wake it.
            return {
              result: kit.ok("Raised an overlap item.", { outcome: "raised", cardId: id }),
            };
          }),
        );
      }),
    ).pipe(
      Effect.map((result) => result ?? kit.refused("no-lead", "There is no Lead to raise it.")),
      lock.withPermits(1),
    );
  });

  const raiseOverlapHandler: SquireToolHandler = {
    definition: {
      name: "squire_raise_overlap",
      description:
        "Raise an overlap risk item when tracked threads change the same files and neither change has merged. Deduped per repository and thread set; new paths merge into the open item.",
      inputSchema: {
        type: "object",
        properties: {
          threadIds: {
            type: "array",
            items: { type: "string" },
            description: "Two or more tracked threads whose changes collide.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative paths both threads changed.",
          },
          reason: { type: "string", description: "Why they collide, citing the summaries." },
          recommendation: {
            type: "string",
            description: "The landing order, e.g. `Land #318 first, then rebase <thread>`.",
          },
        },
        required: ["threadIds", "paths", "reason", "recommendation"],
        additionalProperties: false,
      },
    },
    roles: ["lead"],
    call: raiseOverlap,
  };

  yield* registry.register([raiseOverlapHandler]);
  yield* hooks.onSummaryStored((stored) => detect(stored.threadId).pipe(Effect.orDie));
  yield* hooks.onThreadChanged((threadId) => onThreadChanged(threadId).pipe(Effect.orDie));

  return SquireOverlap.of({ detect, onThreadChanged });
});

export const layer = Layer.effect(SquireOverlap, make);
