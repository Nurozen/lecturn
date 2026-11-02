import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AppId,
  AuthSessionId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RpcClientId,
  RunId,
  type SquireError,
  RuntimeRequestId,
  SquireCardId,
  SquireId,
  ThreadId,
  TurnItemId,
} from "@lecturn/contracts";
import { RelayAgentActivityState } from "@lecturn/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicyModule from "../background/BackgroundPolicy.ts";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import { TeamPolicy } from "../cloud/TeamPolicy.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type AppRegistrationRecord,
  AppRegistrationRepository,
} from "../persistence/AppRegistrations.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireMobileAttention from "../squire/SquireMobileAttention.ts";
import * as SquirePresence from "../squire/SquirePresence.ts";
import * as SquireRepository from "../squire/SquireRepository.ts";
import { squireRow } from "../squire/testkit/scopeHarness.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const THREAD_ID = ThreadId.make("relay-thread");
const SECOND_THREAD_ID = ThreadId.make("relay-thread-2");
const PROJECT_ID = ProjectId.make("relay-project");
const RELAY_APP_ID = AppId.make("dev.rocketwright");
const NOW = "2026-09-04T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const PublishPayload = Schema.Struct({
  state: Schema.NullOr(RelayAgentActivityState),
  userPresent: Schema.optional(Schema.Boolean),
});
const decodePublishPayload = Schema.decodeUnknownSync(Schema.fromJsonString(PublishPayload));
const unused = () => Effect.die("Unexpected test dependency call");

describe("startup agent activity", () => {
  it("publishes active work and only terminal runs completed after startup", () => {
    const startedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
    const oldCompleted = ThreadId.make("old-completed");
    const newCompleted = ThreadId.make("new-completed");
    const oldFailed = ThreadId.make("old-failed");
    const newFailed = ThreadId.make("new-failed");
    const ids = AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
      environmentId: EnvironmentId.make("relay-env"),
      startedAt,
      projects: [{ id: PROJECT_ID, title: "Project" }],
      threads: [
        shell(),
        shell({
          id: oldCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newCompleted,
          status: "completed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({
          id: oldFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T11:59:00.000Z"),
        }),
        shell({
          id: newFailed,
          status: "failed",
          latestRunCompletedAt: DateTime.makeUnsafe("2026-09-04T12:00:01.000Z"),
        }),
        shell({ id: ThreadId.make("idle"), status: "idle" }),
        shell({ id: ThreadId.make("missing-project"), projectId: ProjectId.make("missing") }),
      ],
    });
    assert.deepStrictEqual(ids, [THREAD_ID, newCompleted, newFailed]);
  });
});

const makeTestRelay = Effect.fnUntraced(function* (
  options: {
    readonly respond?: (attempt: number) => Response;
    readonly failSecretRead?: (name: string) => boolean;
    readonly linked?: boolean;
    readonly readShell?: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
    readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
    /** Lecturn: organization policy for activity publishing (default allowed). */
    readonly canPublishActivity?: boolean;
    /** Lecturn: whether a client reports the user present (default away). */
    readonly userPresent?: () => boolean;
    /** Lecturn: binds the project to a connected app with this name. */
    readonly app?: { readonly name: string; readonly projectTitle?: string };
    /** Lecturn: the Squire phone row's source (LECTURN_SQUIRE on). */
    readonly squire?: SquireMobileAttention.SquireMobileAttention["Service"];
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.linked === false
      ? []
      : [
          [PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true")],
          [RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")],
          [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")],
        ],
  );
  const secretReads: string[] = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => {
        secretReads.push(name);
        if (options.failSecretRead?.(name)) {
          return Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: name,
              cause: "temporary read failure",
            }),
          );
        }
        return Effect.succeed(Option.fromUndefinedOr(values.get(name)));
      }),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: unused,
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell());
  const shellReads: ThreadId[] = [];
  const catchUp = { shellSnapshotReads: 0 };
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: (threadId) =>
      Effect.sync(() => shellReads.push(threadId)).pipe(
        Effect.andThen(options.readShell?.(threadId) ?? Ref.get(currentShell)),
      ),
    getShellSnapshot: () =>
      Effect.sync(() => {
        catchUp.shellSnapshotReads += 1;
        return { schemaVersion: 2, snapshotSequence: 1, threads: [], archivedThreads: [] };
      }),
    readShellSnapshot: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused message count"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    getProjectThread: unused,
    listProjectThreads: unused,
    sendToThread: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const publications: Array<{
    readonly url: string;
    readonly authorization: string | null;
    readonly state: RelayAgentActivityState | null;
    readonly userPresent: boolean | undefined;
  }> = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const body = init?.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        return Promise.reject(new Error("Expected a serialized activity publish payload"));
      }
      const payload = decodePublishPayload(
        typeof body === "string" ? body : new TextDecoder().decode(body),
      );
      publications.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        state: payload.state,
        userPresent: payload.userPresent,
      });
      return Promise.resolve(
        options.respond?.(publications.length) ?? Response.json({ ok: true, deliveries: [] }),
      );
    },
    { preconnect: () => {} },
  );
  const make =
    options.squire === undefined
      ? AgentAwarenessRelay.make
      : AgentAwarenessRelay.make.pipe(
          Effect.provideService(SquireMobileAttention.SquireMobileAttention, options.squire),
        );
  const relay = yield* make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(TeamPolicy, {
      checkProvider: () => Effect.void,
      canPublishActivity: Effect.succeed(options.canPublishActivity ?? true),
    }),
    Effect.provideService(BackgroundPolicy, {
      isUserPresent: Effect.sync(() => options.userPresent?.() ?? false),
    } as unknown as BackgroundPolicy["Service"]),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("relay-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      refresh: unused,
      getByWorkspaceRoot: unused,
      snapshot: Effect.succeed({ projects: [] } as never),
      getShell: unused,
      listShells: unused,
      getById: () =>
        Effect.succeed(
          Option.some({
            id: PROJECT_ID,
            title: options.app?.projectTitle ?? "Project",
            workspaceRoot: "/workspace",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          }),
        ),
    }),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      get: () =>
        Effect.succeed(
          Option.some(
            options.app === undefined
              ? {}
              : { appBinding: { appId: RELAY_APP_ID, workspaceRoot: "/workspace" } },
          ),
        ),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(AppRegistrationRepository, {
      get: (appId: AppId) =>
        Effect.succeed(
          options.app !== undefined && appId === RELAY_APP_ID
            ? Option.some({
                appId,
                registration: { name: options.app.name },
              } as unknown as AppRegistrationRecord)
            : Option.none(),
        ),
    } as unknown as AppRegistrationRepository["Service"]),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(NodeCrypto.layer),
  );
  return { relay, secrets, secretReads, currentShell, shellReads, publications, catchUp };
});

