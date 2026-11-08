/**
 * A funded rule (e) post commits with routing `pending` and the Lead's row deferred +5 s. A valid answer before the
 * deadline retargets (compare-and-set on `pending`); at the deadline the clock releases the Lead row; errors and
 * unfunded states fall back at once; a late answer is ignored. Without the cloud client every post routes by rules.
 */
import {
  type ExtensionFundingStatusResult,
  SQUIRE_ROUTING_BRIEF_MAX_CHARS,
  SQUIRE_ROUTING_LEAD_CHOICE,
  SQUIRE_ROUTING_MAX_MEMBERS,
  SQUIRE_ROUTING_THREAD_TITLES_MAX,
  SquireId,
  SquireRouting,
  type SquireRoomPostId,
  type SquireRoutingRequest,
  type ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ExtensionsCloudClient from "../extensions/ExtensionsCloudClient.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRoomStore from "./SquireRoomStore.ts";
import * as SquireScope from "./SquireScope.ts";

/** Server settings, tuned on `room.routed` and `room.rerouted` rows. */
const JEV_FLOOR = 0.6;
const JEV_HIGH = 0.85;
/** Routing's own deadline; the general extension timeout is 90 s. */
export const JEV_DEADLINE_MS = 5_000;

export type JevUnavailableReason = "unfunded" | "pending" | "revoked" | "unavailable";
export type JevFailureReason = "rate-limited" | "allowance" | "error" | "invalid";

export type JevAvailability =
  | { readonly available: true; readonly fundingGeneration: number }
  | { readonly available: false; readonly reason: JevUnavailableReason };

/**
 * Names, briefs, scopes, recent activity titles, and the post only.
 * `requestId` and `runId` are both `squire-route:<messageKey>`, so a retry
 * replays on the relay without a second charge.
 */
export type JevRouteRequest = SquireRoutingRequest;

export interface JevAnswer {
  /** A member, or `lead` for "needs the Lead". */
  readonly choice: SquireId | "lead";
  readonly confidence: number;
  /** Confidence that the post needs no reply (`noul`). */
  readonly noReplyConfidence: number;
}

export class SquireJevRelayError extends Data.TaggedError("SquireJevRelayError")<{
  readonly reason: JevFailureReason;
}> {}

export class SquireJevRelay extends Context.Service<
  SquireJevRelay,
  {
    /** Funding for the `squires` feature: `active` and eligible, at a generation. */
    readonly availability: Effect.Effect<JevAvailability>;
    /** One attempt; never `explicitRetry`. */
    readonly route: (request: JevRouteRequest) => Effect.Effect<JevAnswer, SquireJevRelayError>;
  }
>()("lecturn/squire/SquireJevRouter/SquireJevRelay") {}

const unfundedRelay = SquireJevRelay.of({
  availability: Effect.succeed({ available: false, reason: "unfunded" }),
  route: () => Effect.fail(new SquireJevRelayError({ reason: "error" })),
});

const toAvailability = (status: ExtensionFundingStatusResult): JevAvailability => {
  switch (status.state) {
    case "active":
      return status.eligible
        ? { available: true, fundingGeneration: status.generation }
        : { available: false, reason: "unavailable" };
    case "unfunded":
    case "pending":
    case "revoked":
      return { available: false, reason: status.state };
    default:
      return { available: false, reason: "unavailable" };
  }
};

/**
 * Over `ExtensionsCloudClient` when the server provides it; unfunded
 * otherwise. Availability reads the stored status only, because the room post
 * path asks it inline.
 */
export const layerRelay = Layer.effect(
  SquireJevRelay,
  Effect.gen(function* () {
    const cloud = yield* Effect.serviceOption(ExtensionsCloudClient.ExtensionsCloudClient);
    if (Option.isNone(cloud)) return unfundedRelay;
    const client = cloud.value;
    return SquireJevRelay.of({
      availability: client.localStatus("squires").pipe(
        Effect.map(toAvailability),
        Effect.orElseSucceed((): JevAvailability => ({ available: false, reason: "unavailable" })),
      ),
      route: (request) =>
        client.route(request).pipe(
          Effect.flatMap((result) => {
            const [judgment] = result.judgments;
            return judgment === undefined
              ? Effect.fail(new SquireJevRelayError({ reason: "invalid" }))
              : Effect.succeed<JevAnswer>({
                  choice:
                    judgment.choice === SQUIRE_ROUTING_LEAD_CHOICE
                      ? "lead"
                      : SquireId.make(judgment.choice),
                  confidence: judgment.confidence,
                  noReplyConfidence: judgment.noReplyConfidence,
                });
          }),
          Effect.catchTags({
            ExtensionsRouteError: (error) =>
              Effect.fail(new SquireJevRelayError({ reason: error.reason })),
          }),
        ),
    });
  }),
);

export class SquireJevRouting extends Context.Service<
  SquireJevRouting,
  {
    readonly availability: Effect.Effect<JevAvailability>;
    /**
     * After the pending post committed: asks the relay (forked) and applies a
     * valid answer while routing is still `pending`. Never fails.
     */
    readonly begin: (input: {
      readonly postId: SquireRoomPostId;
      readonly fundingGeneration: number;
    }) => Effect.Effect<void>;
    /** Pending posts past their deadline fall back to the Lead (`timeout`). */
    readonly timeoutDue: (now: DateTime.Utc) => Effect.Effect<void, PersistenceSqlError>;
    readonly nextDeadlineAt: Effect.Effect<Option.Option<DateTime.Utc>, PersistenceSqlError>;
    /** Startup: re-asks pending posts inside their deadline under the same request id. */
    readonly resumePending: Effect.Effect<void, PersistenceSqlError>;
    /** Waits for every request in flight (tests). */
    readonly drain: Effect.Effect<void>;
  }
>()("lecturn/squire/SquireJevRouter/SquireJevRouting") {}

/** Per request: an answer, a failure, `Effect.never`, or an answer gated on a Deferred. */
export const layerRelayTest = (
  script: (request: JevRouteRequest) => Effect.Effect<JevAnswer, SquireJevRelayError>,
  options: { readonly availability?: Effect.Effect<JevAvailability> } = {},
) =>
  Layer.succeed(
    SquireJevRelay,
    SquireJevRelay.of({
      availability:
        options.availability ?? Effect.succeed({ available: true, fundingGeneration: 1 }),
      route: script,
    }),
  );

const CONTAINERS_MAX = 20;
const CONTAINER_MAX_CHARS = 200;
const THREAD_TITLE_MAX_CHARS = 500;
const PULL_REQUESTS_MAX = 100;
const ACTIVITY_MAX = 10;
const ACTIVITY_TITLE_MAX_CHARS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How long a request stays in flight past its deadline, so a late answer is
 * still seen and logged; the clock has already fallen back by then.
 */
const LATE_ANSWER_WAIT_MS = 60_000;

type FallbackReason = JevUnavailableReason | JevFailureReason | "timeout";
type JevOutcome =
  | { readonly kind: "answer"; readonly answer: JevAnswer }
  | { readonly kind: "failed"; readonly reason: JevFailureReason };

interface PendingPost {
  readonly post: SquireRepository.SquireRoomPostRow;
  readonly leadId: SquireId;
  /** The Lead's deferred `message` row; its `not_before` is the deadline. */
  readonly leadRow: SquireRepository.SquireEventRow;
}

const encodeRouting = Schema.encodeSync(Schema.fromJsonString(SquireRouting));
const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const routeRequestId = (messageKey: string) => `squire-route:${messageKey}`;
const formatConfidence = (value: number) => value.toFixed(2);
const isUnitInterval = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const rooms = yield* SquireRoomStore.SquireRoomStore;
  const delivery = yield* SquireDelivery.SquireDelivery;
  const scope = yield* SquireScope.SquireScope;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const relay = yield* SquireJevRelay;
  const fibers = yield* FiberSet.make();
  // A resume inside this process must not ask again for a post still in flight.
  const inFlight = yield* Ref.make<ReadonlySet<SquireRoomPostId>>(new Set());

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const loadPending = Effect.fn("SquireJevRouter.loadPending")(function* (
    post: SquireRepository.SquireRoomPostRow,
  ) {
    const lead = yield* repository.getLead;
    if (Option.isNone(lead)) return Option.none<PendingPost>();
    const leadRow = yield* repository.getEventByKey({
      squireId: lead.value.id,
      kind: "message",
      threadId: null,
      stateKey: post.message_key,
    });
    return Option.map(leadRow, (row): PendingPost => ({
      post,
      leadId: lead.value.id,
      leadRow: row,
    }));
  });

  const logRow = (
    pending: PendingPost,
    kind: "room.routed" | "room.routing-fallback",
    data: Record<string, string>,
    now: string,
  ) =>
    repository.insertActionLog({
      squire_id: pending.leadId,
      kind,
      room_id: pending.post.room_id,
      post_id: pending.post.id,
      trigger_id: null,
      task_id: null,
      thread_id: null,
      card_id: null,
      event_id: pending.leadRow.id,
      run_id: null,
      invocation_key: null,
      execution_key: null,
      data_json: encodeLogData({ ...data, requestId: routeRequestId(pending.post.message_key) }),
      created_at: now,
    });

  const releaseLeadRow = (leadRow: SquireRepository.SquireEventRow, now: string) =>
    repository.setEventStatus({
      ids: [leadRow.id],
      fromStatuses: ["deferred"],
      status: "pending",
      deferReason: null,
      notBefore: now,
    });

  /**
   * Rule (e) as it would have applied: the Lead gets the post. The Lead row
   * is released even when the routing already moved on, so it is never
   * stranded as deferred.
   */
  const fallback = Effect.fn("SquireJevRouter.fallback")(function* (
    pending: PendingPost,
    reason: FallbackReason,
  ) {
    const now = yield* nowIso;
    const applied = yield* repository.transaction(
      Effect.gen(function* () {
        const won = yield* rooms.setPostRouting({
          id: pending.post.id,
          routingJson: encodeRouting({
            via: { kind: "fallback", reason },
            recipients: [pending.leadId],
          }),
          expectedRoutingJson: SquireRoomStore.PENDING_ROUTING_JSON,
        });
        const released = yield* releaseLeadRow(pending.leadRow, now);
        if (won) yield* logRow(pending, "room.routing-fallback", { reason }, now);
        return won || released.length > 0;
      }),
    );
    if (applied) yield* delivery.wake(pending.leadId);
    return applied;
  });

  const memberName = (squireId: SquireId) =>
    repository
      .getSquire(squireId)
      .pipe(Effect.map(Option.match({ onNone: () => "a member", onSome: (row) => row.name })));

  /** Applies a valid answer while the post is still `pending`; false when the CAS lost. */
  const retarget = Effect.fn("SquireJevRouter.retarget")(function* (
    pending: PendingPost,
    answer: JevAnswer,
  ) {
    const now = yield* nowIso;
    const { post, leadId, leadRow } = pending;
    const noReply = answer.noReplyConfidence >= JEV_HIGH;
    const member =
      !noReply && answer.choice !== "lead" && answer.confidence >= JEV_FLOOR ? answer.choice : null;
    const toLead = !noReply && member === null;
    const shownToLead = member !== null && answer.confidence < JEV_HIGH;
    const recipients = noReply ? [] : member === null ? [leadId] : [member];
    const confidence = noReply ? answer.noReplyConfidence : answer.confidence;
    const name = member === null ? null : yield* memberName(member);
    const won = yield* repository.transaction(
      Effect.gen(function* () {
        const cas = yield* rooms.setPostRouting({
          id: post.id,
          routingJson: encodeRouting({
            via: { kind: "jev", confidence, noReplyNeeded: noReply, shownToLead },
            recipients,
          }),
          expectedRoutingJson: SquireRoomStore.PENDING_ROUTING_JSON,
        });
        if (!cas) return false;
        if (toLead) {
          yield* releaseLeadRow(leadRow, now);
        } else {
          yield* repository.setEventStatus({
            ids: [leadRow.id],
            fromStatuses: ["deferred"],
            status: "dropped",
          });
        }
        if (member !== null) {
          yield* repository.insertEvent({
            squire_id: member,
            thread_id: null,
            kind: "message",
            state_key: post.message_key,
            payload_json: leadRow.payload_json,
            status: "pending",
            defer_reason: null,
            not_before: now,
            batch_id: null,
            created_at: now,
          });
        }
        if (shownToLead) {
          // The Lead reads this row as room context instead of being woken.
          yield* rooms.insertPost({
            message_key: `jev-shown:${post.message_key}`,
            room_id: post.room_id,
            author_kind: "system",
            author_id: null,
            body: `Routed to ${name} · Jev ${formatConfidence(confidence)} · shown to Lead`,
            reply_to: post.id,
            refs_json: "[]",
            hop: 0,
            routing_json: encodeRouting({
              via: { kind: "rule", rule: "none", match: "shown to Lead" },
              recipients: [],
            }),
            rerouted_from: null,
            created_at: now,
          });
        }
        yield* logRow(
          pending,
          "room.routed",
          {
            via: "jev",
            choice: answer.choice,
            confidence: formatConfidence(answer.confidence),
            noReplyConfidence: formatConfidence(answer.noReplyConfidence),
            band: noReply ? "no-reply" : toLead ? "lead" : shownToLead ? "mid" : "high",
            recipients: recipients.join(","),
          },
          now,
        );
        return true;
      }),
    );
    if (won) yield* Effect.forEach(recipients, delivery.wake, { discard: true });
    return won;
  });

  const containerNames = Effect.fn("SquireJevRouter.containerNames")(function* (
    grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
  ) {
    if (grants.length === 0) return [];
    const shells = yield* projects.listShells();
    const names = grants.flatMap((grant) => {
      switch (grant.kind) {
        case "project":
          return shells.filter((shell) => shell.id === grant.target_id).map((shell) => shell.title);
        case "staveSpace":
        case "staveSaga":
          return [
            shells.find((shell) => shell.stave?.spaceId === grant.target_id)?.title ??
              (grant.kind === "staveSaga" ? "Stave saga" : "Stave space"),
          ];
        default:
          return [];
      }
    });
    return [...new Set(names)];
  });

  /** Only names, briefs, scopes, activity titles, and the post's own text. */
  const buildRequest = Effect.fn("SquireJevRouter.buildRequest")(function* (
    pending: PendingPost,
    fundingGeneration: number,
  ) {
    const { post } = pending;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const dayAgo = nowMs - DAY_MS;
    const memberRows = yield* rooms.listMembers(post.room_id);
    const candidates: Array<SquireRepository.SquireRow> = [];
    for (const row of memberRows) {
      if (row.member_kind !== "squire") continue;
      if (post.author_kind === "squire" && post.author_id === row.member_id) continue;
      const squire = yield* repository.getSquire(SquireId.make(row.member_id));
      if (Option.isNone(squire)) continue;
      if (squire.value.status !== "active" || squire.value.lifecycle === "deleting") continue;
      candidates.push(squire.value);
    }
    // Jev's choice has one option per member plus `lead`; the rest stay with the Lead's rules.
    candidates.splice(SQUIRE_ROUTING_MAX_MEMBERS);
    const memberIds = new Set(candidates.map((squire) => squire.id));

    const tracked = new Map<SquireId, Array<{ id: ThreadId; title: string; at: number }>>();
    if (candidates.length > 0) {
      for (const shell of (yield* projections.getShellSnapshot({ location: "active" })).threads) {
        for (const tracker of yield* scope.trackersOf(shell.id)) {
          if (!memberIds.has(tracker)) continue;
          const list = tracked.get(tracker) ?? [];
          list.push({
            id: shell.id,
            title: shell.title,
            at: DateTime.toEpochMillis(shell.updatedAt),
          });
          tracked.set(tracker, list);
        }
      }
    }
    const prsByThread = new Map<ThreadId, ReadonlyArray<number>>();
    if (tracked.size > 0) {
      for (const thread of yield* projections.getThreadsWithPullRequests()) {
        prsByThread.set(
          thread.id,
          (thread.pullRequests ?? []).map((link) => link.number),
        );
      }
    }
    const roomPosts = yield* rooms.listPostsDesc({ roomId: post.room_id, limit: 50 });

    const members = [];
    for (const squire of candidates) {
      const threads = (tracked.get(squire.id) ?? []).toSorted((a, b) => b.at - a.at);
      const pullRequests = [
        ...new Set(threads.flatMap((thread) => prsByThread.get(thread.id) ?? [])),
      ].toSorted((a, b) => a - b);
      const postCount = roomPosts.filter(
        (row) =>
          row.author_id === squire.id && row.id !== post.id && Date.parse(row.created_at) > dayAgo,
      ).length;
      const itemTitles = (yield* repository.listCards({ squireId: squire.id }))
        .filter((card) => Date.parse(card.created_at) > dayAgo)
        .toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((card) => card.title.slice(0, ACTIVITY_TITLE_MAX_CHARS));
      members.push({
        squireId: squire.id,
        name: squire.name,
        brief: squire.brief.slice(0, SQUIRE_ROUTING_BRIEF_MAX_CHARS),
        scope: {
          containers: (yield* containerNames(yield* repository.listGrants(squire.id)))
            .slice(0, CONTAINERS_MAX)
            .map((name) => name.slice(0, CONTAINER_MAX_CHARS)),
          threadTitles: threads
            .slice(0, SQUIRE_ROUTING_THREAD_TITLES_MAX)
            .map((thread) => thread.title.slice(0, THREAD_TITLE_MAX_CHARS)),
          pullRequests: pullRequests.slice(0, PULL_REQUESTS_MAX),
        },
        // A count of its posts, never their bodies.
        recentActivity: [
          ...(postCount > 0 ? [`${postCount} posts in this room in the last 24 h`] : []),
          ...itemTitles,
        ].slice(0, ACTIVITY_MAX),
      });
    }
    const requestId = routeRequestId(post.message_key);
    return {
      featureId: "squires",
      requestId,
      runId: requestId,
      fundingGeneration,
      templateVersion: "squire-routing-v1",
      members,
      post: { body: post.body },
    } satisfies JevRouteRequest;
  });

  const isValid = (answer: JevAnswer, request: JevRouteRequest) =>
    isUnitInterval(answer.confidence) &&
    isUnitInterval(answer.noReplyConfidence) &&
    (answer.choice === "lead" ||
      request.members.some((member) => member.squireId === answer.choice));

  const settle = Effect.fn("SquireJevRouter.settle")(function* (
    pending: PendingPost,
    outcome: JevOutcome,
    request: JevRouteRequest,
  ) {
    if (outcome.kind === "failed") return yield* fallback(pending, outcome.reason);
    if (!isValid(outcome.answer, request)) return yield* fallback(pending, "invalid");
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const late = nowMs >= Date.parse(pending.leadRow.not_before);
    const won = late ? false : yield* retarget(pending, outcome.answer);
    if (!won) {
      if (late) yield* fallback(pending, "timeout");
      yield* Effect.logInfo("Squire Jev answer arrived after routing settled; ignored", {
        postId: pending.post.id,
        requestId: request.requestId,
        choice: outcome.answer.choice,
      });
    }
    return won;
  });

  const ask = Effect.fn("SquireJevRouter.ask")(function* (
    pending: PendingPost,
    fundingGeneration: number,
  ) {
    const built = yield* Effect.result(buildRequest(pending, fundingGeneration));
    if (Result.isFailure(built)) {
      yield* Effect.logWarning("Squire Jev request could not be built", {
        postId: pending.post.id,
        cause: built.failure._tag,
      });
      yield* fallback(pending, "error");
      return;
    }
    const request = built.success;
    // Nobody to route to: rule (e) already names the Lead, so asking costs a charge for nothing.
    if (request.members.length === 0) {
      yield* fallback(pending, "invalid");
      return;
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const outcome = yield* relay.route(request).pipe(
      Effect.map((answer): JevOutcome => ({ kind: "answer", answer })),
      Effect.catchTags({
        SquireJevRelayError: (error) =>
          Effect.succeed<JevOutcome>({ kind: "failed", reason: error.reason }),
      }),
      Effect.timeoutOption(
        Math.max(0, Date.parse(pending.leadRow.not_before) - nowMs) + LATE_ANSWER_WAIT_MS,
      ),
    );
    if (Option.isNone(outcome)) {
      yield* fallback(pending, "timeout");
      return;
    }
    yield* settle(pending, outcome.value, request);
  });

  const track = Effect.fn("SquireJevRouter.track")(function* (
    postId: SquireRoomPostId,
    effect: Effect.Effect<void, PersistenceSqlError>,
  ) {
    const started = yield* Ref.modify(
      inFlight,
      (current): [boolean, ReadonlySet<SquireRoomPostId>] =>
        current.has(postId) ? [false, current] : [true, new Set([...current, postId])],
    );
    if (!started) return;
    yield* FiberSet.run(
      fibers,
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire Jev routing failed", { postId, cause }),
        ),
        Effect.ensuring(
          Ref.update(inFlight, (current) => {
            const next = new Set(current);
            next.delete(postId);
            return next;
          }),
        ),
      ),
    );
  });

  const begin: SquireJevRouting["Service"]["begin"] = ({ postId, fundingGeneration }) =>
    track(
      postId,
      Effect.gen(function* () {
        const post = yield* rooms.getPost(postId);
        if (Option.isNone(post) || post.value.routing_json !== SquireRoomStore.PENDING_ROUTING_JSON)
          return;
        const pending = yield* loadPending(post.value);
        if (Option.isNone(pending)) {
          yield* Effect.logWarning("Squire Jev routing found no Lead row", { postId });
          return;
        }
        yield* ask(pending.value, fundingGeneration);
      }),
    );

  const deferredLeadRows = (dueBy?: string) =>
    repository.listEvents({
      statuses: ["deferred"],
      deferReasons: ["routing"],
      kinds: ["message"],
      ...(dueBy === undefined ? {} : { dueBy }),
    });

  const timeoutDue: SquireJevRouting["Service"]["timeoutDue"] = Effect.fn(
    "SquireJevRouter.timeoutDue",
  )(function* (now) {
    const due = yield* deferredLeadRows(DateTime.formatIso(now));
    for (const row of due) {
      const post = yield* rooms.getPostByKey(row.state_key);
      if (Option.isNone(post)) {
        const released = yield* releaseLeadRow(row, DateTime.formatIso(now));
        if (released.length > 0) yield* delivery.wake(row.squire_id);
        continue;
      }
      yield* fallback({ post: post.value, leadId: row.squire_id, leadRow: row }, "timeout");
    }
  });

  const nextDeadlineAt: SquireJevRouting["Service"]["nextDeadlineAt"] = deferredLeadRows().pipe(
    Effect.map((rows) => {
      const earliest = rows.reduce<number | null>((min, row) => {
        const at = Date.parse(row.not_before);
        return min === null || at < min ? at : min;
      }, null);
      return earliest === null ? Option.none() : Option.some(DateTime.makeUnsafe(earliest));
    }),
  );

  const resumePending: SquireJevRouting["Service"]["resumePending"] = Effect.gen(function* () {
    const posts = yield* rooms.listPendingRoutingPosts;
    if (posts.length === 0) return;
    const available = yield* relay.availability;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const post of posts) {
      const pending = yield* loadPending(post);
      if (Option.isNone(pending)) continue;
      if (!available.available) {
        yield* fallback(pending.value, available.reason);
      } else if (Date.parse(pending.value.leadRow.not_before) <= nowMs) {
        yield* fallback(pending.value, "timeout");
      } else {
        // The same request id, so the relay replays a stored answer without a second charge.
        yield* begin({ postId: post.id, fundingGeneration: available.fundingGeneration });
      }
    }
  });

  return SquireJevRouting.of({
    availability: relay.availability,
    begin,
    timeoutDue,
    nextDeadlineAt,
    resumePending,
    drain: FiberSet.awaitEmpty(fibers),
  });
});

export const layerRouting = Layer.effect(SquireJevRouting, make);
