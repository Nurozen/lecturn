/**
 * The Lead's overlap detector over a real orchestrator: stored
 * summaries run it through the post-store hook, thread changes through the
 * thread hook the reactor calls, and inject's summaries through the same hook.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  isUnknownUnionMember,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SquireCardPayload,
  SquireFixtureScenario,
  SquireId,
  SquireTurnSummary,
  ThreadId,
  type UnknownUnionMember,
} from "@lecturn/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireDevFixtures from "./SquireDevFixtures.ts";
import * as SquireHooks from "./squireHooks.ts";
import * as SquireItems from "./SquireItems.ts";
import * as SquireOverlap from "./SquireOverlap.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireToolKit from "./squireToolKit.ts";
import { tempRoot } from "./testkit/lifecycleHarness.ts";
import { phase4Layer } from "./testkit/phase4Harness.ts";
import { dispatchThread, grantRow, orchestratorLayer, squireRow } from "./testkit/scopeHarness.ts";
import scenario01Json from "./testdata/scenarios/01-ci-failure-recommend.json" with { type: "json" };
import scenario05Json from "./testdata/scenarios/05-merged-propose-thread.json" with { type: "json" };
import scenario07Json from "./testdata/scenarios/07-overlap-risk.json" with { type: "json" };

const billing = ProjectId.make("project:billing");
const ledger = ProjectId.make("project:ledger");
const lead = SquireId.make("squire:lead");
const release = SquireId.make("squire:release");
const research = SquireId.make("squire:research");
const invoice = ThreadId.make("thr_invoice");
const currency = ThreadId.make("thr_currency");
const SHARED = "src/invoice/InvoiceTotals.ts";

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const decodePayloadJson = Schema.decodeUnknownSync(Schema.fromJsonString(SquireCardPayload));
type OverlapPayload = Extract<
  Exclude<SquireCardPayload, UnknownUnionMember<"type">>,
  { readonly type: "overlap" }
>;
const overlapOf = (card: SquireRepository.SquireCardRow) => {
  const payload = decodePayloadJson(card.payload_json);
  if (isUnknownUnionMember(payload) || payload.type !== "overlap") throw new Error("not overlap");
  return payload as OverlapPayload;
};

const need = <I, S>(tag: Context.Key<I, S>) =>
  Effect.map(Effect.serviceOption(tag), Option.getOrThrow);

// ── Checkpoints: one thread's latest diff, as the test sets it ──

const touched = Ref.makeUnsafe<ReadonlyArray<string> | null>(null);
const checkpointThread = ThreadId.make("thr_checkpointed");
const checkpointRuns = Ref.makeUnsafe<ReadonlyArray<RunId>>([]);
const scopeId = CheckpointScopeId.make("scope-1");
const epoch = DateTime.makeUnsafe(0);
const checkpointOf = (index: number, runId: RunId | null): OrchestrationV2Checkpoint => ({
  id: CheckpointId.make(`checkpoint-${index}`),
  threadId: checkpointThread,
  scopeId,
  runId,
  nodeId: NodeId.make("node-1"),
  parentCheckpointId: index === 0 ? null : CheckpointId.make(`checkpoint-${index - 1}`),
  ordinalWithinScope: index,
  appRunOrdinal: index === 0 ? null : index,
  ref: CheckpointRef.make(`refs/lecturn/checkpoint-${index}`),
  status: "ready",
  files: [],
  capturedAt: epoch,
});
const checkpointScope: OrchestrationV2CheckpointScope = {
  id: scopeId,
  threadId: checkpointThread,
  runId: null,
  nodeId: NodeId.make("node-1"),
  parentScopeId: null,
  providerThreadId: null,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd: "/work/billing",
  createdAt: epoch,
};

/** The checkpointed thread's records come from the test; every other read is real. */
const checkpointedProjections = Layer.effect(
  ProjectionStore.ProjectionStoreV2,
  Effect.map(ProjectionStore.ProjectionStoreV2, (real) => ({
    ...real,
    getThreadRecords: ((threadId, fields, filter) =>
      threadId === checkpointThread && (fields as ReadonlyArray<string>).includes("checkpoints")
        ? Ref.get(checkpointRuns).pipe(
            Effect.map((runs) => ({
              checkpoints: [
                checkpointOf(0, null),
                ...runs.map((run, i) => checkpointOf(i + 1, run)),
              ],
              checkpointScopes: [checkpointScope],
            })),
          )
        : real.getThreadRecords(threadId, fields, filter)) as typeof real.getThreadRecords,
  })),
);

