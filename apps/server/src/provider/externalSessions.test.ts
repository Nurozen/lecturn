import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExternalSessionImportError,
  ExternalSessionsListError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  importExternalSession,
  listExternalSessions,
  nativeSessionIdsFromLegacyCursor,
} from "./externalSessions.ts";
import type {
  ImportExternalSessionInput,
  ListExternalSessionsInput,
  ProviderInstance,
} from "./ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const LISTING_INSTANCE = ProviderInstanceId.make("claude-work");
const OTHER_LISTING_INSTANCE = ProviderInstanceId.make("claude-personal");
const PLAIN_INSTANCE = ProviderInstanceId.make("codex");
const DISABLED_INSTANCE = ProviderInstanceId.make("claude-disabled");

const listerCalls: Array<ListExternalSessionsInput> = [];

const makeSession = (index: number) => ({
  sessionId: `session-${index}`,
  title: `  ${"t".repeat(300)}  `,
  firstPrompt: "  fix the build  ",
  cwd: "/workspace",
  updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
});

const makeFakeInstance = (
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  overrides: Partial<ProviderInstance> = {},
): ProviderInstance => ({
  instanceId,
  driverKind,
  continuationIdentity: { driverKind, continuationKey: `${driverKind}:instance:${instanceId}` },
  displayName: undefined,
  enabled: true,
  snapshot: {
    resolveMaintenance: () =>
      Effect.succeed(
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: driverKind,
          packageName: null,
        }),
      ),
    getSnapshot: Effect.succeed({} as unknown as ServerProvider),
    refresh: Effect.succeed({} as unknown as ServerProvider),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  },
  orchestrationAdapter: {} as unknown as ProviderInstance["orchestrationAdapter"],
  textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
  ...overrides,
});

const listThreeSessions: NonNullable<ProviderInstance["listExternalSessions"]> = (input) =>
  Effect.sync(() => {
    listerCalls.push(input);
    return { sessions: [0, 1, 2].map(makeSession), truncated: false };
  });

const importerCalls: Array<ImportExternalSessionInput> = [];

const importOneSession: NonNullable<ProviderInstance["importExternalSession"]> = (input) =>
  input.sessionId === "session-gone"
    ? Effect.fail(
        new ExternalSessionImportError({
          providerInstanceId: LISTING_INSTANCE,
          sessionId: input.sessionId,
          reason: "session-not-found",
        }),
      )
    : Effect.sync(() => {
        importerCalls.push(input);
        return {
          nativeThreadId: "forked-session",
          title:
            input.sessionId === "session-long"
              ? `  ${"t".repeat(300)}  `
              : input.sessionId === "session-untitled"
                ? "  "
                : "Fix the build",
          cwd: "/workspace",
          transcript: [],
        };
      });

const fakeInstances = [
  makeFakeInstance(LISTING_INSTANCE, CLAUDE_DRIVER, {
    listExternalSessions: listThreeSessions,
    importExternalSession: importOneSession,
  }),
  makeFakeInstance(PLAIN_INSTANCE, CODEX_DRIVER),
  makeFakeInstance(DISABLED_INSTANCE, CLAUDE_DRIVER, {
    enabled: false,
    listExternalSessions: listThreeSessions,
    importExternalSession: importOneSession,
  }),
];

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(fakeInstances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(fakeInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

const layer = Layer.mergeAll(
  fakeInstanceRegistryLayer,
  SqlitePersistenceMemory,
  NodeServices.layer,
);

const insertProviderThread = (providerThreadId: string, nativeId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = encodeJson({
      id: providerThreadId,
      nativeThreadRef:
        nativeId === null ? null : { driver: CLAUDE_DRIVER, nativeId, strength: "strong" },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES
        (${providerThreadId}, ${`thread-${providerThreadId}`}, ${CLAUDE_DRIVER}, 'idle',
         '2026-01-01T00:00:00.000Z', ${payload})
    `;
  });

const insertLegacySession = (threadId: string, resumeCursor: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES
        (${threadId}, 'codex', 'codex', 'stopped', '2026-01-01T00:00:00.000Z',
         ${encodeJson(resumeCursor)})
    `;
  });

const failureOf = (effect: ReturnType<typeof listExternalSessions>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.instanceOf(error, ExternalSessionsListError);
      return { providerInstanceId: error.providerInstanceId, reason: error.reason };
    }),
  );

it.layer(layer)("listExternalSessions", (it) => {
  it("fails with provider-unsupported when the instance has no lister", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf(
        listExternalSessions({ providerInstanceId: PLAIN_INSTANCE, limit: 10 }),
      );
      assert.deepStrictEqual(failure, {
        providerInstanceId: PLAIN_INSTANCE,
        reason: "provider-unsupported",
      });
    }));

  it("fails with provider-unavailable for unknown and disabled instances", () =>
    Effect.gen(function* () {
      const unknownInstance = ProviderInstanceId.make("missing");
      assert.deepStrictEqual(
        yield* failureOf(listExternalSessions({ providerInstanceId: unknownInstance, limit: 10 })),
        { providerInstanceId: unknownInstance, reason: "provider-unavailable" },
      );
      assert.deepStrictEqual(
        yield* failureOf(
          listExternalSessions({ providerInstanceId: DISABLED_INSTANCE, limit: 10 }),
        ),
        { providerInstanceId: DISABLED_INSTANCE, reason: "provider-unavailable" },
      );
    }));

  it("hands the lister every native session id Lecturn owns and shapes its result", () =>
    Effect.gen(function* () {
      // Provider threads, imported forks included, across every instance.
      yield* insertProviderThread("provider-thread-own", "session-own");
      yield* insertProviderThread("provider-thread-other", "session-other");
      yield* insertProviderThread("provider-thread-unbound", null);
      // A pre-orchestration-v2 session that came over in the copied database.
      yield* insertLegacySession("thread-legacy", { threadId: "codex-thread" });

      listerCalls.length = 0;
      const result = yield* listExternalSessions({
        providerInstanceId: LISTING_INSTANCE,
        cwd: "/workspace",
        searchTerm: "",
        limit: 2,
      });

      assert.strictEqual(listerCalls.length, 1);
      const [{ knownNativeSessionIds, ...rest }] = listerCalls as [ListExternalSessionsInput];
      assert.deepStrictEqual(rest, { cwd: "/workspace", searchTerm: undefined, limit: 2 });
      // Instances can share a provider home, so ids are not narrowed to this one.
      assert.sameMembers(
        [...knownNativeSessionIds],
        ["session-own", "session-other", "codex-thread"],
      );
      // The lister over-returned, so the service enforces the limit itself.
      assert.strictEqual(result.truncated, true);
      assert.deepStrictEqual(
        result.sessions.map((session) => session.sessionId),
        ["session-0", "session-1"],
      );
      for (const session of result.sessions) {
        assert.strictEqual(session.providerInstanceId, LISTING_INSTANCE);
        assert.strictEqual(session.driverKind, CLAUDE_DRIVER);
        assert.strictEqual(session.title.length, 200);
        assert.strictEqual(session.firstPrompt, "fix the build");
      }
    }));
});

