import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  isUnknownUnionMember,
  SquireCardId,
  type SquireError,
  SquireId,
  type SquireItemsActResult,
  SquireRpcs,
  WS_METHODS as M,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireActions from "./SquireActions.ts";
import * as SquireContainers from "./SquireContainers.ts";
import * as SquireLeadRpc from "./SquireLeadRpc.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireRpcHandlers from "./SquireRpcHandlers.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireService from "./SquireService.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import { invoiceThread, need, withRoomCast } from "./testkit/roomHarness.ts";
import { orchestratorLayer, squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");

const layerConfig = (squireEnabled: boolean) =>
  Layer.merge(
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-rpc-" }),
    SquireSwitch.layerTest(squireEnabled),
  ).pipe(Layer.provide(NodeServices.layer));

const memorySecrets = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const store = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(store.get(name))),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    create: (name, value) => Effect.sync(() => void store.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void store.delete(name)),
  });
});

type Outcome = Effect.Effect<unknown, SquireError> | Stream.Stream<unknown, SquireError>;

/** Calls a handler with an empty input: a refusal comes before any service reads it. */
const refusalCode = (handlers: SquireRpcHandlers.SquireRpcHandlers, tag: (typeof tags)[number]) => {
  const handler: (input: never) => Outcome = handlers[tag];
  const outcome = handler({} as never);
  const run = Stream.isStream(outcome) ? Stream.runDrain(outcome) : outcome;
  return run.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "served" }));
};
const tags = SquireRpcs.map((rpc) => rpc._tag);

let ensureCalls = 0;
// Present, so a subscribe that reached for the Lead would find a way to make one.
const recordingService = Layer.mock(SquireService.SquireService)({
  ensureLead: () =>
    Effect.sync(() => {
      ensureCalls += 1;
      return Option.none();
    }),
});

describe("Squire RPC kill switch", () => {
  it.effect("refuses every method with the switch off, even with services present", () =>
    Effect.gen(function* () {
      const handlers = yield* SquireRpcHandlers.make();
      for (const tag of tags) {
        assert.equal(yield* refusalCode(handlers, tag), "disabled_by_server", tag);
      }
    }).pipe(Effect.provide(Layer.mergeAll(SquireLeadRpc.layer, layerConfig(false)))),
  );

  it.effect("refuses every method whose service is absent with the switch on", () =>
    Effect.gen(function* () {
      const handlers = yield* SquireRpcHandlers.make();
      for (const tag of tags) {
        assert.equal(yield* refusalCode(handlers, tag), "disabled_by_server", tag);
      }
    }).pipe(Effect.provide(layerConfig(true))),
  );

  it.effect("refuses Lead open and control revert as not available until Phase 7", () =>
    Effect.gen(function* () {
      const handlers = yield* SquireRpcHandlers.make();
      const open = yield* handlers[M.squireLeadOpen]({ requestId: "open-1" }).pipe(Effect.flip);
      assert.equal(open.code, "not_available");
      const revert = yield* handlers[M.squireControlRevert]({
        requestId: "revert-1",
        logEntryId: 1,
      }).pipe(Effect.flip);
      assert.equal(revert.code, "not_available");
    }).pipe(Effect.provide(Layer.mergeAll(SquireLeadRpc.layer, layerConfig(true)))),
  );
});