describe("AgentAwarenessRelay", () => {
  it("ignores transcript and tool updates but retains activity and metadata changes", () => {
    for (const type of [
      "message.updated",
      "turn-item.updated",
      "provider-turn.updated",
      "thread.visited",
      "thread.pinned",
    ] as const) {
      assert.isFalse(AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type }));
    }
    for (const type of [
      "run.created",
      "run.updated",
      "runtime-request.updated",
      "subagent.updated",
      "provider-thread.updated",
      "thread.metadata-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.archived",
      "thread.unarchived",
      "thread.deleted",
    ] as const) {
      assert.isTrue(AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type }));
    }
  });

  it("does not publish imported thread creation as new agent activity", () => {
    assert.isFalse(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        type: "thread.created",
        payload: { historyOrigin: "v1_import" },
      }),
    );
    assert.isTrue(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type: "thread.created", payload: {} }),
    );
  });

  it("does not alert for a fork child's creation but publishes an imported thread", () => {
    // Lecturn: the child starts from its parent's record and never ran work of its own.
    assert.isFalse(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        type: "thread.created",
        payload: {
          lineage: {
            rootThreadId: THREAD_ID,
            parentThreadId: THREAD_ID,
            relationshipToParent: "fork",
          },
        },
      }),
    );
    assert.isTrue(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        type: "thread.created",
        payload: {
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
        },
      }),
    );
    assert.isTrue(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({ type: "thread.imported" }),
    );
  });

  it.effect(
    "does not read or transmit thread activity when organization publishing is disabled",
    () =>
      Effect.gen(function* () {
        const { relay, shellReads, publications } = yield* makeTestRelay({
          canPublishActivity: false,
        });
        yield* relay.publishThread(THREAD_ID);
        assert.equal(shellReads.length, 0);
        assert.equal(publications.length, 0);
      }),
  );

  // Mobile's alerts come from these publishes; Projects-mode filters must not reach them.
  it.effect("publishes approval and completion for a connected app's thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      const app = { appOrigin: "app-credential", appData: "rocket:1" } as const;
      yield* Ref.set(
        currentShell,
        shell({
          ...app,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("approval-1"),
            kind: "command",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({
          ...app,
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => [publication.state?.phase, publication.state?.deepLink]),
        [
          ["waiting_for_approval", "/threads/relay-environment/relay-thread"],
          ["completed", "/threads/relay-environment/relay-thread"],
        ],
      );
    }),
  );

  it.effect("titles an app thread's push with the app name and leaves others alone", () =>
    Effect.gen(function* () {
      const plain = yield* makeTestRelay();
      yield* plain.relay.publishThread(THREAD_ID);
      const app = yield* makeTestRelay({ app: { name: "RocketWright" } });
      yield* app.relay.publishThread(THREAD_ID);
      const sameName = yield* makeTestRelay({
        app: { name: "RocketWright", projectTitle: "RocketWright" },
      });
      yield* sameName.relay.publishThread(THREAD_ID);
      assert.deepEqual(
        [plain, app, sameName].map(({ publications }) => publications[0]?.state?.projectTitle),
        ["Project", "RocketWright: Project", "RocketWright"],
      );
    }),
  );

  it.effect("tells the relay whether the user is present at publish time", () =>
    Effect.gen(function* () {
      let present = true;
      const { relay, currentShell, publications } = yield* makeTestRelay({
        userPresent: () => present,
      });
      yield* relay.publishThread(THREAD_ID);
      present = false;
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(
        publications.map((publication) => publication.userPresent),
        [true, false],
      );
    }),
  );

  it.effect("rings once after the user leaves when a thread needed input while present", () =>
    Effect.gen(function* () {
      let present = true;
      const { relay, currentShell, publications } = yield* makeTestRelay({
        userPresent: () => present,
      });
      yield* Ref.set(
        currentShell,
        shell({
          status: "waiting",
          pendingRuntimeRequest: { kind: "user_input" } as never,
        }),
      );
      yield* relay.start();
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(
        publications.map((publication) => [publication.state?.phase, publication.userPresent]),
        [["waiting_for_input", true]],
      );

      // Still present at the next check: nothing is redelivered.
      yield* TestClock.adjust("30 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);

      present = false;
      yield* TestClock.adjust("30 seconds");
      yield* relay.drain;
      assert.deepEqual(
        publications.map((publication) => [publication.state?.phase, publication.userPresent]),
        [
          ["waiting_for_input", true],
          ["waiting_for_input", false],
        ],
      );

      yield* TestClock.adjust("2 minutes");
      yield* relay.drain;
      assert.equal(publications.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("coalesces queued updates and reruns a thread dirtied during publishing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rerunStarted = yield* Deferred.make<void>();
      const releaseRerun = yield* Deferred.make<void>();
      const processed: Array<{ threadId: ThreadId; revision: number }> = [];
      let revision = 1;
      const worker = yield* AgentAwarenessRelay.makeAgentAwarenessPublishWorker((threadId) =>
        Effect.gen(function* () {
          const currentRevision = revision;
          const index = processed.length;
          processed.push({ threadId, revision: currentRevision });
          if (index === 0) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          } else if (threadId === THREAD_ID) {
            yield* Deferred.succeed(rerunStarted, undefined);
            yield* Deferred.await(releaseRerun);
          }
        }),
      );
      yield* worker.enqueue(THREAD_ID);
      yield* Deferred.await(started);
      revision = 2;
      for (let i = 0; i < 100; i++) {
        yield* worker.enqueue(SECOND_THREAD_ID);
        yield* worker.enqueue(THREAD_ID);
      }
      const drained = yield* Deferred.make<void>();
      const draining = yield* worker.drain.pipe(
        Effect.andThen(Deferred.succeed(drained, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(rerunStarted);
      assert.isFalse(yield* Deferred.isDone(drained));
      yield* Deferred.succeed(releaseRerun, undefined);
      yield* Fiber.join(draining);
      assert.deepEqual(processed, [
        { threadId: THREAD_ID, revision: 1 },
        { threadId: SECOND_THREAD_ID, revision: 2 },
        { threadId: THREAD_ID, revision: 2 },
      ]);
    }),
  );

  it.effect("deduplicates state and republishes title changes", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({ updatedAt: DateTime.makeUnsafe("2026-09-04T13:00:00Z") }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Renamed thread" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "Renamed thread");
    }),
  );

  it.effect("stops before shell reads when disabled and republishes after re-enabling", () =>
    Effect.gen(function* () {
      const { relay, secrets, secretReads, shellReads, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      const previousReads = secretReads.length;
      yield* relay.publishThread(THREAD_ID);
      assert.deepEqual(secretReads.slice(previousReads), [PUBLISH_AGENT_ACTIVITY_SECRET]);
      assert.equal(shellReads.length, 1);
      assert.equal(publications.length, 1);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
    }),
  );

  it.effect("republishes unchanged state with fresh credentials after relinking", () =>
    Effect.gen(function* () {
      const { relay, secrets, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[0]?.authorization, "Bearer credential-1");
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      yield* secrets.set(
        RELAY_URL_SECRET,
        new TextEncoder().encode("https://new-relay.example.test"),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 3);
      assert.isTrue(publications[2]?.url.startsWith("https://new-relay.example.test/") ?? false);
    }),
  );

  it.effect("a stalled response body releases later threads and uses bounded retries", () =>
    Effect.gen(function* () {
      const bodyStarted = Promise.withResolvers<void>();
      const secondRead = yield* Deferred.make<void>();
      const currentShell = yield* Ref.make(shell());
      const { relay, publications } = yield* makeTestRelay({
        readShell: (threadId) =>
          threadId === SECOND_THREAD_ID
            ? Deferred.succeed(secondRead, undefined).pipe(
                Effect.as(shell({ id: SECOND_THREAD_ID })),
              )
            : Ref.get(currentShell),
        respond: (attempt) => {
          if (attempt !== 1) return new Response("relay unavailable", { status: 503 });
          const response = new Response(null, {
            headers: { "content-type": "application/json" },
          });
          return Object.assign(response, {
            arrayBuffer: () => {
              bodyStarted.resolve();
              return new Promise<ArrayBuffer>(() => {});
            },
          });
        },
      });
      const first = yield* relay.publishThread(THREAD_ID).pipe(Effect.forkChild);
      yield* Effect.promise(() => bodyStarted.promise);
      const second = yield* relay.publishThread(SECOND_THREAD_ID).pipe(Effect.forkChild);
      yield* TestClock.adjust("9999 millis");
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell({ title: "Latest title" }));
      yield* TestClock.adjust("1 millis");
      assert.isTrue(yield* Deferred.isDone(secondRead));
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(publications.length, 2);
      assert.isTrue(publications[1]?.url.includes(SECOND_THREAD_ID) ?? false);
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        const attempts = publications.length;
        yield* TestClock.adjust(delay - 1);
        yield* relay.drain;
        assert.equal(publications.length, attempts);
        yield* TestClock.adjust(1);
        yield* relay.drain;
        assert.equal(publications.length, attempts + 2);
        assert.equal(publications[attempts]?.state?.threadTitle, "Latest title");
      }
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, 12);
    }),
  );

  it.effect("retries a failed final state without another thread event", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 2
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.equal(publications[2]?.state?.phase, "completed");
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(shellReads.length, 3);
    }),
  );

  it.effect("retries the latest shell and credentials with first-completion confirmation", () =>
    Effect.gen(function* () {
      const { relay, secrets, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 1
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          title: "Final title",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        new TextEncoder().encode("credential-2"),
      );
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.authorization, "Bearer credential-2");
      assert.equal(publications[1]?.state?.phase, "completed");
      assert.equal(publications[1]?.state?.threadTitle, "Final title");
    }),
  );

  it.effect("cancels a stale retry when a newer update publishes successfully", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt === 1
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, shell({ title: "New title" }));
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state?.threadTitle, "New title");
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(shellReads.length, 2);
    }),
  );

  it.effect.each(["disable", "unlink"] as const)(
    "stops retries before shell reads after %s",
    (change) =>
      Effect.gen(function* () {
        const { relay, secrets, shellReads, publications } = yield* makeTestRelay({
          respond: () => new Response("relay unavailable", { status: 503 }),
        });
        yield* relay.publishThread(THREAD_ID);
        if (change === "disable") {
          yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
        } else {
          yield* secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        }
        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        yield* TestClock.adjust("1 minute");
        yield* relay.drain;
        assert.equal(publications.length, 1);
        assert.equal(shellReads.length, 1);
      }),
  );

  it.effect("recovers from a transient configuration read failure", () =>
    Effect.gen(function* () {
      let failRead = false;
      const { relay, shellReads, publications } = yield* makeTestRelay({
        failSecretRead: (name) => failRead && name === PUBLISH_AGENT_ACTIVITY_SECRET,
      });
      failRead = true;
      yield* relay.publishThread(THREAD_ID);
      assert.equal(shellReads.length, 0);
      failRead = false;
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      assert.equal(publications[0]?.state?.phase, "running");
    }),
  );

  it.effect("bounds retry attempts and resets the budget for a newer update", () =>
    Effect.gen(function* () {
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: () => new Response("relay unavailable", { status: 503 }),
      });
      yield* relay.publishThread(THREAD_ID);
      let attempts = 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
        yield* TestClock.adjust(delay - 1);
        yield* relay.drain;
        assert.equal(publications.length, attempts);
        yield* TestClock.adjust(1);
        yield* relay.drain;
        attempts += 1;
        assert.equal(publications.length, attempts);
      }
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, 6);
      assert.equal(shellReads.length, 6);
      yield* Ref.set(currentShell, shell({ title: "New update" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 8);
      assert.equal(publications[7]?.state?.threadTitle, "New update");
    }),
  );

  it.effect("retries a confirmed completion without restarting its confirmation window", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay({
        respond: (attempt) =>
          attempt <= 2
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("1 second");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      yield* TestClock.adjust("2 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 3);
      assert.isTrue(publications.every((publication) => publication.state?.phase === "completed"));
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, 3);
    }),
  );

  it.effect("does not reset an exhausted retry budget for old confirmation timers", () =>
    Effect.gen(function* () {
      let unavailable = false;
      const { relay, currentShell, shellReads, publications } = yield* makeTestRelay({
        respond: () =>
          unavailable
            ? new Response("relay unavailable", { status: 503 })
            : Response.json({ ok: true, deliveries: [] }),
      });
      yield* relay.publishThread(THREAD_ID);
      for (let i = 0; i < 6; i++) {
        yield* Ref.set(currentShell, null);
        yield* relay.publishThread(THREAD_ID);
        yield* Ref.set(currentShell, shell());
        yield* relay.publishThread(THREAD_ID);
        yield* TestClock.adjust(1);
      }
      unavailable = true;
      yield* Ref.set(currentShell, shell({ status: "failed" }));
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust(1_000);
      yield* relay.drain;
      yield* TestClock.adjust(2_000);
      yield* relay.drain;
      yield* TestClock.adjust(1_994);
      yield* relay.drain;
      for (let i = 0; i < 5; i++) {
        yield* TestClock.adjust(1);
        yield* relay.drain;
      }
      const attempts = publications.length;
      const reads = shellReads.length;
      yield* TestClock.adjust("1 minute");
      yield* relay.drain;
      assert.equal(publications.length, attempts);
      assert.equal(shellReads.length, reads);
    }),
  );

  it.effect("confirms tombstones and cancels stale confirmations when activity recovers", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* relay.publishThread(THREAD_ID);
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, shell());
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 1);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 2);
      assert.equal(publications[1]?.state, null);
    }),
  );

  it.effect.each([
    { label: "live", archived: false },
    { label: "archived", archived: true },
  ])("never publishes tombstones for $label subagent threads", ({ archived }) =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({
          lineage: {
            rootThreadId: THREAD_ID,
            parentThreadId: THREAD_ID,
            relationshipToParent: "subagent",
          },
          ...(archived ? { archivedAt: yield* DateTime.now } : {}),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 0);
    }),
  );

  it.effect("never publishes activity for a running Squire thread", () =>
    Effect.gen(function* () {
      const { relay, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({ squire: { squireId: SquireId.make("squire-1"), role: "home" } }),
      );
      yield* relay.publishThread(THREAD_ID);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 0);
    }),
  );

  it.effect("confirms a first completed state and respects disabling during confirmation", () =>
    Effect.gen(function* () {
      const { relay, secrets, currentShell, publications } = yield* makeTestRelay();
      yield* Ref.set(
        currentShell,
        shell({
          status: "completed",
          latestRunCompletedAt: DateTime.add(yield* DateTime.now, { seconds: 1 }),
        }),
      );
      yield* relay.publishThread(THREAD_ID);
      assert.equal(publications.length, 0);
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications[0]?.state?.phase, "completed");
      yield* Ref.set(currentShell, null);
      yield* relay.publishThread(THREAD_ID);
      yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("false"));
      yield* TestClock.adjust("5 seconds");
      yield* relay.drain;
      assert.equal(publications.length, 1);
    }),
  );
  it.effect("publishes a held completion when its background item ends, not on tool output", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const { relay, shellReads, publications } = yield* makeTestRelay({
        readShell: (threadId) => store.getThreadShell(threadId).pipe(Effect.orDie),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* relay.start();
      yield* Queue.take(pulls);
      const deliver = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
        yield* store.apply(event);
        yield* Queue.offer(events, event);
        yield* Queue.take(pulls);
        yield* relay.drain;
      });

      const now = yield* DateTime.now;
      const runId = RunId.make("run:held-item");
      const run = {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make("message:held-item"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const item = (
        id: string,
        fields: Pick<OrchestrationV2TurnItem, "status"> &
          (
            | { readonly type: "dynamic_tool"; readonly toolName: string; readonly input: unknown }
            | {
                readonly type: "assistant_message";
                readonly messageId: MessageId;
                readonly text: string;
                readonly streaming: boolean;
              }
          ),
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: THREAD_ID,
        runId,
        nodeId: NodeId.make("node:held-item"),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...fields,
      });
      const itemEvent = (id: string, payload: OrchestrationV2TurnItem) =>
        ({
          id: EventId.make(id),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          runId,
          occurredAt: now,
          payload,
        }) satisfies OrchestrationV2DomainEvent;
      const background = { type: "dynamic_tool" as const, toolName: "watch", input: {} };

      yield* deliver({
        id: EventId.make("event:held-item:thread"),
        type: "thread.created",
        threadId: THREAD_ID,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* deliver({
        id: EventId.make("event:held-item:run"),
        type: "run.created",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: run,
      });
      yield* deliver(
        itemEvent("event:held-item:tool", item("item:tool", { ...background, status: "running" })),
      );
      yield* deliver({
        id: EventId.make("event:held-item:run-completed"),
        type: "run.updated",
        threadId: THREAD_ID,
        runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running"],
      );

      const readsBeforeOutput = shellReads.length;
      yield* deliver(
        itemEvent(
          "event:held-item:reply",
          item("item:reply", {
            type: "assistant_message",
            messageId: MessageId.make("message:held-item:reply"),
            text: "Still watching",
            streaming: true,
            status: "running",
          }),
        ),
      );
      yield* deliver(
        itemEvent("event:held-item:tick", item("item:tool", { ...background, status: "running" })),
      );
      assert.equal(shellReads.length, readsBeforeOutput);

      yield* deliver(
        itemEvent("event:held-item:end", item("item:tool", { ...background, status: "completed" })),
      );
      assert.deepEqual(
        publications.map((publication) => publication.state?.phase),
        ["running", "completed"],
      );
    }).pipe(Effect.scoped, Effect.provide(ProjectionStore.layerMemory)),
  );
});

