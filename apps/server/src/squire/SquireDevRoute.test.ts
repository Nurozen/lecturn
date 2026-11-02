/**
 * `POST /api/dev/squire/fixture` (8.2) served over the server's Squire wiring
 * (`phase4Layer`: switch-on `layerSquire` with test providers on, a real
 * orchestrator, the scripted provider).
 */
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  SquireActionLogEntry,
  SquireError,
  SquireFixtureScenario,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SquireHttp from "./http.ts";
import * as SquireReadModel from "./SquireReadModel.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { tempRoot } from "./testkit/lifecycleHarness.ts";
import { type Phase4Options, type Phase4Services, phase4Layer } from "./testkit/phase4Harness.ts";
import scenario05Json from "./testdata/scenarios/05-merged-propose-thread.json" with { type: "json" };

const scenario05 = Schema.decodeUnknownSync(SquireFixtureScenario)(scenario05Json);
const encodeRequest = Schema.encodeSync(SquireHttp.SquireDevFixtureRequest);

// Bearer `operate` or `read` stands for a session with that scope; anything else is refused.
const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    const scopes =
      token === "operate"
        ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
        : token === "read"
          ? [AuthOrchestrationReadScope]
          : undefined;
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError())
      : Effect.succeed({
          sessionId: AuthSessionId.make("session-test"),
          subject: "test",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
});

