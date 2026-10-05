import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ExternalSessionImportError,
  ExternalSessionsListError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@lecturn/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import type * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { importExternalSession, listExternalSessions } from "./externalSessions.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory.ts";
import type {
  ImportExternalSessionInput,
  ListExternalSessionsInput,
  ProviderInstance,
} from "./ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";

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
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: driverKind,
      packageName: null,
    }),
    getSnapshot: Effect.succeed({} as unknown as ServerProvider),
    refresh: Effect.succeed({} as unknown as ServerProvider),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  },
  adapter: {} as unknown as ProviderInstance["adapter"],
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
          resumeCursor: { resume: "forked-session" },
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

// An imported thread that was never sent to: a fork cursor and no binding.
const unsentImportSource = {
  providerInstanceId: LISTING_INSTANCE,
  resumeCursor: { resume: "session-unsent-import-fork" },
};

const layer = Layer.mergeAll(
  fakeInstanceRegistryLayer,
  Layer.mock(ProjectionSnapshotQuery)({
    listThreadImportSources: () => Effect.succeed([unsentImportSource]),
  }),
  ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
  ),
  NodeServices.layer,
);

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

  it("hands the lister every bound and unsent-import resume cursor and shapes its result", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: ThreadId.make("thread-own"),
        provider: CLAUDE_DRIVER,
        providerInstanceId: LISTING_INSTANCE,
        resumeCursor: { resume: "session-own" },
      });
      yield* directory.upsert({
        threadId: ThreadId.make("thread-no-cursor"),
        provider: CLAUDE_DRIVER,
        providerInstanceId: LISTING_INSTANCE,
      });
      yield* directory.upsert({
        threadId: ThreadId.make("thread-other-instance"),
        provider: CLAUDE_DRIVER,
        providerInstanceId: OTHER_LISTING_INSTANCE,
        resumeCursor: { resume: "session-other" },
      });
      yield* directory.upsert({
        threadId: ThreadId.make("thread-other-provider"),
        provider: CODEX_DRIVER,
        providerInstanceId: PLAIN_INSTANCE,
        resumeCursor: { threadId: "codex-thread" },
      });

      listerCalls.length = 0;
      const result = yield* listExternalSessions({
        providerInstanceId: LISTING_INSTANCE,
        cwd: "/workspace",
        searchTerm: "",
        limit: 2,
      });

      assert.strictEqual(listerCalls.length, 1);
      const [{ knownResumeCursors, ...rest }] = listerCalls as [ListExternalSessionsInput];
      assert.deepStrictEqual(rest, { cwd: "/workspace", searchTerm: undefined, limit: 2 });
      // Instances can share a provider home, so cursors are not narrowed to this one.
      assert.sameDeepMembers(
        [...knownResumeCursors],
        [
          { resume: "session-own" },
          { resume: "session-other" },
          { threadId: "codex-thread" },
          unsentImportSource.resumeCursor,
        ],
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
      assert.deepStrictEqual(imported.resumeCursor, { resume: "forked-session" });
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