describe("startup catch-up", { concurrent: false }, () => {
  const link = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
    Effect.all(
      [
        secrets.set(RELAY_URL_SECRET, new TextEncoder().encode("https://relay.example.test")),
        secrets.set(RELAY_ISSUER_SECRET, new TextEncoder().encode("https://relay.example.test")),
        secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, new TextEncoder().encode("credential-1")),
      ],
      { discard: true },
    );
  const enablePublishing = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
    secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, new TextEncoder().encode("true"));
  const linkChecks = (secretReads: ReadonlyArray<string>) =>
    secretReads.filter((name) => name === RELAY_URL_SECRET).length;

  it.effect("checks an unlinked environment once a minute and still catches up once linked", () =>
    Effect.gen(function* () {
      const { relay, secrets, secretReads, catchUp } = yield* makeTestRelay({ linked: false });
      yield* enablePublishing(secrets);
      yield* relay.start();

      yield* TestClock.adjust("10 minutes");
      const checksBeforeWindow = linkChecks(secretReads);
      yield* TestClock.adjust("10 minutes");
      assert.equal(linkChecks(secretReads) - checksBeforeWindow, 10);
      assert.equal(catchUp.shellSnapshotReads, 0);

      yield* link(secrets);
      yield* TestClock.adjust("1 minute");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("publishes at once when this process links while the check is backed off", () =>
    Effect.gen(function* () {
      const { relay, secrets, catchUp } = yield* makeTestRelay({ linked: false });
      yield* enablePublishing(secrets);
      yield* relay.start();

      yield* TestClock.adjust("10 minutes");
      yield* link(secrets);
      yield* TestClock.adjust("1 second");
      assert.equal(catchUp.shellSnapshotReads, 0);

      yield* relay.requestCatchUp();
      yield* TestClock.adjust("1 second");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("catches up within 5 s when another process enables publishing on a link", () =>
    Effect.gen(function* () {
      const { relay, secrets, catchUp } = yield* makeTestRelay({ linked: false });
      yield* link(secrets);
      yield* relay.start();

      yield* TestClock.adjust("10 minutes");
      assert.equal(catchUp.shellSnapshotReads, 0);

      yield* enablePublishing(secrets);
      yield* TestClock.adjust("5 seconds");
      assert.equal(catchUp.shellSnapshotReads, 1);
    }).pipe(Effect.scoped),
  );
});

// ── Squire phone row (D27, D52) ─────────────────────────────────

const RELEASE = SquireId.make("squire:release");
const LEAD = SquireId.make("squire:lead");
const RELEASE_HOME = ThreadId.make("squire-home:release");
const LEAD_HOME = ThreadId.make("squire-home:lead");
const SQUIRE_START = Date.parse("2026-11-02T08:00:00.000Z");
/** Every card's title and why carry this, so a leak shows up in the payload. */
const ITEM_TEXT = "ITEM-TEXT";
const SQUIRE_FIXTURE = "../../../../infra/relay/src/agentActivity/squireAttention.fixture.json";

const layerSquireStorage = SquirePresence.layer.pipe(
  Layer.provideMerge(
    BackgroundPolicyModule.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HostPowerMonitor.HostPowerMonitor,
          HostPowerMonitor.HostPowerMonitor.of({
            snapshot: Effect.sync(() => ({
              source: "unknown" as const,
              idle: "unknown" as const,
              idleSeconds: null,
              locked: "unknown" as const,
              suspended: false,
              onBattery: "unknown" as const,
              lowPowerMode: "unknown" as const,
              thermalState: "unknown" as const,
              stale: true,
              updatedAt: DateTime.makeUnsafe(SQUIRE_START),
            })),
            report: () => Effect.void,
            streamChanges: Stream.never,
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      SquireRepository.layer,
      ServerSettings.layerTest({ squire: { phoneAlertsWhileDesktop: "after-3-min" } }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

type SquireStack =
  | Scope.Scope
  | SquireRepository.SquireRepository
  | SquirePresence.SquirePresence
  | BackgroundPolicyModule.BackgroundPolicy
  | SquireMobileAttention.SquireMobileAttention;

/**
 * The clock moves first (a lease sweep would replay from the epoch), the
 * Squires exist before the attention set is built, as after any restart.
 */
const withSquires = <A, E>(body: Effect.Effect<A, E, SquireStack>) =>
  TestClock.setTime(SQUIRE_START).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        yield* repository.createSquire(
          squireRow(RELEASE, { name: "Release", home_thread_id: RELEASE_HOME }),
        );
        yield* repository.createSquire(
          squireRow(LEAD, { role: "lead", name: "Lead", home_thread_id: LEAD_HOME }),
        );
        return yield* body.pipe(Effect.provide(SquireMobileAttention.layer));
      }).pipe(Effect.provide(layerSquireStorage)),
    ),
    Effect.scoped,
  );

let squireCardSeq = 0;

/** A card and its intent, as an intent site writes them in one transaction. */
const raiseCard = (input: {
  readonly kind: SquireRepository.SquireCardRow["kind"];
  readonly squireId?: SquireId;
  /** False: Notify Off, a digest with push off, or a question (D26). */
  readonly push: boolean;
  readonly source?: string;
}) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const presence = yield* SquirePresence.SquirePresence;
    const now = DateTime.formatIso(yield* DateTime.now);
    const squireId = input.squireId ?? RELEASE;
    squireCardSeq += 1;
    const cardId = SquireCardId.make(`card:${squireCardSeq}`);
    const targetThreadId = input.kind === "fyi" ? null : ThreadId.make(`thread:${squireCardSeq}`);
    const log = (kind: string, data: Record<string, unknown>) =>
      repository.insertActionLog({
        squire_id: squireId,
        kind,
        room_id: null,
        post_id: null,
        trigger_id: null,
        task_id: null,
        thread_id: targetThreadId,
        card_id: cardId,
        event_id: null,
        run_id: null,
        invocation_key: null,
        execution_key: null,
        data_json: JSON.stringify(data),
        created_at: now,
      });
    yield* repository.transaction(
      Effect.gen(function* () {
        yield* repository.insertCard({
          id: cardId,
          squire_id: squireId,
          owner_squire_id: squireId,
          kind: input.kind,
          status: "open",
          target_thread_id: targetThreadId,
          project_id: null,
          title: `${ITEM_TEXT} title ${squireCardSeq}`,
          why: `${ITEM_TEXT} why`,
          payload_json: "{}",
          evidence_json: "{}",
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
          created_at: now,
          updated_at: now,
        });
        yield* log("card.created", { kind: input.kind });
        if (!input.push) return;
        yield* log("notification.pushed", { kind: input.kind, source: input.source ?? "card" });
        yield* presence.holdIntent({
          squireId,
          cardId,
          kind: input.kind,
          threadId: targetThreadId,
          runId: null,
          now,
        });
      }),
    );
    return cardId;
  });

const closeCard = (cardId: SquireCardId, status: "resolved" | "dismissed") =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* repository.updateCard({
      id: cardId,
      fromStatuses: ["open"],
      patch: { status, resolution: status },
      updatedAt: now,
    });
  });

const desktopActive = Effect.gen(function* () {
  const policy = yield* BackgroundPolicyModule.BackgroundPolicy;
  yield* policy.reportClientActivity(AuthSessionId.make("session-1"), RpcClientId.make(1), {
    clientId: "desktop-1",
    clientKind: "desktop-renderer",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [],
    ttlMs: 45_000,
    observedAt: yield* DateTime.now,
  });
  assert.isTrue(yield* (yield* SquirePresence.SquirePresence).desktopActive);
});

const mobileDeliveries = (squireId: SquireId) =>
  Effect.gen(function* () {
    const repository = yield* SquireRepository.SquireRepository;
    const rows = yield* repository.listActionLog({
      squireId,
      kinds: ["notification.delivery"],
      limit: 1_000,
    });
    return rows.flatMap((row) => {
      const data = JSON.parse(row.data_json) as {
        readonly outcome: string;
        readonly surface?: string;
        readonly reason?: string;
      };
      return data.surface === "mobile"
        ? [{ id: row.id, cardId: row.card_id, outcome: data.outcome, reason: data.reason }]
        : [];
    });
  });

const publishedThreadId = (url: string) =>
  decodeURIComponent(/\/threads\/([^/]+)\/agent-activity$/.exec(url)?.[1] ?? "");

interface ScenarioStep {
  readonly step: string;
  readonly squireId: SquireId;
  readonly run: Effect.Effect<unknown, PersistenceSqlError | SquireError, SquireStack>;
}

/** Runs each step, then the relay publish its write triggers, and records both sides. */
const runSquireScenario = (steps: ReadonlyArray<ScenarioStep>) =>
  withSquires(
    Effect.gen(function* () {
      const attention = yield* SquireMobileAttention.SquireMobileAttention;
      const { relay, publications } = yield* makeTestRelay({
        squire: attention,
        // The present-user suppression must not apply to Squire rows.
        userPresent: () => true,
      });
      const recorded = [];
      for (const { step, squireId, run } of steps) {
        const publishedBefore = publications.length;
        const deliveredBefore = (yield* mobileDeliveries(squireId)).length;
        yield* run;
        yield* relay.publishThread(squireId === LEAD ? LEAD_HOME : RELEASE_HOME);
        recorded.push({
          step,
          publishes: publications.slice(publishedBefore).map((publication) => ({
            threadId: publishedThreadId(publication.url),
            state: publication.state,
            userPresent: publication.userPresent,
          })),
          mobile: (yield* mobileDeliveries(squireId))
            .slice(deliveredBefore)
            .map((row) =>
              row.reason === undefined ? row.outcome : `${row.outcome}:${row.reason}`,
            ),
        });
      }
      return recorded;
    }),
  );

const squireScenarios = {
  cards: [
    { step: "first card", squireId: RELEASE, run: raiseCard({ kind: "steer", push: true }) },
    { step: "second card", squireId: RELEASE, run: raiseCard({ kind: "proposal", push: true }) },
    {
      step: "queue cleared",
      squireId: RELEASE,
      run: Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        for (const card of yield* repository.listCards({ squireId: RELEASE })) {
          yield* closeCard(card.id, card.kind === "steer" ? "resolved" : "dismissed");
        }
      }),
    },
    { step: "next card", squireId: RELEASE, run: raiseCard({ kind: "steer", push: true }) },
  ],
  notify: [
    {
      step: "notify-only push",
      squireId: RELEASE,
      run: raiseCard({ kind: "fyi", push: true, source: "notify" }),
    },
    {
      step: "its FYI dismissed",
      squireId: RELEASE,
      run: Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const [fyi] = yield* repository.listCards({ squireId: RELEASE, kinds: ["fyi"] });
        yield* closeCard(fyi!.id, "dismissed");
      }),
    },
    {
      step: "second notify-only push",
      squireId: RELEASE,
      run: raiseCard({ kind: "fyi", push: true, source: "notify" }),
    },
  ],
  digests: [
    {
      step: "pushed digest",
      squireId: LEAD,
      run: raiseCard({ kind: "fyi", squireId: LEAD, push: true, source: "digest" }),
    },
  ],
  "digest push off": [
    {
      step: "digest with push off",
      squireId: LEAD,
      run: raiseCard({ kind: "fyi", squireId: LEAD, push: false }),
    },
  ],
  "question alone": [
    { step: "question card", squireId: RELEASE, run: raiseCard({ kind: "question", push: false }) },
  ],
  "notify off": [
    { step: "steer card", squireId: RELEASE, run: raiseCard({ kind: "steer", push: false }) },
    { step: "proposal card", squireId: RELEASE, run: raiseCard({ kind: "proposal", push: false }) },
    { step: "notify FYI", squireId: RELEASE, run: raiseCard({ kind: "fyi", push: false }) },
  ],
  "held then escalated": [
    {
      step: "card while a desktop is active",
      squireId: RELEASE,
      run: desktopActive.pipe(Effect.andThen(raiseCard({ kind: "steer", push: true }))),
    },
    {
      step: "escalated at 3 min",
      squireId: RELEASE,
      run: TestClock.adjust(SquirePresence.SQUIRE_ESCALATION_DELAY_MS).pipe(
        Effect.andThen(Effect.flatMap(SquirePresence.SquirePresence, (p) => p.escalateDue)),
      ),
    },
  ],
  "opened before escalation": [
    {
      step: "card while a desktop is active",
      squireId: RELEASE,
      run: desktopActive.pipe(Effect.andThen(raiseCard({ kind: "steer", push: true }))),
    },
    {
      step: "opened at 1 min",
      squireId: RELEASE,
      run: Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        const repository = yield* SquireRepository.SquireRepository;
        const [card] = yield* repository.listCards({ squireId: RELEASE });
        const presence = yield* SquirePresence.SquirePresence;
        yield* presence.markOpened({ requestId: "open-1", cardIds: [card!.id] });
      }),
    },
    {
      step: "3 min pass",
      squireId: RELEASE,
      run: TestClock.adjust("2 minutes").pipe(
        Effect.andThen(Effect.flatMap(SquirePresence.SquirePresence, (p) => p.escalateDue)),
      ),
    },
  ],
  "held FYI": [
    {
      step: "notify FYI while a desktop is active",
      squireId: RELEASE,
      run: desktopActive.pipe(
        Effect.andThen(raiseCard({ kind: "fyi", push: true, source: "notify" })),
      ),
    },
    {
      step: "3 min pass",
      squireId: RELEASE,
      run: TestClock.adjust(SquirePresence.SQUIRE_ESCALATION_DELAY_MS).pipe(
        Effect.andThen(Effect.flatMap(SquirePresence.SquirePresence, (p) => p.escalateDue)),
      ),
    },
  ],
} satisfies Record<string, ReadonlyArray<ScenarioStep>>;

