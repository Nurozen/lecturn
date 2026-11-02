/**
 * The expanded card's server-built parts (P7.3, D28): the evidence block, read live from the
 * target thread over what the card stored (the CI excerpt), the "Open in thread" message, and
 * the event timeline. Built per `squire.item.get`, so nothing here is copied into rows.
 */
import {
  squireMergeableFromSnapshot,
  type IsoDateTime,
  type MessageId,
  SquireEvidence,
  type SquireCardTrigger,
  type SquirePullRequestSnapshot,
  ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@lecturn/shared/threadPullRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type {
  SquireActionLogRow,
  SquireCardRow,
  SquireEventRow,
  SquireRepository,
} from "./SquireRepository.ts";
import { isHeadShaRevision } from "./squireEvents.ts";

export const SQUIRE_TIMELINE_LIMIT = 12;
const QUOTE_MAX_CHARS = 200;
const EVENT_STATUSES = ["deferred", "pending", "batched", "delivered", "dropped"] as const;

export interface SquireTimelineEntry {
  readonly at: IsoDateTime;
  readonly text: string;
}

type Checks = SquirePullRequestSnapshot["checks"];

const transitionOf = (snapshot: NonNullable<ThreadPullRequestLink["snapshot"]>) => {
  if (snapshot.state === "merged") return "merged";
  if (snapshot.state === "closed") return "closed";
  if (snapshot.checksState === "failing") return "checks:failed";
  if (snapshot.checksState === "passing") return "checks:passed";
  return snapshot.checksState === "pending" ? "checks:pending" : "linked";
};

/** The PR chips as the link holds them now; check counts only when read for this head. */
export function pullRequestEvidence(
  link: ThreadPullRequestLink,
  checks?: Checks,
): SquirePullRequestSnapshot | undefined {
  const snapshot = link.snapshot;
  if (snapshot === null || snapshot.headSha === undefined) return undefined;
  return {
    repository: link.repository,
    number: link.number,
    headSha: snapshot.headSha,
    transition: transitionOf(snapshot),
    baseBranch: snapshot.baseBranch,
    checks: checks ?? { passed: 0, failed: 0, failingJobs: [] },
    review: snapshot.reviewDecision ?? "none",
    mergeable: squireMergeableFromSnapshot(snapshot),
    merged: snapshot.state === "merged",
    closed: snapshot.state === "closed",
  };
}

/** The failing link first, since the card is about it; otherwise the first visible one. */
export const primaryLink = (links: ReadonlyArray<ThreadPullRequestLink>) => {
  const visible = visibleThreadPullRequests(links);
  return (
    visible.find(
      (link) => link.snapshot?.state === "open" && link.snapshot.checksState === "failing",
    ) ?? visible[0]
  );
};

const PR_STATE_KEY = /^(?<prKey>.+#(?<number>\d+)):(?<headSha>[^:]+):(?<state>.+)$/;

const PR_STATE_TEXT: Readonly<Record<string, string>> = {
  "checks:failed": "checks failed",
  "checks:passed": "checks passed",
  "review:approved": "review approved",
  "review:changes-requested": "changes requested",
  "review:review-required": "review required",
  "mergeable:mergeable": "mergeable",
  "mergeable:conflicting": "has conflicts",
  merged: "merged",
  closed: "closed",
};

const KIND_TEXT: Readonly<Record<string, string>> = {
  "turn-finished": "turn finished",
  "thread-stopped": "thread stopped",
  "waiting-on-user": "waiting on you",
};

/**
 * Oldest first, newest `limit` kept. Rows are per Squire, so a thread two Squires track has
 * each moment twice; a PR's first row on a new head also marks the push.
 */
export interface SquireCurrentHead {
  readonly prKey: string;
  readonly number: number;
  readonly headSha: string;
  readonly at: IsoDateTime;
  /** The link's state now, e.g. `checks:failed`, shown when no row recorded it on this head. */
  readonly transition?: string;
}

export function squireTimeline(
  rows: ReadonlyArray<Pick<SquireEventRow, "id" | "kind" | "state_key" | "created_at">>,
  options: {
    readonly limit?: number;
    /** The link's head now, which may have moved without a transition row. */
    readonly currentHeads?: ReadonlyArray<SquireCurrentHead>;
    /** Only the PR and CI moments, for a card that names several threads. */
    readonly pullRequestsOnly?: boolean;
  } = {},
): ReadonlyArray<SquireTimelineEntry> {
  const seen = new Set<string>();
  const unique = [...rows]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
    .filter((row) => {
      const key = `${row.kind}\u0000${row.state_key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const heads = new Map<string, string>();
  const entries: Array<SquireTimelineEntry> = [];
  const push = (at: string, prKey: string, number: string | number, headSha: string) => {
    // A provider with no head sha (Azure DevOps) keys by update time; that is no push.
    if (heads.get(prKey) === headSha || !isHeadShaRevision(headSha)) return;
    heads.set(prKey, headSha);
    entries.push({ at: at as IsoDateTime, text: `PR #${number} pushed ${headSha.slice(0, 7)}` });
  };
  const recorded = new Set<string>();
  for (const row of unique) {
    if (row.kind !== "pull-request-changed") {
      if (options.pullRequestsOnly) continue;
      entries.push({
        at: row.created_at as IsoDateTime,
        text: KIND_TEXT[row.kind] ?? row.kind.replaceAll("-", " "),
      });
      continue;
    }
    const match = PR_STATE_KEY.exec(row.state_key)?.groups;
    if (match === undefined) continue;
    const { prKey, number, headSha, state } = match as Record<
      "prKey" | "number" | "headSha" | "state",
      string
    >;
    recorded.add(row.state_key);
    push(row.created_at, prKey, number, headSha);
    entries.push({
      at: row.created_at as IsoDateTime,
      text: `PR #${number} ${PR_STATE_TEXT[state] ?? state.replace(":", " ")}`,
    });
  }
  for (const head of options.currentHeads ?? []) {
    push(head.at, head.prKey, head.number, head.headSha);
    const text = head.transition === undefined ? undefined : PR_STATE_TEXT[head.transition];
    if (text !== undefined && !recorded.has(`${head.prKey}:${head.headSha}:${head.transition}`)) {
      recorded.add(`${head.prKey}:${head.headSha}:${head.transition}`);
      entries.push({ at: head.at, text: `PR #${head.number} ${text}` });
    }
  }
  return byTime(entries).slice(-(options.limit ?? SQUIRE_TIMELINE_LIMIT));
}

/** The card's own lifecycle rows; a card can carry others (notifications, tool calls). */
export const SQUIRE_CARD_LOG_KINDS = [
  "card.created",
  "action.held",
  "action.executed",
  "action.undone",
  "action.cancelled",
] as const;

const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const logEntryText = (
  row: Pick<SquireActionLogRow, "kind" | "data_json">,
  raised: boolean,
): string | null => {
  const data = Option.getOrElse(
    decodeLogData(row.data_json),
    () => ({}) as Record<string, unknown>,
  );
  switch (row.kind) {
    case "card.created":
      if (data.updated === true) return "updated";
      return raised ? "back as a card" : "raised";
    case "action.held":
      if (data.updated === true) return "hold updated";
      return raised ? "held again" : "held to run";
    case "action.executed":
      return data.verb === "accept" ? "accepted" : "executed";
    case "action.undone":
      return "undone";
    case "action.cancelled":
      if (data.to === "dismissed") return "dismissed";
      if (data.to === "outdated") return "outdated";
      return "hold cancelled";
    default:
      return null;
  }
};

/** What the row's status says happened last, for a move no log row records. */
const terminalText = (card: Pick<SquireCardRow, "status" | "resolution">) => {
  switch (card.status) {
    case "resolved":
      return card.resolution === "accepted" ? "accepted" : "resolved";
    case "executed":
      return "executed";
    case "dismissed":
      return "dismissed";
    case "outdated":
      return card.resolution === "superseded" ? "replaced by a newer card" : "outdated";
    default:
      return null;
  }
};

const byTime = (entries: ReadonlyArray<SquireTimelineEntry>) =>
  entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.index - b.index)
    .map(({ entry }) => entry);

/**
 * P7.2: a card's own history from its action-log rows (raised, updated, held,
 * executed, undone, cancelled), plus when it was opened and how it settled when
 * no row records that. Oldest first, newest `limit` kept.
 */
export function squireCardTimeline(
  card: Pick<SquireCardRow, "status" | "resolution" | "opened_at" | "updated_at">,
  rows: ReadonlyArray<Pick<SquireActionLogRow, "id" | "kind" | "data_json" | "created_at">>,
  options: {
    readonly limit?: number;
    /** Entries from elsewhere, such as an overlap's threads, merged in by time. */
    readonly extra?: ReadonlyArray<SquireTimelineEntry>;
  } = {},
): ReadonlyArray<SquireTimelineEntry> {
  const entries: Array<SquireTimelineEntry> = [];
  let raised = false;
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const text = logEntryText(row, raised);
    if (text === null) continue;
    if (row.kind === "card.created" || row.kind === "action.held") raised = true;
    // Two writers can log one execution; it happened once.
    if (entries.at(-1)?.text === text && text !== "updated" && text !== "hold updated") continue;
    entries.push({ at: row.created_at as IsoDateTime, text });
  }
  if (card.opened_at !== null) entries.push({ at: card.opened_at as IsoDateTime, text: "opened" });
  const settled = terminalText(card);
  if (settled !== null) {
    const logged = new Set(entries.map((entry) => entry.text));
    const recorded = logged.has(settled) || (settled === "accepted" && logged.has("executed"));
    if (!recorded) entries.push({ at: card.updated_at as IsoDateTime, text: settled });
  }
  return byTime([...entries, ...(options.extra ?? [])]).slice(
    -(options.limit ?? SQUIRE_TIMELINE_LIMIT),
  );
}

const decodeOverlapThreads = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("overlap"),
      threads: Schema.Array(
        Schema.Struct({ threadId: ThreadId, pullRequest: Schema.optionalKey(Schema.Number) }),
      ),
    }),
  ),
);