describe("Squire RPC handlers", () => {
  it.effect("subscribe reports no Lead and never creates one", () =>
    Effect.gen(function* () {
      const handlers = yield* SquireRpcHandlers.make();
      const first = yield* handlers[M.squireSubscribe]().pipe(Stream.runHead);
      const event = Option.getOrThrow(first);
      assert.isFalse(isUnknownUnionMember(event));
      if (isUnknownUnionMember(event)) return;
      assert.equal(event.type, "snapshot");
      if (event.type === "snapshot") assert.isNull(event.snapshot.lead);
      const repository = yield* SquireRepository.SquireRepository;
      assert.isTrue(Option.isNone(yield* repository.getLead));
      assert.equal(ensureCalls, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SquireReadModel.layer, recordingService).pipe(
          Layer.provideMerge(SquireScope.layer),
          Layer.provideMerge(SquireRepository.layer),
          Layer.provideMerge(SquireContainers.layerTest({})),
          Layer.provideMerge(orchestratorLayer),
          Layer.provideMerge(layerConfig(true)),
        ),
      ),
    ),
  );

  it.effect("passes a question card's answer through to SquireActions", () => {
    const received: Array<SquireActions.SquireActionsActInput> = [];
    const result: typeof SquireItemsActResult.Type = { results: [] };
    return Effect.gen(function* () {
      const handlers = yield* SquireRpcHandlers.make();
      const answer = { answers: { scope: "Only main" } };
      yield* handlers[M.squireItemsAct]({
        requestId: "act-1",
        cardIds: [SquireCardId.make("card:question")],
        action: "accept",
        answer,
      });
      assert.deepEqual(
        received.map((input) => input.answer),
        [answer],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SquireActions.SquireActions)({
            act: (input) => Effect.sync(() => void received.push(input)).pipe(Effect.as(result)),
          }),
          layerConfig(true),
        ),
      ),
    );
  });

  it.effect("returns a webhook secret from create and rotate only", () =>
    Effect.gen(function* () {
      const repository = yield* SquireRepository.SquireRepository;
      yield* repository.createSquire(squireRow(release));
      const handlers = yield* SquireRpcHandlers.make();

      const created = yield* handlers[M.squireTriggerCreate]({
        requestId: "trigger-1",
        squireId: release,
        kind: "webhook",
        name: "When CI fails on main",
        instruction: "Look at the failing run",
      });
      assert.isNotNull(created.webhook);
      const secret = created.webhook?.secret ?? "";
      const triggerId = created.trigger.id;

      const listed = yield* handlers[M.squireTriggerList]({ squireId: release });
      assert.notInclude(JSON.stringify(listed), secret);
      const updated = yield* handlers[M.squireTriggerUpdate]({
        requestId: "trigger-2",
        triggerId,
        status: "paused",
      });
      assert.notInclude(JSON.stringify(updated), secret);

      const rotated = yield* handlers[M.squireTriggerRotate]({ requestId: "trigger-3", triggerId });
      assert.notEqual(rotated.webhook.secret, secret);
      const relisted = yield* handlers[M.squireTriggerList]({ squireId: release });
      assert.notInclude(JSON.stringify(relisted), rotated.webhook.secret);
      const revoked = yield* handlers[M.squireTriggerRevoke]({ requestId: "trigger-4", triggerId });
      assert.notInclude(JSON.stringify(revoked), rotated.webhook.secret);
    }).pipe(
      Effect.provide(
        SquireTriggers.layer.pipe(
          Layer.provideMerge(SquirePolicyLock.layer),
          Layer.provideMerge(SquireRepository.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(memorySecrets),
          Layer.provideMerge(ServerSettings.layerTest()),
          Layer.provideMerge(layerConfig(true)),
        ),
      ),
    ),
  );
});

describe("Squire room RPCs", () => {
  it.effect("a retried squire.room.post is one post and one message row", () =>
    withRoomCast((cast) =>
      Effect.gen(function* () {
        const handlers = yield* SquireRpcHandlers.make();
        const { room } = yield* handlers[M.squireRoomCreate]({
          requestId: "rpc-room",
          topic: "Invoice rounding",
          members: [cast.release.squireId, cast.research.squireId],
          includesLead: false,
        });
        const input = {
          requestId: "rpc-post",
          roomId: room.id,
          body: "Is the rounding fix safe to ship?",
          refs: [{ kind: "thread" as const, threadId: invoiceThread }],
        };
        const first = yield* handlers[M.squireRoomPost](input);
        const retry = yield* handlers[M.squireRoomPost](input);
        assert.strictEqual(retry.post.id, first.post.id);

        const { posts } = yield* handlers[M.squireRoomPosts]({ roomId: room.id });
        assert.deepEqual(
          posts.map((post) => post.id),
          [first.post.id],
        );
        const repository = yield* need(SquireRepository.SquireRepository);
        const rows = yield* repository.listEventsByStatus({
          squireId: cast.release.squireId,
          statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
        });
        assert.lengthOf(
          rows.filter((row) => row.kind === "message" && row.state_key === "rpc-post"),
          1,
        );
      }),
    ),
  );
});