describe("Squire phone row (D27)", () => {
  it.effect("publishes the shared fixture's payload sequence and one mobile row per intent", () =>
    Effect.gen(function* () {
      const scenarios: Record<string, Effect.Success<ReturnType<typeof runSquireScenario>>> = {};
      for (const [name, steps] of Object.entries(squireScenarios)) {
        squireCardSeq = 0;
        scenarios[name] = yield* runSquireScenario(steps);
      }
      const view = (name: string) =>
        scenarios[name]!.map(({ step, publishes, mobile }) => ({
          step,
          publish: publishes.map((publish) =>
            publish.state === null
              ? null
              : `${publish.state.threadTitle}: ${publish.state.headline}`,
          ),
          mobile,
        }));

      assert.deepStrictEqual(view("cards"), [
        { step: "first card", publish: ["Release: 1 open decision"], mobile: ["alerted"] },
        { step: "second card", publish: ["Release: 2 open decisions"], mobile: ["coalesced"] },
        { step: "queue cleared", publish: [null], mobile: [] },
        { step: "next card", publish: ["Release: 1 open decision"], mobile: ["alerted"] },
      ]);
      assert.deepStrictEqual(view("notify"), [
        { step: "notify-only push", publish: ["Release: 1 update"], mobile: ["alerted"] },
        { step: "its FYI dismissed", publish: [null], mobile: [] },
        { step: "second notify-only push", publish: ["Release: 1 update"], mobile: ["alerted"] },
      ]);
      assert.deepStrictEqual(view("digests"), [
        { step: "pushed digest", publish: ["Lead: 1 update"], mobile: ["alerted"] },
      ]);
      // No intent: no row, and nothing owed a delivery row.
      for (const name of ["digest push off", "question alone", "notify off"]) {
        for (const step of view(name)) {
          assert.deepStrictEqual([step.publish, step.mobile], [[], []], `${name}: ${step.step}`);
        }
      }
      // A held intent reaches the phone only by escalating; opened first, or an FYI, never.
      assert.deepStrictEqual(view("held then escalated"), [
        { step: "card while a desktop is active", publish: [], mobile: [] },
        { step: "escalated at 3 min", publish: ["Release: 1 open decision"], mobile: ["alerted"] },
      ]);
      assert.deepStrictEqual(view("opened before escalation"), [
        { step: "card while a desktop is active", publish: [], mobile: [] },
        { step: "opened at 1 min", publish: [], mobile: [] },
        { step: "3 min pass", publish: [], mobile: [] },
      ]);
      assert.deepStrictEqual(view("held FYI"), [
        { step: "notify FYI while a desktop is active", publish: [], mobile: [] },
        { step: "3 min pass", publish: [], mobile: [] },
      ]);

      const publishes = Object.values(scenarios).flatMap((steps) =>
        steps.flatMap((step) => step.publishes),
      );
      for (const publish of publishes) {
        // Presence is SquirePresence's call: the relay must ring a present user's phone.
        assert.isFalse(publish.userPresent);
        const encoded = JSON.stringify(publish.state);
        assert.notInclude(encoded, ITEM_TEXT);
        if (publish.state !== null) {
          assert.strictEqual(publish.state.phase, "waiting_for_input");
          assert.strictEqual(publish.state.threadId, publish.threadId);
          assert.isAtMost(new TextEncoder().encode(encoded).byteLength, 1_024);
        }
      }

      // The relay replays this file (SquireAttentionDelivery.test.ts). Rewrite
      // it with SQUIRE_FIXTURE_WRITE=1 after an intended change, then format it.
      const fs = yield* FileSystem.FileSystem;
      const file = yield* (yield* Path.Path).fromFileUrl(new URL(SQUIRE_FIXTURE, import.meta.url));
      const actual = JSON.stringify({ environmentId: "relay-environment", scenarios }, null, 2);
      if (process.env.SQUIRE_FIXTURE_WRITE === "1") yield* fs.writeFileString(file, `${actual}\n`);
      assert.deepStrictEqual(JSON.parse(actual), JSON.parse(yield* fs.readFileString(file)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a long name within the relay's row cap and carries no item text", () =>
    withSquires(
      Effect.gen(function* () {
        const repository = yield* SquireRepository.SquireRepository;
        const release = Option.getOrThrow(yield* repository.getSquire(RELEASE));
        yield* repository.updateSquire({
          id: RELEASE,
          expectedRevision: release.revision,
          patch: { name: "Release ".repeat(100) },
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const attention = yield* SquireMobileAttention.SquireMobileAttention;
        const { relay, publications } = yield* makeTestRelay({ squire: attention });
        for (let n = 0; n < 40; n += 1) yield* raiseCard({ kind: "steer", push: true });
        yield* relay.publishThread(RELEASE_HOME);
        const state = publications.at(-1)?.state;
        assert.strictEqual(state?.headline, "40 open decisions");
        assert.isAtMost(state?.threadTitle.length ?? Infinity, 120);
        assert.notInclude(JSON.stringify(state), ITEM_TEXT);
        // The relay's 3.2 KB cap holds its five rows; one Squire row stays far below a fifth.
        assert.isAtMost(new TextEncoder().encode(JSON.stringify(state)).byteLength, 640);
      }),
    ),
  );

  it.effect("records no_transport without Connect or team policy", () =>
    Effect.gen(function* () {
      const outcomes = [];
      for (const options of [{ linked: false }, { canPublishActivity: false }] as const) {
        outcomes.push(
          yield* withSquires(
            Effect.gen(function* () {
              const attention = yield* SquireMobileAttention.SquireMobileAttention;
              const { relay, publications } = yield* makeTestRelay({
                squire: attention,
                ...options,
              });
              yield* raiseCard({ kind: "steer", push: true });
              yield* relay.publishThread(RELEASE_HOME);
              yield* raiseCard({ kind: "proposal", push: true });
              yield* relay.publishThread(RELEASE_HOME);
              assert.lengthOf(publications, 0);
              return (yield* mobileDeliveries(RELEASE)).map((row) => row.reason);
            }),
          ),
        );
      }
      assert.deepStrictEqual(outcomes, [
        // Never linked: Connect never turned publishing on.
        ["disabled", "disabled"],
        ["policy", "policy"],
      ]);
    }),
  );

  it.effect("records no_transport once a failed publish exhausts its retries", () =>
    withSquires(
      Effect.gen(function* () {
        const attention = yield* SquireMobileAttention.SquireMobileAttention;
        const { relay, publications } = yield* makeTestRelay({
          squire: attention,
          respond: () => new Response("unavailable", { status: 503 }),
        });
        yield* raiseCard({ kind: "steer", push: true });
        yield* relay.publishThread(RELEASE_HOME);
        // Still owed while a retry may succeed.
        assert.lengthOf(yield* mobileDeliveries(RELEASE), 0);
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000]) {
          yield* TestClock.adjust(delay);
          yield* relay.drain;
        }
        assert.lengthOf(publications, 6);
        assert.deepStrictEqual(
          (yield* mobileDeliveries(RELEASE)).map((row) => `${row.outcome}:${row.reason}`),
          ["no_transport:failed"],
        );
      }),
    ),
  );

  it.effect("startup reconciles the rows and an intent a crash left without its mobile row", () =>
    withSquires(
      Effect.gen(function* () {
        // Before this process: Release's intent committed, its publish never ran;
        // the Lead's row may still sit on the relay with an emptied set.
        yield* raiseCard({ kind: "steer", push: true });
        const attention = yield* SquireMobileAttention.SquireMobileAttention;
        const { relay, publications } = yield* makeTestRelay({ squire: attention });
        yield* relay.start();
        yield* TestClock.adjust("1 second");
        yield* relay.drain;
        assert.deepStrictEqual(
          publications
            .map((publication) => [
              publishedThreadId(publication.url),
              publication.state?.headline ?? null,
            ])
            .toSorted(),
          [
            [LEAD_HOME, null],
            [RELEASE_HOME, "1 open decision"],
          ],
        );
        assert.deepStrictEqual(
          (yield* mobileDeliveries(RELEASE)).map((row) => row.outcome),
          ["alerted"],
        );
      }),
    ),
  );

  it.effect("signals a home thread on an intent, an escalation, and an emptied set", () =>
    withSquires(
      Effect.gen(function* () {
        const attention = yield* SquireMobileAttention.SquireMobileAttention;
        const signalled = yield* Queue.unbounded<ThreadId>();
        yield* Stream.runForEach(yield* attention.subscribe, (threadId) =>
          Queue.offer(signalled, threadId),
        ).pipe(Effect.forkScoped);
        const cardId = yield* raiseCard({ kind: "steer", push: true });
        assert.strictEqual(yield* Queue.take(signalled), RELEASE_HOME);
        yield* raiseCard({ kind: "fyi", squireId: LEAD, push: true, source: "digest" });
        assert.strictEqual(yield* Queue.take(signalled), LEAD_HOME);
        yield* closeCard(cardId, "dismissed");
        assert.strictEqual(yield* Queue.take(signalled), RELEASE_HOME);
      }),
    ),
  );

  it.effect("never publishes a Squire's probe or other non-home thread", () =>
    withSquires(
      Effect.gen(function* () {
        const attention = yield* SquireMobileAttention.SquireMobileAttention;
        const { relay, currentShell, publications } = yield* makeTestRelay({ squire: attention });
        yield* raiseCard({ kind: "steer", push: true });
        yield* Ref.set(
          currentShell,
          shell({ id: ThreadId.make("probe"), squire: { squireId: RELEASE, role: "probe" } }),
        );
        yield* relay.publishThread(ThreadId.make("probe"));
        yield* TestClock.adjust("5 seconds");
        yield* relay.drain;
        assert.lengthOf(publications, 0);
        assert.lengthOf(yield* mobileDeliveries(RELEASE), 0);
      }),
    ),
  );
});
