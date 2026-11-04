import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  SquireCardId,
  SquireId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SquireCardDetail from "./SquireCardDetail.ts";
import * as SquireRepository from "./SquireRepository.ts";

const threadId = ThreadId.make("thread-billing");
const OLD_HEAD = "1111111aaaaaaa";
const NEW_HEAD = "2222222bbbbbbb";
const PR = "github.com/acme/billing-service#318";

const row = (id: number, kind: string, state_key: string, created_at: string) => ({
  id,
  kind,
  state_key,
  created_at,
});

describe("squireTimeline", () => {
  it("orders by time, merges two Squires' copies, and marks each new PR head", () => {
    const timeline = SquireCardDetail.squireTimeline([
      row(5, "pull-request-changed", `${PR}:${NEW_HEAD}:checks:failed`, "2026-10-31T14:11:00.000Z"),
      row(1, "turn-finished", "run-1", "2026-10-31T14:02:00.000Z"),
      row(2, "turn-finished", "run-1", "2026-10-31T14:02:01.000Z"),
      row(
        3,
        "pull-request-changed",
        `${PR}:${OLD_HEAD}:review:approved`,
        "2026-10-31T14:03:00.000Z",
      ),
      row(6, "waiting-on-user", "request-9", "2026-10-31T14:12:00.000Z"),
    ]);
    assert.deepStrictEqual(timeline, [
      { at: "2026-10-31T14:02:00.000Z", text: "turn finished" },
      { at: "2026-10-31T14:03:00.000Z", text: "PR #318 pushed 1111111" },
      { at: "2026-10-31T14:03:00.000Z", text: "PR #318 review approved" },
      { at: "2026-10-31T14:11:00.000Z", text: "PR #318 pushed 2222222" },
      { at: "2026-10-31T14:11:00.000Z", text: "PR #318 checks failed" },
      { at: "2026-10-31T14:12:00.000Z", text: "waiting on you" },
    ]);
  });

  it("keeps only the newest entries", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(
        index,
        "turn-finished",
        `run-${index}`,
        `2026-10-31T14:${String(index).padStart(2, "0")}:00.000Z`,
      ),
    );
    const timeline = SquireCardDetail.squireTimeline(rows);
    assert.strictEqual(timeline.length, SquireCardDetail.SQUIRE_TIMELINE_LIMIT);
    assert.strictEqual(timeline.at(-1)?.at, "2026-10-31T14:39:00.000Z");
    assert.strictEqual(timeline[0]?.at, "2026-10-31T14:28:00.000Z");
  });

  it("adds the link's state now unless a row recorded it on that head", () => {
    const timeline = SquireCardDetail.squireTimeline(
      [
        row(1, "turn-finished", "run-1", "2026-10-31T14:01:00.000Z"),
        row(
          2,
          "pull-request-changed",
          `${PR}:${OLD_HEAD}:checks:passed`,
          "2026-10-31T14:05:00.000Z",
        ),
      ],
      {
        pullRequestsOnly: true,
        currentHeads: [
          {
            prKey: PR,
            number: 318,
            headSha: OLD_HEAD,
            at: "2026-10-31T14:06:00.000Z",
            transition: "checks:passed",
          },
          {
            prKey: PR,
            number: 318,
            headSha: OLD_HEAD,
            at: "2026-10-31T14:20:00.000Z",
            transition: "merged",
          },
        ],
      },
    );
    assert.deepStrictEqual(
      timeline.map((entry) => entry.text),
      ["PR #318 pushed 1111111", "PR #318 checks passed", "PR #318 merged"],
    );
  });

  it("adds a head the link moved to without a transition row", () => {
    const timeline = SquireCardDetail.squireTimeline(
      [
        row(
          1,
          "pull-request-changed",
          `${PR}:${OLD_HEAD}:checks:failed`,
          "2026-10-31T14:05:00.000Z",
        ),
      ],
      {
        currentHeads: [
          { prKey: PR, number: 318, headSha: NEW_HEAD, at: "2026-10-31T14:20:00.000Z" },
          { prKey: PR, number: 318, headSha: OLD_HEAD, at: "2026-10-31T14:30:00.000Z" },
        ],
      },
    );
    assert.deepStrictEqual(
      timeline.map((entry) => entry.text),
      [
        "PR #318 pushed 1111111",
        "PR #318 checks failed",
        "PR #318 pushed 2222222",
        "PR #318 pushed 1111111",
      ],
    );
  });
});