const withRoute = <A, E>(
  body: Effect.Effect<A, E, HttpClient.HttpClient | Phase4Services | Scope.Scope>,
  options: Phase4Options = {},
) =>
  Effect.gen(function* () {
    const { baseDir } = yield* tempRoot;
    const served = HttpRouter.serve(SquireHttp.layer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(Layer.provide(layerAuth));
    return yield* body.pipe(
      Effect.scoped,
      Effect.provide(
        served.pipe(
          Layer.provideMerge(phase4Layer(baseDir, options)),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.orDie);

const post = (token: string | undefined, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(SquireHttp.SQUIRE_DEV_FIXTURE_ROUTE).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* client.execute(
      token === undefined ? request : HttpClientRequest.bearerToken(request, token),
    );
    const json = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    return { status: response.status, json };
  });

const voiceNote = (id: string) =>
  encodeRequest({
    op: "inject",
    event: {
      type: "voice-note",
      voiceNoteId: id,
      transcript: "Check the release threads",
      speakerVerified: true,
      source: "dictation",
    } as never,
  });

describe("Squire dev fixture route", () => {
  it.effect("is absent with the switch off, before auth and for an operate session", () =>
    withRoute(
      Effect.gen(function* () {
        assert.strictEqual((yield* post(undefined, {})).status, 404);
        const loaded = yield* post(
          "operate",
          encodeRequest({ op: "loadSetup", setup: scenario05.setup }),
        );
        assert.strictEqual(loaded.status, 404);
        const repository = yield* SquireRepository.SquireRepository;
        assert.lengthOf(yield* repository.listSquires, 0);
      }),
      { squireEnabled: false },
    ),
  );

  it.effect("is absent when the fixture seam is not provided (no LECTURN_TEST_PROVIDERS)", () =>
    Effect.gen(function* () {
      // SquireDevFixtures is what `layerSquire` withholds without test providers.
      const served = HttpRouter.serve(SquireHttp.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(layerAuth), Layer.provideMerge(NodeHttpServer.layerTest));
      const response = yield* post("operate", { op: "reset", name: "Release" }).pipe(
        Effect.provide(served),
      );
      assert.strictEqual(response.status, 404);
    }).pipe(Effect.scoped),
  );

  it.effect("needs orchestration:operate before it reads the body", () =>
    withRoute(
      Effect.gen(function* () {
        // The 401 is what `squire load-fixture` probes for.
        assert.strictEqual((yield* post(undefined, "not json")).status, 401);
        assert.strictEqual(
          (yield* post("read", encodeRequest({ op: "reset", name: "Release" }))).status,
          403,
        );
        assert.strictEqual((yield* post("operate", { op: "explode" })).status, 400);
      }),
    ),
  );

  it.effect("loads a setup, injects with dedupe, maps fixture failures, and resets", () =>
    withRoute(
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const loaded = yield* post(
          "operate",
          encodeRequest({ op: "loadSetup", setup: scenario05.setup }),
        );
        assert.strictEqual(loaded.status, 200);
        const squireId = (loaded.json as { readonly squireId: string }).squireId;
        const row = Option.getOrThrow(
          yield* repository.getSquireByCreateRequestId("fixture:Release"),
        );
        assert.strictEqual(row.id, squireId);

        const first = yield* post("operate", voiceNote("voice-1"));
        assert.strictEqual(first.status, 200);
        const sequence = (first.json as { readonly sequence: number }).sequence;
        assert.isNumber(sequence);
        // D45: a duplicate inject answers with the original row.
        assert.deepStrictEqual((yield* post("operate", voiceNote("voice-1"))).json, { sequence });

        const restart = yield* post(
          "operate",
          encodeRequest({ op: "timeline", action: { action: "restart", downtimeSeconds: 60 } }),
        );
        assert.strictEqual(restart.status, 422);
        assert.strictEqual(
          (restart.json as { readonly error: string }).error,
          "SquireFixtureActionUnavailable",
        );

        const reset = yield* post("operate", encodeRequest({ op: "reset", name: "Release" }));
        assert.strictEqual(reset.status, 200);
        assert.isTrue(
          Option.isNone(yield* repository.getSquireByCreateRequestId("fixture:Release")),
        );
      }),
    ),
  );
});

const decodeLogEntry = Schema.decodeUnknownSync(SquireActionLogEntry);
const logEntry = (id: number) =>
  decodeLogEntry({
    id,
    squireId: "squire:release",
    kind: "quiet.recorded",
    threadId: null,
    cardId: null,
    eventId: null,
    runId: null,
    roomId: null,
    postId: null,
    triggerId: null,
    taskId: null,
    data: { reason: `entry ${id}` },
    createdAt: "2026-11-01T09:00:00.000Z",
  });

/** The export over a read model that pages 250 entries newest first, 200 per page. */
const exportGet = (token: string | undefined, path: string, readModel: boolean) =>
  Effect.gen(function* () {
    const entries = Array.from({ length: 250 }, (_, index) => logEntry(250 - index));
    const layerReadModel = Layer.mock(SquireReadModel.SquireReadModel)({
      actionLogList: (input) => {
        if (input.squireId !== "squire:release") {
          return Effect.fail(new SquireError({ code: "not_found", message: "No such Squire." }));
        }
        const start =
          input.before === undefined ? 0 : entries.findIndex((entry) => entry.id < input.before!);
        const page = entries.slice(start, start + (input.limit ?? 50));
        const last = page.at(-1);
        return Effect.succeed({
          entries: page,
          nextBefore: start + page.length < entries.length && last ? last.id : null,
        });
      },
    });
    const served = HttpRouter.serve(SquireHttp.layer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(layerAuth),
      Layer.provide(readModel ? layerReadModel : Layer.empty),
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    return yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = HttpClientRequest.get(path);
      const response = yield* client.execute(
        token === undefined ? request : HttpClientRequest.bearerToken(request, token),
      );
      return {
        status: response.status,
        type: response.headers["content-type"],
        text: yield* response.text,
      };
    }).pipe(Effect.provide(served));
  }).pipe(Effect.scoped);

describe("Squire action-log export", () => {
  it.effect("streams every page as NDJSON, newest first, to a read-scoped session", () =>
    Effect.gen(function* () {
      const response = yield* exportGet("read", "/api/squire/squire:release/action-log", true);
      assert.strictEqual(response.status, 200);
      assert.include(response.type ?? "", "application/x-ndjson");
      const lines = response.text.trimEnd().split("\n");
      assert.lengthOf(lines, 250);
      const ids = lines.map((line) => (JSON.parse(line) as { readonly id: number }).id);
      assert.deepStrictEqual(ids.slice(0, 2), [250, 249]);
      assert.strictEqual(ids.at(-1), 1);
    }),
  );

  it.effect("needs a session, and answers 404 for an unknown Squire or with the switch off", () =>
    Effect.gen(function* () {
      const path = "/api/squire/squire:release/action-log";
      assert.strictEqual((yield* exportGet(undefined, path, true)).status, 401);
      assert.strictEqual(
        (yield* exportGet("read", "/api/squire/squire:other/action-log", true)).status,
        404,
      );
      assert.strictEqual((yield* exportGet("read", path, false)).status, 404);
    }),
  );
});