const nameStatusStore = Layer.mock(CheckpointStore.CheckpointStore)({
  diffCheckpoints: (input) =>
    Ref.get(touched).pipe(
      Effect.map((paths) =>
        input.format === "name-status" ? (paths ?? []).map((path) => `M\t${path}`).join("\n") : "",
      ),
    ),
});

// ── Harness ──

const containers = SquireContainers.layerTest({});

const base = Layer.mergeAll(SquireScope.layer, SquireHooks.layer, SquireToolKit.layer).pipe(
  Layer.provideMerge(SquireRepository.layer),
  Layer.provideMerge(containers),
  Layer.provideMerge(orchestratorLayer),
);

const withOverlap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      SquireOverlap.layer.pipe(
        Layer.provide(Layer.merge(checkpointedProjections, nameStatusStore)),
        Layer.provideMerge(base),
      ),
    ),
  );

const createThread = (
  threadId: ThreadId,
  projectId: ProjectId,
  title: string,
  branch: string | null = null,
) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch,
      worktreePath: null,
    }),
  );

const dispatch = (command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const seed = (
  squires: ReadonlyArray<SquireRepository.SquireRow>,
  grants: ReadonlyArray<SquireRepository.SquireGrantRow>,
) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.createSquire(squireRow(lead, { role: "lead", name: "Lead" }));
    for (const squire of squires) yield* repository.createSquire(squire);
    for (const grant of grants) yield* repository.insertGrant(grant);
  });

const releaseRow = squireRow(release, { created_at: "2026-10-01T09:00:00.000Z" });
const researchRow = squireRow(research, { created_at: "2026-10-02T09:00:00.000Z" });

let runCounter = 0;
type PullRequest = SquireTurnSummary["pullRequest"];

/** Stores a complete summary and runs the post-store hooks, as SquireSummaries does. */
const store = (
  threadId: ThreadId,
  paths: ReadonlyArray<string>,
  options: { readonly pullRequest?: PullRequest; readonly runId?: RunId } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    const repository = yield* SquireRepository.SquireRepository;
    const hooks = yield* SquireHooks.SquireHooks;
    const runId = options.runId ?? RunId.make(`run-${++runCounter}`);
    const summary: SquireTurnSummary = {
      threadId,
      threadTitle: threadId,
      project: "billing-service",
      provider: ProviderDriverKind.make("codex"),
      turnId: runId,
      outcome: "finished",
      summaryStatus: "complete",
      goal: "Work",
      completed: [],
      remaining: [],
      blocked: [],
      pendingQuestion: null,
      suggestedNextStep: null,
      files: {
        entries: paths.map((path) => ({ path, change: "modified" as const })),
        counts: { added: 0, modified: paths.length, deleted: 0 },
      },
      commands: [],
      pullRequest: options.pullRequest ?? null,
    };
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* repository.insertSummary({
      thread_id: threadId,
      run_id: runId,
      stage: "terminal",
      status: "complete",
      summary_json: encodeSummary(summary),
      payer_squire_id: null,
      created_at: now,
      updated_at: now,
    });
    yield* hooks.summaryStored({ threadId, runId, stage: "terminal", summary });
    return runId;
  });

/** What the reactor does after a PR, settle, archive, delete, or metadata event commits. */
const changed = (threadId: ThreadId) =>
  Effect.flatMap(SquireHooks.SquireHooks, (hooks) => hooks.threadChanged(threadId));

const overlapCards = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listCards({ squireId: lead, kinds: ["overlap"] }),
);
const openOverlaps = Effect.map(overlapCards, (cards) =>
  cards.filter((card) => card.status === "open"),
);
const leadEvents = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listEventsByStatus({
    squireId: lead,
    statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
  }),
);

/** Release's project grant covers both threads (scenario 07's shape). */
const pairInBilling = Effect.gen(function* () {
  yield* seed([releaseRow], [grantRow(release, "project", billing)]);
  yield* createThread(invoice, billing, "Fix invoice rounding", "fix/invoice-rounding");
  yield* createThread(currency, billing, "Currency display cleanup", "chore/currency-display");
});