const NOW = "2026-10-31T14:12:00.000Z";
const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "acme/billing-service",
  number: 318,
  url: "https://github.com/acme/billing-service/pull/318",
  source: "manual",
  linkedAt: NOW,
  snapshot: {
    state: "open",
    title: "Fix invoice rounding",
    headBranch: "fix/invoice-rounding",
    baseBranch: "main",
    isDraft: false,
    updatedAt: NOW,
    syncedAt: NOW,
    additions: 38,
    deletions: 12,
    changedFiles: 4,
    reviewDecision: "approved",
    checksState: "failing",
    mergeability: "mergeable",
    headSha: NEW_HEAD,
  },
  stack: null,
};

const shell = (): OrchestrationV2ThreadShell => {
  const at = DateTime.makeUnsafe(NOW);
  return {
    id: threadId,
    projectId: ProjectId.make("project-billing"),
    title: "Fix invoice rounding",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "local-branch",
    worktreePath: null,
    pullRequests: [link],
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

const card: SquireRepository.SquireCardRow = {
  id: SquireCardId.make("card-1"),
  squire_id: SquireId.make("squire-release"),
  owner_squire_id: SquireId.make("squire-release"),
  kind: "steer",
  status: "open",
  target_thread_id: threadId,
  project_id: null,
  title: "Fix invoice rounding",
  why: "api-e2e failed",
  payload_json: "{}",
  evidence_json: JSON.stringify({
    errorLines: ["AssertionError: expected '€1,234.57' to equal '€1,234.56'"],
    ciLog: {
      status: "log",
      headSha: NEW_HEAD,
      jobs: [{ name: "api-e2e", url: null }],
      truncated: false,
    },
    pullRequest: {
      repository: "acme/billing-service",
      number: 318,
      headSha: NEW_HEAD,
      transition: "checks:failed",
      baseBranch: "main",
      checks: { passed: 11, failed: 1, failingJobs: ["api-e2e"] },
      review: "none",
      mergeable: null,
      merged: false,
      closed: false,
    },
  }),
  trigger_json: "{}",
  intent_json: null,
  origin: "event",
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
  dedupe_key: null,
  replaced_count: 0,
  ask_json: null,
  resolution: null,
  created_at: NOW,
  updated_at: NOW,
};

describe("SquireCardDetail", () => {
  it.effect("overlays the live PR over the stored excerpt and builds the timeline", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const squire of ["squire-release", "squire-lead"]) {
        yield* repository.insertEvent({
          squire_id: SquireId.make(squire),
          thread_id: threadId,
          kind: "pull-request-changed",
          state_key: `${PR}:${NEW_HEAD}:checks:failed`,
          payload_json: null,
          status: "delivered",
          defer_reason: null,
          not_before: NOW,
          batch_id: null,
          created_at: "2026-10-31T14:11:00.000Z",
        });
      }
      const { detail } = SquireCardDetail.makeSquireCardDetail({ repository, projections });
      const parts = yield* detail(card, {});

      assert.deepStrictEqual(parts.evidence.errorLines, [
        "AssertionError: expected '€1,234.57' to equal '€1,234.56'",
      ]);
      assert.strictEqual(parts.evidence.headBranch, "fix/invoice-rounding");
      assert.deepStrictEqual(parts.evidence.diffStats, { insertions: 38, deletions: 12, files: 4 });
      // Live review and mergeability, with the check counts read for this head.
      assert.strictEqual(parts.evidence.pullRequest?.review, "approved");
      assert.strictEqual(parts.evidence.pullRequest?.mergeable, "blocked-by-checks");
      assert.deepStrictEqual(parts.evidence.pullRequest?.checks, {
        passed: 11,
        failed: 1,
        failingJobs: ["api-e2e"],
      });
      assert.deepStrictEqual(
        parts.timeline.map((entry) => entry.text),
        ["PR #318 pushed 2222222", "PR #318 checks failed"],
      );
      // A PR-only trigger has no message to deep-link.
      assert.isUndefined(parts.trigger.triggerMessageId);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) => Effect.succeed(id === threadId ? shell() : null),
          }),
          Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  it.effect("a thread card shows its PR's failing checks with only a turn row stored", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* repository.insertEvent({
        squire_id: SquireId.make("squire-release"),
        thread_id: threadId,
        kind: "turn-finished",
        state_key: "run-1",
        payload_json: null,
        status: "delivered",
        defer_reason: null,
        not_before: NOW,
        batch_id: null,
        created_at: "2026-10-31T14:01:00.000Z",
      });
      const { detail } = SquireCardDetail.makeSquireCardDetail({ repository, projections });
      const parts = yield* detail(card, {});
      assert.deepStrictEqual(parts.timeline, [
        { at: "2026-10-31T14:01:00.000Z", text: "turn finished" },
        { at: NOW, text: "PR #318 pushed 2222222" },
        { at: NOW, text: "PR #318 checks failed" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: (id) => Effect.succeed(id === threadId ? shell() : null),
          }),
          Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  it.effect("a card without a target thread keeps only what it stored", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { detail } = SquireCardDetail.makeSquireCardDetail({ repository, projections });
      const parts = yield* detail({ ...card, target_thread_id: null, evidence_json: "{}" }, {});
      assert.deepStrictEqual(parts, { evidence: {}, trigger: {}, timeline: [] });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  const logRow = (
    kind: string,
    data: Record<string, unknown>,
    created_at: string,
    card_id = SquireCardId.make("card-1"),
  ) => ({
    squire_id: SquireId.make("squire-lead"),
    kind,
    room_id: null,
    post_id: null,
    trigger_id: null,
    task_id: null,
    thread_id: null,
    card_id,
    event_id: null,
    run_id: null,
    invocation_key: null,
    execution_key: null,
    data_json: JSON.stringify(data),
    created_at,
  });

  it.effect("a proposal's timeline is its own log rows, opened, and how it settled", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* repository.insertActionLog(
        logRow("card.created", { kind: "proposal" }, "2026-10-31T14:02:00.000Z"),
      );
      yield* repository.insertActionLog(
        logRow("notification.pushed", { kind: "proposal" }, "2026-10-31T14:02:00.000Z"),
      );
      yield* repository.insertActionLog(
        logRow("card.created", { updated: true, replacedCount: 1 }, "2026-10-31T14:05:00.000Z"),
      );
      yield* repository.insertActionLog(
        logRow(
          "action.executed",
          { action: "create_thread", verb: "accept" },
          "2026-10-31T14:11:00.000Z",
        ),
      );
      // Another card's rows stay on that card.
      yield* repository.insertActionLog(
        logRow("card.created", {}, "2026-10-31T14:03:00.000Z", SquireCardId.make("card-2")),
      );
      const { detail } = SquireCardDetail.makeSquireCardDetail({ repository, projections });
      const parts = yield* detail(
        {
          ...card,
          kind: "proposal",
          target_thread_id: null,
          evidence_json: "{}",
          status: "resolved",
          resolution: "accepted",
          opened_at: "2026-10-31T14:07:00.000Z",
          updated_at: "2026-10-31T14:11:00.000Z",
        },
        {},
      );
      assert.deepStrictEqual(parts.timeline, [
        { at: "2026-10-31T14:02:00.000Z", text: "raised" },
        { at: "2026-10-31T14:05:00.000Z", text: "updated" },
        { at: "2026-10-31T14:07:00.000Z", text: "opened" },
        { at: "2026-10-31T14:11:00.000Z", text: "accepted" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );

  const otherThread = ThreadId.make("thread-ledger");
  it.effect("an overlap adds each thread's latest and its named PR's moments, by thread", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const event = (thread: ThreadId, kind: string, state_key: string, created_at: string) =>
        repository.insertEvent({
          squire_id: SquireId.make("squire-release"),
          thread_id: thread,
          kind,
          state_key,
          payload_json: null,
          status: "delivered",
          defer_reason: null,
          not_before: created_at,
          batch_id: null,
          created_at,
        });
      yield* event(threadId, "turn-finished", "run-1", "2026-10-31T14:01:00.000Z");
      yield* event(
        threadId,
        "pull-request-changed",
        `${PR}:${NEW_HEAD}:checks:failed`,
        "2026-10-31T14:09:00.000Z",
      );
      // An earlier PR on the same thread merged before this change set began.
      yield* event(
        threadId,
        "pull-request-changed",
        `${PR.replace("#318", "#300")}:${NEW_HEAD}:merged`,
        "2026-10-31T14:00:00.000Z",
      );
      yield* event(otherThread, "turn-finished", "run-2", "2026-10-31T14:04:00.000Z");
      yield* repository.insertActionLog(
        logRow("card.created", { kind: "overlap" }, "2026-10-31T14:03:00.000Z"),
      );
      const { detail } = SquireCardDetail.makeSquireCardDetail({ repository, projections });
      const parts = yield* detail(
        {
          ...card,
          kind: "overlap",
          target_thread_id: null,
          evidence_json: "{}",
          payload_json: JSON.stringify({
            type: "overlap",
            threads: [
              { threadId, pullRequest: 318 },
              { threadId: otherThread },
              { threadId, pullRequest: 318 },
            ],
          }),
        },
        {},
      );
      assert.deepStrictEqual(
        parts.timeline.map((entry) => entry.text),
        [
          "raised",
          "turn finished",
          "Fix invoice rounding: PR #318 pushed 2222222",
          "Fix invoice rounding: PR #318 checks failed",
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            // The ledger thread is gone; its moment still shows, unnamed.
            getThreadShell: (id) => Effect.succeed(id === threadId ? shell() : null),
          }),
          Layer.provideMerge(SquireRepository.layer, SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );
});

describe("squireCardTimeline", () => {
  const settled = (
    status: SquireRepository.SquireCardRow["status"],
    resolution: string | null,
  ) => ({ status, resolution, opened_at: null, updated_at: "2026-10-31T14:30:00.000Z" });
  const log = (id: number, kind: string, data: Record<string, unknown>, minute: number) => ({
    id,
    kind,
    data_json: JSON.stringify(data),
    created_at: `2026-10-31T14:${String(minute).padStart(2, "0")}:00.000Z`,
  });

  it("reads a hold's run, undo, and return to a card", () => {
    const timeline = SquireCardDetail.squireCardTimeline(settled("open", null), [
      log(1, "action.held", {}, 1),
      log(2, "action.undone", {}, 2),
      log(3, "card.created", { reason: "undone" }, 2),
    ]);
    assert.deepStrictEqual(
      timeline.map((entry) => entry.text),
      ["held to run", "undone", "back as a card"],
    );
  });

  it("records one execution once, and a settle no row logged from the card", () => {
    const executed = SquireCardDetail.squireCardTimeline(settled("executed", "executed"), [
      log(1, "action.held", {}, 1),
      log(2, "action.executed", { verb: "execute" }, 5),
      log(3, "action.executed", { action: "room-open" }, 5),
    ]);
    assert.deepStrictEqual(
      executed.map((entry) => entry.text),
      ["held to run", "executed"],
    );
    for (const [status, resolution, text] of [
      ["dismissed", "dismissed", "dismissed"],
      ["outdated", "superseded", "replaced by a newer card"],
      ["outdated", "outdated", "outdated"],
      ["resolved", "accepted", "accepted"],
    ] as const) {
      const timeline = SquireCardDetail.squireCardTimeline(settled(status, resolution), [
        log(1, "card.created", {}, 1),
      ]);
      assert.deepStrictEqual(timeline.at(-1), { at: "2026-10-31T14:30:00.000Z", text });
    }
    // A held card dismissed logs its cancel; the status adds nothing.
    const dismissed = SquireCardDetail.squireCardTimeline(settled("dismissed", "dismissed"), [
      log(1, "action.held", {}, 1),
      log(2, "action.cancelled", { reason: "dismissed", to: "dismissed" }, 3),
    ]);
    assert.deepStrictEqual(
      dismissed.map((entry) => entry.text),
      ["held to run", "dismissed"],
    );
  });

  it("keeps only the newest entries", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      log(index, "card.created", index === 0 ? {} : { updated: true }, index),
    );
    const timeline = SquireCardDetail.squireCardTimeline(settled("open", null), rows);
    assert.strictEqual(timeline.length, SquireCardDetail.SQUIRE_TIMELINE_LIMIT);
    assert.strictEqual(timeline.at(-1)?.at, "2026-10-31T14:29:00.000Z");
  });
});