const importFailureOf = (effect: ReturnType<typeof importExternalSession>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      assert.instanceOf(error, ExternalSessionImportError);
      return error.reason;
    }),
  );

it.layer(layer)("importExternalSession", (it) => {
  const importFrom = (providerInstanceId: ProviderInstanceId, sessionId = "session-0") =>
    importExternalSession({ providerInstanceId, sessionId, cwd: "/workspace/thread" });

  it("maps a missing importer, and unknown or disabled instances, to typed reasons", () =>
    Effect.gen(function* () {
      importerCalls.length = 0;
      assert.strictEqual(
        yield* importFailureOf(importFrom(PLAIN_INSTANCE)),
        "provider-unsupported",
      );
      assert.strictEqual(
        yield* importFailureOf(importFrom(ProviderInstanceId.make("missing"))),
        "provider-unavailable",
      );
      assert.strictEqual(
        yield* importFailureOf(importFrom(DISABLED_INSTANCE)),
        "provider-unavailable",
      );
      assert.deepStrictEqual(importerCalls, []);
    }));

  it("passes the importer's own failure through", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* importFailureOf(importFrom(LISTING_INSTANCE, "session-gone")),
        "session-not-found",
      );
    }));

  it("hands the importer the session and thread cwd and stamps the driver kind", () =>
    Effect.gen(function* () {
      importerCalls.length = 0;
      const imported = yield* importFrom(LISTING_INSTANCE);
      assert.deepStrictEqual(importerCalls, [{ sessionId: "session-0", cwd: "/workspace/thread" }]);
      assert.strictEqual(imported.driverKind, CLAUDE_DRIVER);
      assert.strictEqual(imported.nativeThreadId, "forked-session");
    }));

  it("caps the session's title and the thread's, client-supplied included", () =>
    Effect.gen(function* () {
      const long = yield* importFrom(LISTING_INSTANCE, "session-long");
      assert.strictEqual(long.title.length, 200);
      assert.strictEqual(long.threadTitle, long.title);

      const named = yield* importExternalSession({
        providerInstanceId: LISTING_INSTANCE,
        sessionId: "session-long",
        cwd: "/workspace/thread",
        title: "n".repeat(300),
      });
      assert.strictEqual(named.threadTitle.length, 200);
      assert.isTrue(named.threadTitle.startsWith("nnn"));
      assert.strictEqual(named.title, long.title);

      const untitled = yield* importFrom(LISTING_INSTANCE, "session-untitled");
      assert.strictEqual(untitled.title, "");
      assert.strictEqual(untitled.threadTitle, "Imported session");
    }));
});

describe("nativeSessionIdsFromLegacyCursor", () => {
  it("reads Claude and Codex cursor ids and ignores everything else", () => {
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor({ resume: "claude-1", turnCount: 2 }), [
      "claude-1",
    ]);
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor({ sessionId: "claude-2" }), [
      "claude-2",
    ]);
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor({ threadId: "codex-1" }), ["codex-1"]);
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor(null), []);
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor("not-a-cursor"), []);
    assert.deepStrictEqual(nativeSessionIdsFromLegacyCursor({ resume: "  " }), []);
  });
});