const decodeEvidence = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvidence));

const quoteOf = (text: string) => {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > QUOTE_MAX_CHARS ? line.slice(0, QUOTE_MAX_CHARS) : line;
};

/** Each visible link's head and state now, which may have moved without a stored row. */
const headsOf = (links: ReadonlyArray<ThreadPullRequestLink>): ReadonlyArray<SquireCurrentHead> =>
  visibleThreadPullRequests(links).flatMap((link) =>
    link.snapshot?.headSha === undefined
      ? []
      : [
          {
            prKey: threadPullRequestKeyOf(link),
            number: link.number,
            headSha: link.snapshot.headSha,
            at: link.snapshot.syncedAt,
            transition: transitionOf(link.snapshot),
          },
        ],
  );

export interface SquireCardDetailParts {
  readonly evidence: SquireEvidence;
  readonly trigger: SquireCardTrigger;
  readonly timeline: ReadonlyArray<SquireTimelineEntry>;
}

export const makeSquireCardDetail = (deps: {
  readonly repository: SquireRepository["Service"];
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
}) => {
  const { repository, projections } = deps;

  /** D28: the run's last assistant message; none for a PR-only trigger. */
  const triggerMessage = (threadId: ThreadId, trigger: SquireCardTrigger) =>
    Effect.gen(function* () {
      if (trigger.triggerMessageId !== undefined || trigger.runId === undefined) {
        return Option.none<{ readonly id: MessageId; readonly text: string }>();
      }
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageRunIds: [trigger.runId],
        messageRoles: ["assistant"],
      });
      const message = messages.findLast((candidate) => candidate.text.trim().length > 0);
      return Option.fromNullishOr(message);
    }).pipe(Effect.orElseSucceed(() => Option.none()));

  /**
   * An overlap thread's latest moment and its PR and CI moments, named by the
   * thread, so the card shows where each stands. Only the PR the overlap names
   * counts: an earlier PR merged or closed before this change set began.
   */
  const threadMoments = (threadId: ThreadId, pullRequest: number | undefined) =>
    Effect.gen(function* () {
      const rows = (yield* repository.listEvents({ statuses: EVENT_STATUSES, threadId })).filter(
        (row) =>
          row.kind !== "pull-request-changed" ||
          Number(PR_STATE_KEY.exec(row.state_key)?.groups?.number) === pullRequest,
      );
      const shell = yield* projections.getThreadShell(threadId);
      const currentHeads = headsOf(shell?.pullRequests ?? []).filter(
        (head) => head.number === pullRequest,
      );
      const [latest] = squireTimeline(rows, { limit: 1, currentHeads });
      const moments = squireTimeline(rows, { currentHeads, pullRequestsOnly: true });
      const title = shell?.title.trim();
      return [...moments, ...(latest === undefined ? [] : [latest])]
        .filter(
          (entry, index, all) =>
            all.findIndex((other) => other.at === entry.at && other.text === entry.text) === index,
        )
        .map((entry) => ({ at: entry.at, text: title ? `${title}: ${entry.text}` : entry.text }));
    });

  /** A card without a target thread: its own log rows, and for an overlap each thread's latest. */
  const ownTimeline = (row: SquireCardRow) =>
    Effect.gen(function* () {
      const rows = yield* repository.listCardLog({
        cardId: row.id,
        kinds: SQUIRE_CARD_LOG_KINDS,
      });
      const threads =
        row.kind === "overlap"
          ? Option.match(decodeOverlapThreads(row.payload_json), {
              onNone: () => [],
              onSome: (payload) =>
                payload.threads.filter(
                  (thread, index, all) =>
                    all.findIndex((other) => other.threadId === thread.threadId) === index,
                ),
            })
          : [];
      const extra = yield* Effect.forEach(threads, (thread) =>
        threadMoments(thread.threadId, thread.pullRequest),
      );
      return squireCardTimeline(row, rows, { extra: extra.flat() });
    });

  const detail = Effect.fn("SquireCardDetail.detail")(function* (
    row: SquireCardRow,
    trigger: SquireCardTrigger,
  ) {
    const stored = Option.getOrElse(decodeEvidence(row.evidence_json), (): SquireEvidence => ({}));
    if (row.target_thread_id === null) {
      return {
        evidence: stored,
        trigger,
        timeline: yield* ownTimeline(row),
      } satisfies SquireCardDetailParts;
    }
    const threadId = row.target_thread_id;
    const shell = yield* projections.getThreadShell(threadId);
    const links = shell?.pullRequests ?? [];
    const link = primaryLink(links);
    const snapshot = link?.snapshot ?? null;
    const storedPr = stored.pullRequest;
    const live =
      link === undefined
        ? undefined
        : pullRequestEvidence(
            link,
            storedPr !== undefined &&
              storedPr.number === link.number &&
              storedPr.headSha === snapshot?.headSha
              ? storedPr.checks
              : undefined,
          );
    const headBranch = snapshot?.headBranch ?? shell?.branch ?? stored.headBranch;
    const diffStats =
      snapshot?.additions !== undefined &&
      snapshot.deletions !== undefined &&
      snapshot.changedFiles !== undefined
        ? {
            insertions: snapshot.additions,
            deletions: snapshot.deletions,
            files: snapshot.changedFiles,
          }
        : stored.diffStats;
    const pullRequest = live ?? storedPr;
    const evidence: SquireEvidence = {
      ...stored,
      ...(headBranch == null ? {} : { headBranch }),
      ...(diffStats === undefined ? {} : { diffStats }),
      ...(pullRequest === undefined ? {} : { pullRequest }),
    };

    const message = shell === null ? Option.none() : yield* triggerMessage(threadId, trigger);
    const resolvedTrigger: SquireCardTrigger = Option.match(message, {
      onNone: () => trigger,
      onSome: (found) => {
        const quote = trigger.quote ?? quoteOf(found.text);
        return {
          ...trigger,
          triggerMessageId: found.id,
          ...(quote.length === 0 ? {} : { quote }),
        };
      },
    });

    const rows = yield* repository.listEvents({ statuses: EVENT_STATUSES, threadId });
    const timeline = squireTimeline(rows, { currentHeads: headsOf(links) });
    return { evidence, trigger: resolvedTrigger, timeline } satisfies SquireCardDetailParts;
  });

  return { detail };
};
