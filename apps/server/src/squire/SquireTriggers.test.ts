// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests sign bodies the way GitHub does.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  RunId,
  SquireCreateInput,
  SquireError,
  SquireId,
  type SquireTriggerCreateInput,
  SquireTriggerId,
  SquireTurnSummary,
  ThreadId,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import * as SquireService from "./SquireService.ts";
import { SquireRunSource, layer as summariesLayer } from "./SquireSummaries.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import { SquireEventPayloadJson } from "./squireEvents.ts";
import {
  initRepo,
  scripted,
  scriptedModel,
  seedProject,
  serverLayer,
  tempRoot,
} from "./testkit/lifecycleHarness.ts";
import { squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");
const lead = SquireId.make("squire:lead");
// A Monday.
const START = "2026-11-02T08:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const BODY_MARKER = "BODY-MARKER-7f3a";

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

const layerConfig = (squireEnabled: boolean) =>
  Layer.merge(
    ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-triggers-" }),
    SquireSwitch.layerTest(squireEnabled),
  ).pipe(Layer.provide(NodeServices.layer));

const withTriggers = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly enabled?: boolean; readonly inactivityDays?: number } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(START));
    return yield* effect;
  }).pipe(
    Effect.provide(
      SquireTriggers.layer.pipe(
        Layer.provideMerge(SquirePolicyLock.layer),
        Layer.provideMerge(SquireRepository.layer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(memorySecrets),
        Layer.provideMerge(
          ServerSettings.layerTest(
            options.inactivityDays === undefined
              ? {}
              : { squire: { inactivityDays: options.inactivityDays } },
          ),
        ),
        Layer.provideMerge(layerConfig(options.enabled ?? true)),
      ),
    ),
  );

const seed = (leadOverrides: Partial<SquireRepository.SquireRow> = {}) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    yield* repository.createSquire(squireRow(release));
    yield* repository.createSquire(
      squireRow(lead, {
        role: "lead",
        digest_json: JSON.stringify({ time: "08:00", push: false }),
        timezone: "America/New_York",
        ...leadOverrides,
      }),
    );
  });

let requestCounter = 0;
const nextRequestId = () => `request-${++requestCounter}`;

const schedule = (
  value: Extract<typeof SquireTriggerCreateInput.Type, { kind: "schedule" }>["schedule"],
  squireId = release,
) =>
  Effect.flatMap(SquireTriggers.SquireTriggers, (triggers) =>
    triggers.create({
      requestId: nextRequestId(),
      squireId,
      kind: "schedule",
      name: "Morning check",
      instruction: "Check the release threads",
      schedule: value,
    }),
  ).pipe(Effect.map((result) => result.trigger));

const webhook = (squireId = release) =>
  Effect.gen(function* () {
    const triggers = yield* SquireTriggers.SquireTriggers;
    const result = yield* triggers.create({
      requestId: nextRequestId(),
      squireId,
      kind: "webhook",
      name: "When CI fails on main",
      instruction: "Look at the failing run",
    });
    if (result.webhook === null) return yield* Effect.die("no secret");
    return { trigger: result.trigger, secret: result.webhook.secret };
  });

const body = (text = JSON.stringify({ action: "failed", note: BODY_MARKER })) =>
  new TextEncoder().encode(text);
const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
const hubSignature = (secret: string, bytes: Uint8Array) => ({
  "X-Hub-Signature-256": `sha256=${NodeCrypto.createHmac("sha256", secret).update(bytes).digest("hex")}`,
});
const receive = (
  triggerId: string,
  headers: Record<string, string>,
  bytes: Effect.Effect<Uint8Array, string> = Effect.succeed(body()),
) =>
  Effect.flatMap(SquireTriggers.SquireTriggers, (triggers) =>
    triggers.receive(triggerId, headers, bytes).pipe(Effect.map((result) => result.outcome)),
  );
// A body that must never be read.
const unreadBody = Effect.die("the body was read");

const events = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      readonly kind: string;
      readonly state_key: string;
      readonly status: string;
      readonly thread_id: string | null;
      readonly payload_json: string | null;
    }>`SELECT kind, state_key, status, thread_id, payload_json FROM squire_event ORDER BY id`,
);
const logKinds = (kind: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly data_json: string }>`SELECT data_json FROM squire_action_log
      WHERE kind = ${kind} ORDER BY id`,
  );