const openPr = (number: number): PullRequest => ({
  repository: "billing-service",
  number,
  headSha: "9f2c4e1",
  transition: "review:review-required",
  baseBranch: "main",
  checks: { passed: 12, failed: 0, failingJobs: [] },
  review: "review-required",
  mergeable: "blocked-by-review",
  merged: false,
  closed: false,
});

const linkPr = (threadId: ThreadId, number: number, state: "open" | "merged" | "closed") =>
  Effect.gen(function* () {
    const key = { host: "github.com", repository: "acme/billing-service", number };
    if (state === "open") {
      yield* dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`${threadId}:link:${number}`),
        threadId,
        ...key,
        url: `https://github.com/acme/billing-service/pull/${number}`,
        source: "manual",
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* dispatch({
      type: "thread.pull-request-link.sync",
      commandId: CommandId.make(`${threadId}:sync:${number}:${state}`),
      threadId,
      ...key,
      snapshot: {
        state,
        title: "Fix",
        headBranch: "fix/invoice-rounding",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: now,
        reviewDecision: "approved",
        checksState: "passing",
        ...(state === "merged" ? { mergedAt: now } : state === "closed" ? { closedAt: now } : {}),
      },
      stack: null,
    });
  });

describe("SquireOverlap", () => {
  it.effect("two Squires' threads sharing a path raise one Lead item owned per thread", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* seed(
          [releaseRow, researchRow],
          [grantRow(release, "thread", invoice), grantRow(research, "thread", currency)],
        );
        yield* createThread(invoice, billing, "Fix invoice rounding");
        yield* createThread(currency, billing, "Currency display cleanup");
        yield* store(invoice, [SHARED, "src/invoice/InvoiceTotals.test.ts"], {
          pullRequest: openPr(318),
        });
        assert.lengthOf(yield* overlapCards, 0);
        yield* store(currency, ["src/format/currency.ts", SHARED]);

        const [card, ...rest] = yield* overlapCards;
        assert.lengthOf(rest, 0);
        assert.strictEqual(card!.squire_id, lead);
        assert.strictEqual(card!.status, "open");
        assert.isNull(card!.target_thread_id);
        // The thread landing first owns the card; each thread's own Squire is in the payload.
        assert.strictEqual(card!.owner_squire_id, release);
        const payload = overlapOf(card!);
        assert.deepStrictEqual(
          payload.threads.map((thread) => [thread.threadId, thread.squireId]),
          [
            [invoice, release],
            [currency, research],
          ],
        );
        assert.deepStrictEqual(payload.paths, [SHARED]);
        assert.strictEqual(payload.repository, billing);
        assert.strictEqual(
          payload.recommendation,
          "Land #318 first, then rebase Currency display cleanup",
        );
        assert.strictEqual(
          card!.dedupe_key,
          SquireOverlap.overlapDedupeKey(billing, [currency, invoice]),
        );
        assert.lengthOf(yield* leadEvents, 0);
      }),
    ),
  );

  it.effect("compares a new summary only with recently summarized threads", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* pairInBilling;
        yield* store(invoice, [SHARED]);
        yield* TestClock.adjust(SquireOverlap.OVERLAP_ACTIVE_WINDOW_MS + 60_000);
        // The quiet thread is outside the window, so this store never loads it.
        yield* store(currency, [SHARED]);
        assert.lengthOf(yield* overlapCards, 0);
        // Its next summary brings it back, and the pair is compared again.
        yield* store(invoice, [SHARED]);
        assert.lengthOf(yield* openOverlaps, 1);
      }),
    ),
  );

  it.effect("names each thread's own branch, else its linked PR's head branch, and its PR", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* seed([releaseRow], [grantRow(release, "project", billing)]);
        yield* createThread(invoice, billing, "Fix invoice rounding");
        yield* createThread(
          currency,
          billing,
          "Currency display cleanup",
          "chore/currency-display",
        );
        yield* linkPr(invoice, 318, "open");
        yield* store(invoice, [SHARED]);
        yield* store(currency, [SHARED]);

        const [card] = yield* openOverlaps;
        assert.deepStrictEqual(
          overlapOf(card!).threads.map((thread) => [
            thread.threadId,
            thread.branch,
            thread.pullRequest,
          ]),
          [
            // The recommendation's "#318" is on the thread line too.
            [invoice, "fix/invoice-rounding", 318],
            [currency, "chore/currency-display", undefined],
          ],
        );
      }),
    ),
  );

  it.effect("one Squire tracking both threads still raises the item", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* pairInBilling;
        yield* store(invoice, [SHARED]);
        yield* store(currency, [SHARED]);
        const [card] = yield* openOverlaps;
        assert.deepStrictEqual(
          overlapOf(card!).threads.map((thread) => thread.squireId),
          [release, release],
        );
      }),
    ),
  );

  it.effect("a project grant plus a thread grant on the same thread raises exactly one item", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* seed(
          [releaseRow, researchRow],
          [grantRow(release, "project", billing), grantRow(research, "thread", currency)],
        );
        yield* createThread(invoice, billing, "Fix invoice rounding");
        yield* createThread(currency, billing, "Currency display cleanup");
        yield* store(invoice, [SHARED]);
        yield* store(currency, [SHARED]);
        yield* store(currency, [SHARED]);
        const cards = yield* overlapCards;
        assert.lengthOf(cards, 1);
        // The earliest-created tracker owns a co-tracked thread.
        assert.deepStrictEqual(
          overlapOf(cards[0]!).threads.map((thread) => thread.squireId),
          [release, release],
        );
      }),
    ),
  );

  it.effect("the same path in different repositories is no overlap", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* seed(
          [releaseRow],
          [grantRow(release, "project", billing), grantRow(release, "project", ledger)],
        );
        yield* createThread(invoice, billing, "Fix invoice rounding");
        yield* createThread(currency, ledger, "Ledger cleanup");
        yield* store(invoice, [SHARED, "README.md"]);
        yield* store(currency, [SHARED, "README.md"]);
        assert.lengthOf(yield* overlapCards, 0);
      }),
    ),
  );

  it.effect("a busy project whose threads share only lockfiles raises nothing", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* seed([releaseRow], [grantRow(release, "project", billing)]);
        const threads = [0, 1, 2, 3].map((index) => ThreadId.make(`thr_busy_${index}`));
        for (const [index, threadId] of threads.entries()) {
          yield* createThread(threadId, billing, `Busy ${index}`);
        }
        for (let turn = 0; turn < 3; turn++) {
          for (const [index, threadId] of threads.entries()) {
            yield* store(threadId, [
              "pnpm-lock.yaml",
              "apps/web/package-lock.json",
              `src/own-${index}-${turn}.ts`,
            ]);
          }
        }
        assert.lengthOf(yield* overlapCards, 0);
        assert.lengthOf(yield* leadEvents, 0);
      }),
    ),
  );

  it.effect("ten turns on a pair give one item; a later shared path marks it updated", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* pairInBilling;
        for (let turn = 0; turn < 5; turn++) {
          yield* store(invoice, [SHARED, `src/invoice/own-${turn}.ts`]);
          yield* store(currency, [SHARED, `src/format/own-${turn}.ts`]);
        }
        const [card, ...rest] = yield* overlapCards;
        assert.lengthOf(rest, 0);
        assert.strictEqual(card!.replaced_count, 0);

        yield* store(invoice, ["src/format/currency.ts"]);
        yield* store(currency, ["src/format/currency.ts"]);
        const [updated, ...none] = yield* overlapCards;
        assert.lengthOf(none, 0);
        assert.strictEqual(updated!.id, card!.id);
        assert.strictEqual(updated!.status, "open");
        assert.strictEqual(updated!.replaced_count, 1);
        assert.deepStrictEqual(overlapOf(updated!).paths, ["src/format/currency.ts", SHARED]);
        // The Lead's own items never wake it.
        assert.lengthOf(yield* leadEvents, 0);
      }),
    ),
  );

  const raise = Effect.gen(function* () {
    yield* pairInBilling;
    yield* store(invoice, [SHARED]);
    yield* store(currency, [SHARED]);
    const [card] = yield* openOverlaps;
    assert.isDefined(card);
    // An ordinary new turn never outdates it.
    yield* store(invoice, ["src/invoice/other.ts"]);
    assert.lengthOf(yield* openOverlaps, 1);
    yield* TestClock.adjust("1 minute");
    return card!;
  });

  it.effect.each([
    [
      "a PR merge",
      linkPr(invoice, 318, "open").pipe(Effect.andThen(linkPr(invoice, 318, "merged"))),
    ],
    [
      "a PR close",
      linkPr(invoice, 318, "open").pipe(Effect.andThen(linkPr(invoice, 318, "closed"))),
    ],
    [
      "a settle",
      dispatch({ type: "thread.settle", commandId: CommandId.make("settle"), threadId: invoice }),
    ],
    ["an archive", dispatchThread("thread.archive", invoice)],
    ["a delete", dispatchThread("thread.delete", invoice)],
    [
      "a head-branch change",
      dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("branch"),
        threadId: invoice,
        branch: "fix/invoice-rounding-v2",
      }),
    ],
  ] as const)("%s outdates the item", ([, change]) =>
    withOverlap(
      Effect.gen(function* () {
        const card = yield* raise;
        yield* change;
        yield* changed(invoice);
        const after = (yield* overlapCards).find((candidate) => candidate.id === card.id);
        assert.strictEqual(after?.status, "outdated");
        assert.lengthOf(yield* openOverlaps, 0);
      }),
    ),
  );

  it.effect("a thread without a PR stays in until it is settled", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* raise;
        // An open PR on the other thread changes nothing.
        yield* linkPr(currency, 400, "open");
        yield* changed(currency);
        yield* store(currency, ["src/format/other.ts"]);
        assert.lengthOf(yield* openOverlaps, 1);
        yield* dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-currency"),
          threadId: currency,
        });
        yield* changed(currency);
        assert.lengthOf(yield* openOverlaps, 0);
      }),
    ),
  );

  it.effect(
    "a path its latest checkpoint diff no longer touches shrinks, then outdates, the item",
    () =>
      withOverlap(
        Effect.gen(function* () {
          yield* seed([releaseRow], [grantRow(release, "project", billing)]);
          yield* createThread(checkpointThread, billing, "Checkpointed");
          yield* createThread(currency, billing, "Currency display cleanup");
          const first = RunId.make("run-checkpointed-1");
          yield* Ref.set(checkpointRuns, [first]);
          yield* Ref.set(touched, [SHARED, "src/format/currency.ts"]);
          yield* store(checkpointThread, [SHARED, "src/format/currency.ts"], { runId: first });
          yield* store(currency, [SHARED, "src/format/currency.ts"]);
          const [card] = yield* openOverlaps;
          assert.deepStrictEqual(overlapOf(card!).paths, ["src/format/currency.ts", SHARED]);

          // The next turn reverts one shared file: the cumulative diff no longer touches it.
          const second = RunId.make("run-checkpointed-2");
          yield* Ref.set(checkpointRuns, [first, second]);
          yield* Ref.set(touched, [SHARED, "src/other.ts"]);
          yield* store(checkpointThread, ["src/other.ts"], { runId: second });
          const [shrunk] = yield* openOverlaps;
          assert.strictEqual(shrunk!.id, card!.id);
          assert.deepStrictEqual(overlapOf(shrunk!).paths, [SHARED]);
          // A shrink is not "updated".
          assert.strictEqual(shrunk!.replaced_count, 0);

          const third = RunId.make("run-checkpointed-3");
          yield* Ref.set(checkpointRuns, [first, second, third]);
          yield* Ref.set(touched, ["src/other.ts"]);
          yield* store(checkpointThread, ["src/other.ts"], { runId: third });
          assert.lengthOf(yield* openOverlaps, 0);
          assert.strictEqual((yield* overlapCards)[0]!.status, "outdated");
        }),
      ),
  );

  it.effect("a dismissed path never re-raises for that pair", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* pairInBilling;
        yield* store(invoice, [SHARED]);
        yield* store(currency, [SHARED]);
        const [card] = yield* openOverlaps;
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.updateCard({
          id: card!.id,
          fromStatuses: ["open"],
          patch: { status: "dismissed", resolution: "dismissed" },
          updatedAt: "2026-11-01T00:00:00.000Z",
        });
        for (let turn = 0; turn < 3; turn++) {
          yield* store(invoice, [SHARED]);
          yield* store(currency, [SHARED]);
        }
        assert.lengthOf(yield* openOverlaps, 0);

        // A newly shared path raises a fresh item with that path alone.
        yield* store(invoice, ["src/format/currency.ts"]);
        yield* store(currency, ["src/format/currency.ts"]);
        const [fresh] = yield* openOverlaps;
        assert.notStrictEqual(fresh!.id, card!.id);
        assert.deepStrictEqual(overlapOf(fresh!).paths, ["src/format/currency.ts"]);
      }),
    ),
  );

  it.effect("squire_raise_overlap merges into the open item and refuses dismissed paths", () =>
    withOverlap(
      Effect.gen(function* () {
        yield* pairInBilling;
        yield* store(invoice, [SHARED]);
        yield* store(currency, [SHARED]);
        const registry = yield* SquireToolKit.SquireToolRegistry;
        const handler = Option.getOrThrow(registry.get("squire_raise_overlap"));
        assert.deepStrictEqual(handler.roles, ["lead"]);
        const repository = yield* SquireRepository.SquireRepository;
        const leadRow = Option.getOrThrow(yield* repository.getSquire(lead));
        const kit = fakeKit(repository);
        const call = (key: string, paths: ReadonlyArray<string>) =>
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- handlers own their error types.
          handler
            .call(
              {
                caller: { squireId: lead, role: "lead", threadId: ThreadId.make("thr_lead_home") },
                squire: leadRow,
                run: { runId: "run-lead", origin: "user", batchId: null },
                tool: "squire_raise_overlap",
                key,
                args: {
                  threadIds: [currency, invoice],
                  paths,
                  reason: "Both rewrite the totals formatter.",
                  recommendation: "Land Fix invoice rounding first",
                },
                now: "2026-11-01T00:00:00.000Z",
              },
              kit,
            )
            .pipe(Effect.orDie);

        const merged = yield* call("invocation-key-merge-000000000", ["src/format/currency.ts"]);
        assert.isFalse(merged.isError);
        const [card, ...rest] = yield* overlapCards;
        assert.lengthOf(rest, 0);
        assert.strictEqual(card!.replaced_count, 1);
        assert.deepStrictEqual(overlapOf(card!).paths, ["src/format/currency.ts", SHARED]);

        yield* repository.updateCard({
          id: card!.id,
          fromStatuses: ["open"],
          patch: { status: "dismissed", resolution: "dismissed" },
          updatedAt: "2026-11-01T00:00:00.000Z",
        });
        const refused = yield* call("invocation-key-dismissed-0000000", [SHARED]);
        assert.isTrue(refused.isError);
        assert.lengthOf(yield* openOverlaps, 0);
      }),
    ),
  );
});

