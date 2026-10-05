import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@lecturn/contracts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { applyContextualLifecycle, make } from "./ContextualLifecycle.ts";
const parent = ThreadId.make("parent"),
  child = ThreadId.make("child"),
  now = "2026-09-26T00:00:00.000Z";
const fork: Extract<OrchestrationEvent, { type: "thread.forked" }> = {
  type: "thread.forked",
  sequence: 3,
  eventId: EventId.make("fork"),
  aggregateKind: "thread",
  aggregateId: child,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: child,
    forkedFrom: { threadId: parent, turnId: TurnId.make("turn"), turnCount: 1, messageId: null },
    forkSource: null,
    contextualMessageIdMap: [
      { sourceId: MessageId.make("one"), targetId: MessageId.make("copy-one") },
    ],
    history: {
      messages: [
        {
          id: MessageId.make("copy-one"),
          role: "user",
          text: "Synthetic",
          createdAt: now,
          updatedAt: now,
          turnId: null,
          streaming: false,
        },
      ],
      activities: [],
      proposedPlans: [],
      turns: [],
    },
  },
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "contextual_supply",
    "contextual_inherited_disclosures",
    "contextual_exclusions",
    "contextual_context_boundaries",
    "contextual_thread_settings",
    "contextual_outbox",
  ])
    yield* sql`DELETE FROM ${sql(table)}`;
  yield* sql`INSERT INTO contextual_thread_settings(thread_id,project_id,updated_at) VALUES(${parent},'p',${now})`;
  return sql;
});
it.layer(SqlitePersistenceMemory)("Contextual continuity", (it) => {
  it.effect("copies only mapped prefix supply and retains exclusions idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* fixture;
      for (const message of ["one", "later"])
        yield* sql`INSERT INTO contextual_supply VALUES(${parent},${message},${message},'initial',${message},${message},${message},1,'accepted',${now})`;
      yield* sql`INSERT INTO contextual_exclusions VALUES(${parent},'excluded','action')`;
      yield* applyContextualLifecycle(sql, fork);
      yield* applyContextualLifecycle(sql, fork);
      const rows = yield* sql<{
        guidance_id: string;
        message_id: string;
      }>`SELECT guidance_id,message_id FROM contextual_supply WHERE thread_id=${child}`;
      assert.deepEqual(rows, [{ guidance_id: "one", message_id: "copy-one" }]);
      assert.equal(
        (yield* sql`SELECT * FROM contextual_exclusions WHERE thread_id=${child}`).length,
        1,
      );
    }),
  );
  it.effect("deduplicates native compaction across restart and ignores unproven events", () =>
    Effect.gen(function* () {
      const sql = yield* fixture;
      const directory = ProviderSessionDirectory.of({
        getBinding: () =>
          Effect.succeed(
            Option.some({
              threadId: parent,
              provider: ProviderDriverKind.make("codex"),
              resumeCursor: { threadId: "native" },
            }),
          ),
        getProvider: () => Effect.succeed(ProviderDriverKind.make("codex")),
        upsert: () => Effect.void,
        listThreadIds: () => Effect.succeed([parent]),
        listBindings: () => Effect.succeed([]),
      });
      const service = yield* make.pipe(Effect.provideService(ProviderSessionDirectory, directory));
      const event: ProviderRuntimeEvent = {
        type: "thread.state.changed",
        eventId: EventId.make("native-event"),
        threadId: parent,
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        payload: { state: "compacted" },
        raw: {
          source: "codex.app-server.notification",
          method: "thread/compacted",
          payload: { threadId: "native", turnId: "native-turn" },
        },
      };
      yield* service.observe({ ...event, raw: undefined });
      assert.equal(
        (yield* sql<{
          context_epoch: string;
        }>`SELECT context_epoch FROM contextual_thread_settings`)[0]?.context_epoch,
        "initial",
      );
      yield* service.observe(event);
      const restarted = yield* make.pipe(
        Effect.provideService(ProviderSessionDirectory, directory),
      );
      yield* restarted.observe({ ...event, eventId: EventId.make("replayed") });
      assert.equal((yield* sql`SELECT * FROM contextual_context_boundaries`).length, 1);
      assert.equal(
        (yield* sql<{
          context_epoch: string;
        }>`SELECT context_epoch FROM contextual_thread_settings`)[0]?.context_epoch,
        "compaction:codex:native:turn:native-turn",
      );
    }),
  );
});