/** Every row of every Squire table, as JSON, so a value can be searched for anywhere. */
const dumpSquireTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'squire%'`;
  assert.isAtLeast(tables.length, 10);
  const rows = yield* Effect.forEach(tables, ({ name }) => sql`SELECT * FROM ${sql(name)}`);
  return JSON.stringify(rows);
});

const advance = (ms: number) => TestClock.adjust(ms).pipe(Effect.andThen(DateTime.now));
const fire = Effect.gen(function* () {
  const triggers = yield* SquireTriggers.SquireTriggers;
  return yield* triggers.fireDueSlots(yield* DateTime.now);
});
const testNow = (triggerId: SquireTriggerId, samplePayload?: string) =>
  Effect.flatMap(SquireTriggers.SquireTriggers, (triggers) =>
    triggers.test({
      requestId: nextRequestId(),
      triggerId,
      ...(samplePayload === undefined ? {} : { samplePayload }),
    }),
  );

const isSquireError = Schema.is(SquireError);
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isSquireError(error) ? error.code : error._tag)),
  );

describe("SquireTriggers schedules", () => {
  it.effect("queues one pending, thread-less event per slot keyed triggerId:slot", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const trigger = yield* schedule({ kind: "interval", hours: 1 });
        assert.equal(trigger.nextSlotAt, "2026-11-02T09:00:00.000Z");

        yield* advance(HOUR / 2);
        assert.equal(yield* fire, 0);
        yield* advance(HOUR / 2);
        assert.equal(yield* fire, 1);
        assert.equal(yield* fire, 0);
        yield* advance(HOUR);
        assert.equal(yield* fire, 1);

        const rows = yield* events;
        assert.deepStrictEqual(
          rows.map((row) => [row.kind, row.state_key, row.status, row.thread_id]),
          [
            ["schedule-due", `${trigger.id}:2026-11-02T09:00:00.000Z`, "pending", null],
            ["schedule-due", `${trigger.id}:2026-11-02T10:00:00.000Z`, "pending", null],
          ],
        );
        assert.deepStrictEqual(JSON.parse(rows[0]?.payload_json ?? "null"), {
          type: "schedule-due",
          triggerId: trigger.id,
          slot: "2026-11-02T09:00:00.000Z",
          instruction: "Check the release threads",
        });
        const triggers = yield* SquireTriggers.SquireTriggers;
        assert.equal(
          Option.map(yield* triggers.earliestSlotAt, DateTime.formatIso).pipe(Option.getOrNull),
          "2026-11-02T11:00:00.000Z",
        );
      }),
    ),
  );

  it.effect("fires once for the latest slot after downtime over 5 slots", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const trigger = yield* schedule({ kind: "interval", hours: 1 });
        yield* advance(5.5 * HOUR);
        assert.equal(yield* fire, 1);
        assert.deepStrictEqual(
          (yield* events).map((row) => row.state_key),
          [`${trigger.id}:2026-11-02T13:00:00.000Z`],
        );
        const [stored] = yield* (yield* SquireTriggers.SquireTriggers).list(release);
        assert.equal(stored?.nextSlotAt, "2026-11-02T14:00:00.000Z");
      }),
    ),
  );

  it.effect("skips weekends for a weekday schedule in the Lead's timezone", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        // Friday 10:00 in New York (EST, UTC-5).
        yield* TestClock.setTime(Date.parse("2026-11-06T15:00:00.000Z"));
        const trigger = yield* schedule({ kind: "daily", time: "09:00", weekdaysOnly: true });
        assert.equal(trigger.nextSlotAt, "2026-11-09T14:00:00.000Z");

        yield* TestClock.setTime(Date.parse("2026-11-07T14:00:00.000Z"));
        assert.equal(yield* fire, 0);
        yield* TestClock.setTime(Date.parse("2026-11-09T14:00:00.000Z"));
        assert.equal(yield* fire, 1);
        const [stored] = yield* (yield* SquireTriggers.SquireTriggers).list(release);
        assert.equal(stored?.nextSlotAt, "2026-11-10T14:00:00.000Z");
      }),
    ),
  );

  it.effect("fires nothing for a paused trigger, paused Squire, or inactivity pause", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        const repository = yield* SquireRepository.SquireRepository;
        const trigger = yield* schedule({ kind: "interval", hours: 1 });
        const at = (yield* DateTime.now).pipe(DateTime.formatIso);

        yield* triggers.update({ requestId: "pause", triggerId: trigger.id, status: "paused" });
        yield* advance(2 * HOUR);
        assert.equal(yield* fire, 0);
        assert.isTrue(Option.isNone(yield* triggers.earliestSlotAt));
        // Resuming re-arms from now instead of firing the slot missed while paused.
        const resumed = yield* triggers.update({
          requestId: "resume",
          triggerId: trigger.id,
          status: "active",
        });
        assert.equal(resumed.trigger.nextSlotAt, "2026-11-02T11:00:00.000Z");

        yield* repository.updateSquire({ id: release, patch: { status: "paused" }, updatedAt: at });
        yield* advance(HOUR);
        assert.equal(yield* fire, 0);
        assert.isTrue(Option.isNone(yield* triggers.earliestSlotAt));

        yield* repository.updateSquire({ id: release, patch: { status: "active" }, updatedAt: at });
        yield* repository.updateSquire({
          id: lead,
          patch: { automation_paused_at: at },
          updatedAt: at,
        });
        assert.equal(yield* fire, 0);
        assert.isTrue(Option.isNone(yield* triggers.earliestSlotAt));
        assert.lengthOf(yield* events, 0);
      }),
    ),
  );

  it.effect("fires nothing and answers not found with the switch off", () =>
    withTriggers(
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* seed();
        yield* repository.insertTrigger({
          id: SquireTriggerId.make("trigger-off"),
          squire_id: release,
          name: "Hourly",
          kind: "schedule",
          instruction: "Check",
          status: "active",
          schedule_json: JSON.stringify({ kind: "interval", hours: 1 }),
          next_slot_at: "2026-11-02T07:00:00.000Z",
          secret_ref: null,
          secret_generation: 0,
          last_payload_excerpt: null,
          created_at: START,
        });
        assert.equal(yield* fire, 0);
        assert.equal(yield* receive("trigger-off", {}, unreadBody), "not_found");
        assert.lengthOf(yield* events, 0);
      }),
      { enabled: false },
    ),
  );

  it.effect("refuses a webhook, a create, and a due slot once the switch turns off, live", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const hook = yield* webhook();
        yield* schedule({ kind: "interval", hours: 1 });
        yield* SubscriptionRef.set(yield* SquireSwitch.SquireSwitchControl, false);

        assert.equal(yield* receive(hook.trigger.id, bearer(hook.secret), unreadBody), "not_found");
        assert.equal(
          yield* refusal(schedule({ kind: "interval", hours: 2 })),
          "disabled_by_server",
        );
        yield* advance(2 * 60 * 60_000);
        assert.equal(yield* fire, 0);
        assert.lengthOf(yield* events, 0);

        yield* SubscriptionRef.set(yield* SquireSwitch.SquireSwitchControl, true);
        assert.equal(yield* receive(hook.trigger.id, bearer(hook.secret)), "queued");
      }),
    ),
  );
});

describe("SquireTriggers CRUD", () => {
  it.effect("refuses a 6th trigger and any trigger on the Lead", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        for (let n = 0; n < 5; n++) yield* schedule({ kind: "interval", hours: 2 });
        assert.equal(yield* refusal(schedule({ kind: "interval", hours: 2 })), "limit_reached");
        assert.equal(yield* refusal(webhook()), "limit_reached");
        assert.equal(yield* refusal(webhook(lead)), "invalid_request");
        assert.equal(
          yield* refusal(schedule({ kind: "interval", hours: 2 }, lead)),
          "invalid_request",
        );
        assert.lengthOf(yield* (yield* SquireTriggers.SquireTriggers).list(release), 5);
      }),
    ),
  );
});

describe("SquireTriggers run limits", () => {
  it.effect("drops runs over 6 per hour per trigger with exactly one rate-limited row", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const trigger = yield* schedule({ kind: "interval", hours: 1 });
        for (let n = 0; n < 6; n++) {
          yield* advance(60_000);
          assert.equal((yield* testNow(trigger.id)).outcome, "queued");
        }
        // The 7th run is the hourly slot itself: Test now counts toward the limit.
        yield* advance(HOUR - 6 * 60_000);
        assert.equal(yield* fire, 0);
        const limited = yield* testNow(trigger.id);
        assert.deepStrictEqual(limited, {
          outcome: "rate-limited",
          retryAt: "2026-11-02T09:01:00.000Z",
        });
        assert.lengthOf(yield* events, 6);
        assert.lengthOf(yield* logKinds("trigger.rate-limited"), 1);
        assert.lengthOf(yield* logKinds("trigger.received"), 6);
        const [stored] = yield* (yield* SquireTriggers.SquireTriggers).list(release);
        assert.equal(stored?.limitedUntil, "2026-11-02T09:01:00.000Z");

        // Once the oldest run ages out, one more run fits.
        yield* advance(60_000);
        assert.equal((yield* testNow(trigger.id)).outcome, "queued");
        assert.lengthOf(yield* logKinds("trigger.rate-limited"), 1);
      }),
    ),
  );

  it.effect("drops runs over 48 per day per Squire across its triggers", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const ids: Array<SquireTriggerId> = [];
        for (let n = 0; n < 5; n++) ids.push((yield* schedule({ kind: "interval", hours: 24 })).id);
        let queued = 0;
        while (queued < 48) {
          for (const id of ids) {
            if (queued === 48) break;
            assert.equal((yield* testNow(id)).outcome, "queued");
            queued += 1;
          }
          yield* advance(HOUR / 4);
        }
        const second = ids[1];
        if (second === undefined) return assert.fail("no triggers");
        assert.equal((yield* testNow(second)).outcome, "rate-limited");
        assert.equal((yield* testNow(second)).outcome, "rate-limited");
        const rows = yield* logKinds("trigger.rate-limited");
        assert.lengthOf(rows, 1);
        assert.equal(JSON.parse(rows[0]?.data_json ?? "{}").limit, "day");
      }),
    ),
  );
});

describe("SquireTriggers webhooks", () => {
  it.effect("a valid Bearer or HMAC request enqueues one event; a repeated delivery id none", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const { trigger, secret } = yield* webhook();
        assert.equal(
          yield* receive(trigger.id, { ...bearer(secret), "Idempotency-Key": "delivery-1" }),
          "queued",
        );
        const signed = body(JSON.stringify({ zen: "Keep it logically awesome." }));
        assert.equal(
          yield* receive(
            trigger.id,
            { ...hubSignature(secret, signed), "X-GitHub-Delivery": "gh-1" },
            Effect.succeed(signed),
          ),
          "queued",
        );
        assert.equal(
          yield* receive(trigger.id, { ...bearer(secret), "Idempotency-Key": "delivery-1" }),
          "duplicate",
        );
        const rows = yield* events;
        assert.deepStrictEqual(
          rows.map((row) => row.state_key),
          [`${trigger.id}:delivery-1`, `${trigger.id}:gh-1`],
        );
        assert.deepStrictEqual(JSON.parse(rows[1]?.payload_json ?? "null"), {
          type: "webhook-received",
          triggerId: trigger.id,
          deliveryId: "gh-1",
          instruction: "Look at the failing run",
          payloadExcerpt: '{"zen":"Keep it logically awesome."}',
        });
        assert.lengthOf(yield* logKinds("trigger.received"), 2);

        // No delivery header: the server makes an id, so each request is its own event.
        assert.equal(yield* receive(trigger.id, bearer(secret)), "queued");
        assert.lengthOf(yield* events, 3);
      }),
    ),
  );

  it.effect("caps the excerpt at 2,000 characters and refuses bodies over 64 KB", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const { trigger, secret } = yield* webhook();
        const large = body(JSON.stringify({ text: "x".repeat(10_000) }));
        assert.equal(yield* receive(trigger.id, bearer(secret), Effect.succeed(large)), "queued");
        const [row] = yield* events;
        const payload = JSON.parse(row?.payload_json ?? "{}");
        assert.lengthOf(payload.payloadExcerpt, 2000);

        const huge = new Uint8Array(64 * 1024 + 1);
        assert.equal(yield* receive(trigger.id, bearer(secret), Effect.succeed(huge)), "too_large");
        assert.equal(yield* receive(trigger.id, bearer(secret), Effect.fail("cap")), "too_large");
        assert.lengthOf(yield* logKinds("trigger.rejected"), 2);
        assert.lengthOf(yield* events, 1);
      }),
    ),
  );

  it.effect(
    "wrong secret, revoked, paused trigger, and paused Squire enqueue none and log no body",
    () =>
      withTriggers(
        Effect.gen(function* () {
          yield* seed();
          const triggers = yield* SquireTriggers.SquireTriggers;
          const repository = yield* SquireRepository.SquireRepository;
          const { trigger, secret } = yield* webhook();

          assert.equal(yield* receive(trigger.id, bearer("not-the-secret")), "unauthorized");
          assert.equal(
            yield* receive(trigger.id, hubSignature("not-the-secret", body())),
            "unauthorized",
          );
          assert.equal(yield* receive(trigger.id, {}), "unauthorized");
          assert.equal(yield* receive("trigger-unknown", bearer(secret), unreadBody), "not_found");

          yield* triggers.update({ requestId: "pause", triggerId: trigger.id, status: "paused" });
          assert.equal(yield* receive(trigger.id, bearer(secret), unreadBody), "not_found");
          yield* triggers.update({ requestId: "resume", triggerId: trigger.id, status: "active" });

          const at = START;
          yield* repository.updateSquire({
            id: release,
            patch: { status: "paused" },
            updatedAt: at,
          });
          assert.equal(yield* receive(trigger.id, bearer(secret), unreadBody), "not_found");
          yield* repository.updateSquire({
            id: release,
            patch: { status: "active" },
            updatedAt: at,
          });

          yield* triggers.revoke({ requestId: "revoke", triggerId: trigger.id });
          assert.equal(yield* receive(trigger.id, bearer(secret), unreadBody), "not_found");

          assert.lengthOf(yield* events, 0);
          assert.lengthOf(yield* logKinds("trigger.rejected"), 3);
          assert.notInclude(yield* dumpSquireTables, BODY_MARKER);
          assert.notInclude(yield* dumpSquireTables, secret);
        }),
      ),
  );

  it.effect("a pause committed while the body uploads wins over the admission", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        const repository = yield* SquireRepository.SquireRepository;
        const { trigger, secret } = yield* webhook();
        const pausedWhileUploading = triggers
          .update({ requestId: "pause", triggerId: trigger.id, status: "paused" })
          .pipe(Effect.as(body()), Effect.orDie);
        assert.equal(yield* receive(trigger.id, bearer(secret), pausedWhileUploading), "not_found");

        yield* triggers.update({ requestId: "resume", triggerId: trigger.id, status: "active" });
        const squirePausedWhileUploading = repository
          .updateSquire({ id: release, patch: { status: "paused" }, updatedAt: START })
          .pipe(Effect.as(body()), Effect.orDie);
        assert.equal(
          yield* receive(trigger.id, bearer(secret), squirePausedWhileUploading),
          "not_found",
        );
        assert.lengthOf(yield* events, 0);
      }),
    ),
  );

  it.effect("rotate invalidates the old secret, and no secret reaches a Squire table", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        const store = yield* ServerSecretStore.ServerSecretStore;
        const { trigger, secret } = yield* webhook();
        assert.equal(yield* receive(trigger.id, bearer(secret)), "queued");
        yield* testNow(trigger.id);

        const rotated = yield* triggers.rotate({ requestId: "rotate", triggerId: trigger.id });
        assert.equal(rotated.trigger.secretGeneration, 1);
        assert.equal(rotated.webhook.path, `/api/squire/hooks/${trigger.id}`);
        assert.notEqual(rotated.webhook.secret, secret);
        assert.isTrue(Option.isNone(yield* store.get(`squire-trigger:${trigger.id}:0`)));
        assert.equal(yield* receive(trigger.id, bearer(secret)), "unauthorized");
        assert.equal(yield* receive(trigger.id, bearer(rotated.webhook.secret)), "queued");

        const dump = yield* dumpSquireTables;
        assert.notInclude(dump, secret);
        assert.notInclude(dump, rotated.webhook.secret);
        assert.notInclude(dump, Buffer.from(secret).toString("hex"));
      }),
    ),
  );

  it.effect("Test now replays the last payload once per request id with a test: key", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        const { trigger, secret } = yield* webhook();
        const sent = body(JSON.stringify({ ref: "main" }));
        yield* receive(trigger.id, bearer(secret), Effect.succeed(sent));

        const input = { requestId: "test-1", triggerId: trigger.id };
        assert.equal((yield* triggers.test(input)).outcome, "queued");
        assert.equal((yield* triggers.test(input)).outcome, "queued");
        yield* testNow(trigger.id, "plain sample");

        const tests = (yield* events).filter((row) => row.state_key.startsWith("test:"));
        assert.deepStrictEqual(
          tests.map((row) => [row.state_key, JSON.parse(row.payload_json ?? "{}").payloadExcerpt]),
          [
            ["test:test-1", '{"ref":"main"}'],
            [tests[1]?.state_key, "plain sample"],
          ],
        );
      }),
    ),
  );
});

const DAY = 24 * HOUR;

const checkInactivity = Effect.gen(function* () {
  const triggers = yield* SquireTriggers.SquireTriggers;
  yield* triggers.checkInactivity(yield* DateTime.now);
});
const leadRow = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  Effect.map(repository.getSquire(lead), Option.getOrThrow),
);
const inactivityCards = Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
  repository.listCards({ squireId: lead, kinds: ["fyi"] }),
);

describe("SquireTriggers inactivity pause", () => {
  it.effect("posts one pushed FYI after the window and never a second", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        // Creating it is the user's last act.
        yield* schedule({ kind: "interval", hours: 1 });
        yield* advance(7 * DAY - 60_000);
        yield* checkInactivity;
        assert.lengthOf(yield* inactivityCards, 0);

        yield* advance(60_000);
        yield* checkInactivity;
        yield* advance(HOUR);
        yield* checkInactivity;
        const cards = yield* inactivityCards;
        assert.lengthOf(cards, 1);
        assert.equal(cards[0]?.status, "open");
        assert.equal(cards[0]?.title, "Keep Squire triggers running?");
        assert.equal(JSON.parse(cards[0]?.payload_json ?? "{}").source, "inactivity");
        assert.lengthOf(yield* logKinds("automation.prompted"), 1);
        assert.deepStrictEqual(
          (yield* logKinds("notification.pushed")).map((row) => JSON.parse(row.data_json)),
          [{ kind: "fyi", source: "inactivity" }],
        );
        assert.isNull((yield* leadRow).automation_paused_at);
      }),
    ),
  );

  it.effect("pauses after 48 h without an answer, says so to the Lead, and Keep resumes", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        yield* schedule({ kind: "interval", hours: 1 });
        const { trigger: hook, secret } = yield* webhook();
        yield* advance(7 * DAY);
        assert.equal(yield* fire, 1);
        yield* checkInactivity;

        yield* advance(48 * HOUR - 60_000);
        yield* checkInactivity;
        assert.isNull((yield* leadRow).automation_paused_at);
        assert.equal(yield* fire, 1);
        yield* advance(60_000);
        yield* checkInactivity;
        yield* checkInactivity;
        assert.isNotNull((yield* leadRow).automation_paused_at);
        assert.lengthOf(yield* logKinds("automation.paused"), 1);
        const notices = (yield* events).filter((row) => row.kind === "message");
        assert.lengthOf(notices, 1);
        const notice = JSON.parse(notices[0]?.payload_json ?? "{}");
        assert.deepStrictEqual(notice.from, { kind: "system" });
        assert.include(notice.body, "paused every Squire trigger and the find-work sweep");
        // The card stays open, so Keep on it can resume.
        assert.equal((yield* inactivityCards)[0]?.status, "open");

        // Schedules and webhooks fire nothing while paused.
        const before = (yield* events).length;
        yield* advance(5 * HOUR);
        assert.equal(yield* fire, 0);
        assert.isTrue(Option.isNone(yield* triggers.earliestSlotAt));
        assert.equal(yield* receive(hook.id, bearer(secret)), "not_found");
        assert.lengthOf(yield* events, before);

        yield* triggers.answerInactivity({ keep: true });
        assert.isNull((yield* leadRow).automation_paused_at);
        assert.equal((yield* inactivityCards)[0]?.status, "resolved");
        // Re-armed from now: the slots missed while paused never fire.
        assert.equal(yield* fire, 0);
        yield* advance(HOUR);
        assert.equal(yield* fire, 1);
      }),
    ),
  );

  it.effect("resumes all, or only the named triggers, re-armed from now", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const triggers = yield* SquireTriggers.SquireTriggers;
        const hourly = yield* schedule({ kind: "interval", hours: 1 });
        const twoHourly = yield* schedule({ kind: "interval", hours: 2 });

        yield* triggers.answerInactivity({ keep: false });
        assert.isNotNull((yield* leadRow).automation_paused_at);
        yield* advance(5 * HOUR);
        assert.equal(yield* fire, 0);

        yield* triggers.resumeAutomation({ requestId: "resume-all" });
        assert.isNull((yield* leadRow).automation_paused_at);
        const resumed = yield* triggers.list(release);
        assert.deepStrictEqual(
          resumed.map((trigger) => [trigger.status, trigger.nextSlotAt]),
          [
            ["active", "2026-11-02T14:00:00.000Z"],
            ["active", "2026-11-02T15:00:00.000Z"],
          ],
        );
        assert.equal(yield* fire, 0);

        yield* triggers.answerInactivity({ keep: false });
        yield* advance(5 * HOUR);
        yield* triggers.resumeAutomation({ requestId: "resume-one", triggerIds: [twoHourly.id] });
        const one = yield* triggers.list(release);
        assert.deepStrictEqual(
          one.map((trigger) => [trigger.id, trigger.status, trigger.nextSlotAt]),
          [
            [hourly.id, "paused", null],
            [twoHourly.id, "active", "2026-11-02T20:00:00.000Z"],
          ],
        );
        yield* advance(2 * HOUR);
        assert.equal(yield* fire, 1);
        assert.deepStrictEqual(
          (yield* events).map((row) => row.state_key),
          [`${twoHourly.id}:2026-11-02T20:00:00.000Z`],
        );
        assert.deepStrictEqual(
          (yield* logKinds("automation.resumed")).map((row) => JSON.parse(row.data_json).scope),
          ["all", "triggers"],
        );
      }),
    ),
  );

  it.effect("Keep resets the window, in the configured number of days", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed({ permissions_json: JSON.stringify({ notify: "off" }) });
        const triggers = yield* SquireTriggers.SquireTriggers;
        yield* schedule({ kind: "interval", hours: 1 });
        yield* advance(2 * DAY);
        yield* checkInactivity;
        assert.lengthOf(yield* inactivityCards, 1);
        // Notify Off: the item is there, nothing is pushed.
        assert.lengthOf(yield* logKinds("notification.pushed"), 0);

        yield* advance(HOUR);
        yield* triggers.answerInactivity({ keep: true });
        assert.deepStrictEqual(
          (yield* inactivityCards).map((card) => [card.status, card.resolution]),
          [["resolved", "kept"]],
        );
        yield* advance(2 * DAY - 60_000);
        yield* checkInactivity;
        assert.isNull((yield* leadRow).automation_paused_at);
        assert.lengthOf(yield* inactivityCards, 1);
        yield* advance(60_000);
        yield* checkInactivity;
        assert.deepStrictEqual(
          (yield* inactivityCards).map((card) => card.status),
          ["resolved", "open"],
        );
      }),
      { inactivityDays: 2 },
    ),
  );

  it.effect(
    "user trigger RPCs stamp activity at most every 10 minutes, without a revision bump",
    () =>
      withTriggers(
        Effect.gen(function* () {
          yield* seed();
          const triggers = yield* SquireTriggers.SquireTriggers;
          const revision = (yield* leadRow).revision;
          const trigger = yield* schedule({ kind: "interval", hours: 1 });
          assert.equal((yield* leadRow).user_active_at, START);

          yield* advance(9 * 60_000);
          yield* triggers.update({ requestId: "rename", triggerId: trigger.id, name: "Renamed" });
          assert.equal((yield* leadRow).user_active_at, START);
          yield* advance(60_000);
          yield* testNow(trigger.id);
          assert.equal((yield* leadRow).user_active_at, "2026-11-02T08:10:00.000Z");
          // Server-side firing is not the user acting.
          yield* advance(HOUR);
          yield* fire;
          assert.equal((yield* leadRow).user_active_at, "2026-11-02T08:10:00.000Z");
          assert.equal((yield* leadRow).revision, revision);
        }),
      ),
  );

  it.effect("a change to the squire settings block stamps activity; other settings do not", () =>
    withTriggers(
      Effect.gen(function* () {
        yield* seed();
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* schedule({ kind: "interval", hours: 1 });
        yield* checkInactivity;

        yield* advance(HOUR);
        yield* settings.updateSettings({ reviewGuidesEnabled: true });
        yield* checkInactivity;
        assert.equal((yield* leadRow).user_active_at, START);

        yield* settings.updateSettings({ squire: { inactivityDays: 3 } });
        yield* checkInactivity;
        assert.equal((yield* leadRow).user_active_at, "2026-11-02T09:00:00.000Z");
      }),
    ),
  );
});

const homeProject = ProjectId.make("project-home");
const tracked = ThreadId.make("thread-tracked");
const decodeCreateInput = Schema.decodeSync(SquireCreateInput);
const decodeSummary = Schema.decodeSync(SquireTurnSummary);
const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const encodeEventPayload = Schema.encodeSync(SquireEventPayloadJson);

describe("SquireTriggers inactivity pause, tracked threads", () => {
  // The real orchestrator and delivery, as in SquireDelivery.test.ts; nothing here waits on time.
  it.live("still delivers a tracked thread's event while triggers are paused", () =>
    Effect.gen(function* () {
      const { root, baseDir } = yield* tempRoot;
      const server = serverLayer(baseDir, { defaultModelSelection: scriptedModel });
      const summaries = summariesLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(SquireRunSource)({}),
            Layer.mock(TextGeneration)({}),
            ServerSettings.layerTest(),
          ),
        ),
        Layer.provide(server),
      );
      yield* Effect.gen(function* () {
        yield* seedProject(homeProject, initRepo(`${root}/home-project`));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${tracked}:create`),
          threadId: tracked,
          projectId: homeProject,
          title: "Fix invoice rounding",
          modelSelection: scriptedModel,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const service = yield* SquireService.SquireService;
        const squire = yield* service.create(
          decodeCreateInput({
            requestId: "release",
            homeProjectId: homeProject,
            providerInstanceId: scripted,
            modelSelection: scriptedModel,
            name: "Release",
            brief: "Release brief.",
            grants: [{ kind: "project", targetId: homeProject }],
            events: {},
            permissions: {},
            budgets: {},
          }),
        );
        const repository = yield* SquireRepository.SquireRepository;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* repository.createSquire(
          squireRow(lead, { role: "lead", automation_paused_at: now }),
        );
        yield* repository.insertSummary({
          thread_id: tracked,
          run_id: RunId.make("run-1"),
          stage: "terminal",
          status: "complete",
          summary_json: encodeSummary(
            decodeSummary({
              threadId: tracked,
              threadTitle: "Fix invoice rounding",
              project: "project-home",
              provider: "claudeAgent",
              turnId: RunId.make("run-1"),
              outcome: "finished",
              summaryStatus: "complete",
              goal: "Round invoices to cents",
              completed: [],
              remaining: [],
              blocked: [],
              pendingQuestion: null,
              suggestedNextStep: null,
              files: { entries: [], counts: { added: 0, modified: 0, deleted: 0 } },
              commands: [],
              pullRequest: null,
            }),
          ),
          payer_squire_id: null,
          created_at: now,
          updated_at: now,
        });
        assert.isTrue(
          yield* repository.insertEvent({
            squire_id: squire.id,
            thread_id: tracked,
            kind: "turn-finished",
            state_key: "run-1",
            payload_json: encodeEventPayload({
              outcome: "finished",
              runId: RunId.make("run-1"),
              pendingRequest: null,
              pullRequest: null,
            }),
            status: "pending",
            defer_reason: null,
            not_before: now,
            batch_id: null,
            created_at: now,
          }),
        );

        yield* (yield* SquireDelivery.SquireDelivery).deliverReady(squire.id);
        const projection = yield* orchestrator.getThreadProjection(squire.homeThreadId!);
        const delivered = projection.messages.filter((message) =>
          message.id.startsWith("message:squire:"),
        );
        assert.lengthOf(delivered, 1);
        assert.include(delivered[0]!.text, "Round invoices to cents");
      }).pipe(
        Effect.provide(
          SquireDelivery.layer.pipe(Layer.provideMerge(summaries), Layer.provideMerge(server)),
        ),
      );
    }).pipe(Effect.scoped),
  );
});