/** Just enough of the kit SquireTools builds per call: commit runs the body in a transaction. */
const fakeKit = (
  repository: SquireRepository.SquireRepository["Service"],
): SquireToolKit.SquireToolKit => {
  const ok = (text: string, structuredContent?: unknown) => ({
    isError: false,
    text,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  });
  const refused = (reason: string, text: string) => ({
    isError: true,
    text,
    structuredContent: { refused: reason },
  });
  return {
    ok,
    refused,
    refuse: (_ctx, reason, text) => Effect.succeed(refused(reason, text)),
    logRow: (ctx, kind, data, extra) =>
      repository.insertActionLog({
        squire_id: ctx.squire.id,
        kind,
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: extra?.threadId ?? null,
        card_id: extra?.cardId ?? null,
        event_id: null,
        run_id: ctx.run.runId,
        invocation_key: null,
        execution_key: null,
        data_json: JSON.stringify(data),
        created_at: ctx.now,
      }),
    commit: (_ctx, _threadId, body) =>
      repository.transaction(body).pipe(Effect.map((committed) => committed.result)),
    batchEvents: () => Effect.succeed([]),
    decodeArgs: (schema, args) =>
      Schema.decodeUnknownEffect(schema)(args).pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: String(error) })),
      ),
    holdUntil: (ctx) => ctx.now,
    notifyOn: () => false,
    policySquireOf: () => {
      throw new Error("unused");
    },
    budgetRowsOf: () => Effect.succeed([]),
    trackersFor: () => Effect.succeed([]),
  };
};

// ── Inject runs the same post-store hook ──

const decodeScenario = Schema.decodeUnknownSync(SquireFixtureScenario);
const scenario07 = decodeScenario(scenario07Json);
const scenario05 = decodeScenario(scenario05Json);
// Its only `"number": 318` is the event's summary PR.
const scenario01At321 = decodeScenario(
  JSON.parse(JSON.stringify(scenario01Json).replace('"number":318', '"number":321')),
);

describe("SquireOverlap over inject", () => {
  it.effect("an injected summary raises the overlap through the post-store hook", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* tempRoot;
      return yield* Effect.gen(function* () {
        yield* ServerRuntimeStartup.startLecturnReactors;
        const fixtures = yield* need(SquireDevFixtures.SquireDevFixtures);
        const loaded = yield* fixtures.loadSetup(scenario07.setup);
        const service = yield* need(SquireService.SquireService);
        const leadRow = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
        const repository = yield* SquireRepository.SquireRepository;
        for (const event of scenario07.events) {
          yield* fixtures.inject(event);
        }
        const [card, ...rest] = yield* repository.listCards({
          squireId: leadRow.id,
          kinds: ["overlap"],
        });
        assert.lengthOf(rest, 0);
        const payload = overlapOf(card!);
        assert.deepStrictEqual(payload.paths, [SHARED]);
        assert.strictEqual(
          payload.recommendation,
          "Land #321 first, then rebase Currency display cleanup",
        );
        assert.isDefined(loaded.squires["Release"]);
        // The summaries declare claudeAgent and codex, but the threads run on the scripted
        // provider, and the row and the card's thread lines both name what they run on.
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shells = yield* Effect.forEach(payload.threads, (thread) =>
          projections.getThreadShell(thread.threadId),
        );
        assert.deepStrictEqual(
          payload.threads.map((thread) => [thread.provider, thread.providerInstanceId]),
          shells.map((shell) => ["scripted", shell?.providerInstanceId]),
        );
        const row: Record<string, unknown> = SquireItems.squireCardRowFields(card!);
        assert.deepStrictEqual(row["overlapProviders"], ["scripted", "scripted"]);
        assert.deepStrictEqual(
          row["overlapProviderInstanceIds"],
          shells.map((shell) => shell?.providerInstanceId),
        );
      }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
    }).pipe(Effect.scoped),
  );

  it.effect("after #318 merged and #321 opened, the overlap names #321 and only its moments", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* tempRoot;
      return yield* Effect.gen(function* () {
        yield* ServerRuntimeStartup.startLecturnReactors;
        const fixtures = yield* need(SquireDevFixtures.SquireDevFixtures);
        const service = yield* need(SquireService.SquireService);
        const run = (scenario: typeof scenario07) =>
          Effect.gen(function* () {
            yield* fixtures.loadSetup(scenario.setup);
            // The Lead exists before any event, as in the stills procedure (it needs a project).
            yield* service.ensureLead({ requestId: "lead" });
            // Each command lands later than the last, as the boundaries need: 07 moves the
            // thread onto its branch, and #318 merged before 07's turns.
            yield* TestClock.adjust("1 minute");
            for (const event of scenario.events) yield* fixtures.inject(event);
            yield* TestClock.adjust("1 minute");
          });
        yield* run(scenario05);
        // The stills procedure's `--set events.0.summary.pullRequest.number=321`.
        yield* run(scenario01At321);
        yield* run(scenario07);
        const leadRow = Option.getOrThrow(yield* service.ensureLead({ requestId: "lead" }));
        const repository = yield* SquireRepository.SquireRepository;
        const [card, ...rest] = yield* repository.listCards({
          squireId: leadRow.id,
          kinds: ["overlap"],
        });
        assert.lengthOf(rest, 0);
        const payload = overlapOf(card!);
        assert.strictEqual(
          payload.recommendation,
          "Land #321 first, then rebase Currency display cleanup",
        );
        assert.deepStrictEqual(
          payload.threads.map((thread) => thread.pullRequest),
          [321, undefined],
        );
        const items = yield* need(SquireItems.SquireItems);
        const full = Option.getOrThrow(yield* items.get(card!.id));
        const texts = full.timeline.map((entry) => entry.text);
        assert.isTrue(
          texts.some((text) => text.includes("PR #321")),
          texts.join(" | "),
        );
        assert.isFalse(
          texts.some((text) => text.includes("#318")),
          texts.join(" | "),
        );
      }).pipe(Effect.scoped, Effect.provide(phase4Layer(baseDir)), Effect.orDie);
    }).pipe(Effect.scoped),
  );
});
