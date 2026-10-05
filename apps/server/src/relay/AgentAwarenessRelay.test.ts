import { TeamPolicy } from "../cloud/TeamPolicy.ts";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@lecturn/contracts";
import type {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityState,
} from "@lecturn/contracts/relay";
import { CommandId, ProviderInstanceId } from "@lecturn/contracts";
import { RelayClientTracer } from "@lecturn/shared/relayTracing";
import { RELAY_ACTIVITY_PUBLISH_TYP, verifyRelayJwt } from "@lecturn/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
} from "../cloud/config.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const state: RelayAgentActivityState = {
  environmentId: "env" as RelayAgentActivityState["environmentId"],
  threadId: "thread" as RelayAgentActivityState["threadId"],
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-05-25T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};

const backgroundPolicyStub = (isUserPresent: Effect.Effect<boolean>) =>
  ({ isUserPresent }) as unknown as BackgroundPolicy["Service"];

const encodeSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store = {
    get: ((name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) {
          return existing;
        }
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStore["Service"]["remove"],
  } satisfies ServerSecretStore.ServerSecretStore["Service"];
  return {
    store,
    setString: (name: string, value: string) => store.set(name, encodeSecret(value)),
  };
}

describe.sequential("signRelayAgentActivityPublishProof", () => {
  it("distinguishes pending link credentials from disabled publication", () => {
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: false,
        publishEnabled: false,
      }),
    ).toBe("waiting-for-link");
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: true,
        publishEnabled: false,
      }),
    ).toBe("disabled");
    expect(
      AgentAwarenessRelay.resolveAgentActivityPublishingStartupState({
        relayConfigured: true,
        publishEnabled: true,
      }),
    ).toBe("enabled");
  });

  it("derives the thread id from the aggregate id for thread events without payload thread ids", () => {
    const threadId = "thread-aggregate-1" as ThreadId;
    const now = "2026-05-25T00:00:00.000Z";
    const event = {
      type: "thread.activity-appended",
      sequence: 1,
      eventId: "evt-aggregate-1",
      commandId: CommandId.make("cmd-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      actor: { kind: "server" },
      payload: {},
      occurredAt: now,
    } as unknown as OrchestrationEvent;

    expect(AgentAwarenessRelay.eventThreadId(event)).toBe(threadId);
  });

  it("does not publish start intents, streaming content, or non-awareness activity events", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const base = {
      sequence: 1,
      eventId: "evt-1",
      commandId: CommandId.make("cmd-1"),
      aggregateKind: "thread",
      aggregateId: "thread-1" as ThreadId,
      occurredAt: now,
    };

    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1" as ThreadId,
          streaming: true,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.activity-appended",
        payload: {
          threadId: "thread-1" as ThreadId,
          activity: {
            kind: "task.progress",
          },
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.activity-appended",
        payload: {
          threadId: "thread-1" as ThreadId,
          activity: {
            kind: "approval.requested",
          },
        },
      } as unknown as OrchestrationEvent),
    ).toBe(true);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1" as ThreadId,
          streaming: false,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        ...base,
        type: "thread.turn-start-requested",
        payload: {
          threadId: "thread-1" as ThreadId,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
  });

  it("does not publish thread.forked, whose child shell inherits a completed latestTurn", () => {
    expect(
      AgentAwarenessRelay.shouldPublishAgentAwarenessEvent({
        sequence: 1,
        eventId: "evt-fork-1",
        commandId: CommandId.make("cmd-fork-1"),
        aggregateKind: "thread",
        aggregateId: "thread-child" as ThreadId,
        occurredAt: "2026-05-25T00:00:00.000Z",
        type: "thread.forked",
        payload: {
          threadId: "thread-child" as ThreadId,
        },
      } as unknown as OrchestrationEvent),
    ).toBe(false);
  });

  it("deduplicates awareness state updates whose only change is their event timestamp", () => {
    expect(AgentAwarenessRelay.agentAwarenessPublishIdentity(state)).toBe(
      AgentAwarenessRelay.agentAwarenessPublishIdentity({
        ...state,
        updatedAt: "2026-05-25T00:10:00.000Z",
      }),
    );
    expect(AgentAwarenessRelay.agentAwarenessPublishIdentity(state)).not.toBe(
      AgentAwarenessRelay.agentAwarenessPublishIdentity({
        ...state,
        phase: "completed",
        headline: "Agent finished",
      }),
    );
  });

  it("requires an explicit opt-in before publishing agent activity", () => {
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled(null)).toBe(false);
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled("false")).toBe(false);
    expect(AgentAwarenessRelay.isAgentActivityPublishingEnabled("true")).toBe(true);
  });

  it("redacts failed activity details and caps other relay detail", () => {
    expect(
      AgentAwarenessRelay.sanitizeRelayAgentActivityState({
        ...state,
        phase: "failed",
        detail: "Provider process exited with secret token.",
      }),
    ).toMatchObject({
      phase: "failed",
      detail: "The agent run failed.",
    });
    expect(
      AgentAwarenessRelay.sanitizeRelayAgentActivityState({
        ...state,
        detail: "x".repeat(200),
      })?.detail,
    ).toHaveLength(160);
  });

  it("resolves a null publish state when a thread or project snapshot disappeared", () => {
    const environmentId = "env-1" as EnvironmentId;
    const threadId = "thread-1" as ThreadId;
    const thread = {
      id: threadId,
      projectId: "project-1" as ProjectId,
      title: "Deleted thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      session: null,
      latestTurn: null,
      updatedAt: "2026-05-25T00:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    } as OrchestrationThreadShell;

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.none(),
        project: Option.none(),
      }),
    ).toEqual({
      projectId: null,
      state: null,
      reason: "thread-not-found",
    });

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(thread),
        project: Option.none(),
      }),
    ).toEqual({
      projectId: "project-1",
      state: null,
      reason: "project-not-found",
    });
  });

  it("excludes settled conversations from startup catch-up and projects their activity tombstone", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const environmentId = "env-1" as EnvironmentId;
    const projectId = "project-1" as ProjectId;
    const activeThreadId = "thread-active" as ThreadId;
    const idleThreadId = "thread-idle" as ThreadId;

    const baseThread = {
      projectId,
      title: "Run remote agent",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies Omit<OrchestrationThreadShell, "id">;

    const settledThread = {
      ...baseThread,
      id: "thread-settled" as ThreadId,
      settledOverride: "settled",
      settledAt: now,
      latestTurn: {
        turnId: "turn-settled" as TurnId,
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
    } satisfies OrchestrationThreadShell;

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId: settledThread.id,
        thread: Option.some(settledThread),
        project: Option.some({
          id: projectId,
          title: "Lecturn",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        }),
      }),
    ).toEqual({ projectId, state: null, reason: "snapshot" });

    expect(
      AgentAwarenessRelay.resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        projects: [
          {
            id: projectId,
            title: "Lecturn",
          },
        ],
        threads: [
          settledThread,
          {
            ...baseThread,
            id: activeThreadId,
            latestTurn: {
              turnId: "turn-1" as TurnId,
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
          },
          {
            ...baseThread,
            id: idleThreadId,
          },
          {
            ...baseThread,
            id: "thread-missing-project" as ThreadId,
            projectId: "missing-project" as ProjectId,
            latestTurn: {
              turnId: "turn-2" as TurnId,
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
          },
        ],
      }),
    ).toEqual([activeThreadId]);
  });

  it.effect("signs the activity publish JWT and rejects tampering", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const payload = {
        iss: "lecturn-env:env",
        aud: "https://relay.example.test",
        sub: "env",
        jti: "nonce-1",
        iat: 100,
        exp: 200,
        environmentId: state.environmentId,
        threadId: state.threadId,
        state,
      } satisfies RelayAgentActivityPublishProofPayload;
      const proof = yield* AgentAwarenessRelay.signRelayAgentActivityPublishProof({
        privateKey: keyPair.privateKey,
        payload,
      });
      const verify = (token: string) =>
        verifyRelayJwt({
          publicKey: keyPair.publicKey,
          token,
          typ: RELAY_ACTIVITY_PUBLISH_TYP,
          issuer: "lecturn-env:env",
          audience: "https://relay.example.test",
          nowEpochSeconds: 150,
        });

      expect(yield* verify(proof)).toMatchObject({ jti: "nonce-1", state });

      const [header, body, signature = ""] = proof.split(".");
      const corruptedSignature = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
      const rejection = yield* Effect.flip(verify(`${header}.${body}.${corruptedSignature}`));
      expect(rejection).toBeDefined();
    }),
  );

  it.effect("keeps the orchestration listener armed until relay config is installed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        const threadShellRequested = yield* Deferred.make<void>();
        const secrets = makeMemorySecretStore();
        const now = "2026-05-25T00:00:00.000Z";
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const environmentId = "env-1" as EnvironmentId;

        const project = {
          id: projectId,
          title: "Lecturn",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;

        const thread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;

        const orchestrationEngine = {
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 1 }),
          streamDomainEvents: Stream.fromQueue(events),
          subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineShape;

        const snapshotQuery = {
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [project],
              threads: [thread],
              updatedAt: now,
            } satisfies OrchestrationShellSnapshot),
          getThreadShellById: () =>
            Deferred.succeed(threadShellRequested, undefined).pipe(
              Effect.ignore,
              Effect.as(Option.some(thread)),
            ),
          getProjectShellById: () => Effect.succeed(Option.some(project)),
        } as unknown as ProjectionSnapshotQueryShape;

        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        } satisfies ExecutionEnvironmentDescriptor;

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, orchestrationEngine),
          Layer.succeed(BackgroundPolicy, backgroundPolicyStub(Effect.succeed(false))),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* relay.start();
          yield* secrets.setString(RELAY_URL_SECRET, "http://127.0.0.1:1");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
          yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");
          yield* Queue.offer(events, {
            type: "thread.activity-appended",
            sequence: 1,
            eventId: "evt-1",
            commandId: CommandId.make("cmd-1"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "server" },
            payload: {
              threadId,
              activity: {
                kind: "approval.requested",
              },
            },
            occurredAt: now,
          } as unknown as OrchestrationEvent);

          yield* Deferred.await(threadShellRequested).pipe(Effect.timeout("2 seconds"));
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("publishes agent activity to the relay transport URL, not the relay issuer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        let resolveFetchSeen: (url: URL) => void = () => {};
        const fetchSeen = new Promise<URL>((resolve) => {
          resolveFetchSeen = resolve;
        });
        const userSpans: Array<string> = [];
        const productSpans: Array<string> = [];
        const collectingTracer = (spans: Array<string>) =>
          Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (endTime, exit) => {
                end(endTime, exit);
                spans.push(span.name);
              };
              return span;
            },
          });
        const secrets = makeMemorySecretStore();
        const now = "2026-05-25T00:00:00.000Z";
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const environmentId = "env-1" as EnvironmentId;

        const project = {
          id: projectId,
          title: "Lecturn",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;

        const thread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies OrchestrationThreadShell;

        const descriptor = {
          environmentId,
          label: "Test Desktop",
          platform: {
            os: "darwin",
            arch: "arm64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        } satisfies ExecutionEnvironmentDescriptor;

        globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : (input as unknown as { readonly url: string }).url,
          );
          resolveFetchSeen(url);
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(BackgroundPolicy, backgroundPolicyStub(Effect.succeed(false))),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.fromQueue(events),
            subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                projects: [project],
                threads: [thread],
                updatedAt: now,
              } satisfies OrchestrationShellSnapshot),
            getThreadShellById: () => Effect.succeed(Option.some(thread)),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
          yield* secrets.setString(RELAY_ISSUER_SECRET, "https://issuer.example.test");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
          yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");
          yield* relay.start();
          yield* Queue.offer(events, {
            type: "thread.activity-appended",
            sequence: 1,
            eventId: "evt-1",
            commandId: CommandId.make("cmd-1"),
            aggregateKind: "thread",
            aggregateId: threadId,
            actor: { kind: "server" },
            payload: {
              threadId,
              activity: {
                kind: "approval.requested",
              },
            },
            occurredAt: now,
          } as unknown as OrchestrationEvent);

          const url = yield* Effect.promise(() => fetchSeen).pipe(Effect.timeout("2 seconds"));
          expect(url.origin).toBe("https://transport.example.test");
          expect(productSpans).toContain("makePublishProof");
          expect(userSpans).not.toContain("makePublishProof");
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.provideService(RelayClientTracer, Option.some(collectingTracer(productSpans))),
          Effect.withTracer(collectingTracer(userSpans)),
        );
      }),
    ),
  );
});

it.effect(
  "does not read or transmit thread activity when organization publishing is disabled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secrets = makeMemorySecretStore();
        yield* secrets.setString(RELAY_URL_SECRET, "https://relay.example.test");
        yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-test-token");
        yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");
        let threadReads = 0;
        const publisher = yield* AgentAwarenessRelay.make.pipe(
          Effect.provideService(TeamPolicy, {
            checkProvider: () => Effect.void,
            canPublishActivity: Effect.succeed(false),
          }),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.store),
          Effect.provideService(BackgroundPolicy, backgroundPolicyStub(Effect.succeed(false))),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed("env-policy" as EnvironmentId),
            getDescriptor: Effect.die("Should not read descriptor"),
          }),
          Effect.provideService(ProjectionSnapshotQuery, {
            getThreadShellById: () =>
              Effect.sync(() => {
                threadReads += 1;
                return Option.none();
              }),
          } as unknown as ProjectionSnapshotQueryShape),
          Effect.provideService(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.succeed(Stream.empty),
            latestSequence: Effect.succeed(0),
          }),
        );
        yield* publisher.publishThread("thread-policy" as ThreadId);
        expect(threadReads).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

describe.sequential("user presence", () => {
  const now = "2026-05-25T00:00:00.000Z";
  const projectId = "project-1" as ProjectId;
  const project = {
    id: projectId,
    title: "Lecturn",
    workspaceRoot: "/workspace",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationProjectShell;

  const makeThread = (
    id: string,
    overrides: Partial<OrchestrationThreadShell> = {},
  ): OrchestrationThreadShell => ({
    id: id as ThreadId,
    projectId,
    title: "Run remote agent",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });

  /**
   * A started relay whose publishes land in `publishes` and whose presence is
   * `presence.current`. The fetch stub is provided as a service because the
   * client's default `globalThis.fetch` is resolved once per process.
   */
  const makeHarness = Effect.fn(function* (threads: ReadonlyArray<OrchestrationThreadShell>) {
    const presence = { current: false, reads: 0 };
    // Request bodies of each relay publish, in order.
    const publishes = yield* Queue.unbounded<unknown>();
    // Set `failNext` to make the relay reject one publish; it lands in `failures`.
    const fetchState = { failNext: false };
    const failures = yield* Queue.unbounded<void>();
    const relayFetch = (async (...args: ConstructorParameters<typeof Request>) => {
      if (fetchState.failNext) {
        fetchState.failNext = false;
        Queue.offerUnsafe(failures, undefined);
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
      Queue.offerUnsafe(publishes, await new Request(...args).json());
      return Response.json({ ok: true, deliveries: [] });
    }) as typeof fetch;

    const secrets = makeMemorySecretStore();
    yield* secrets.setString(RELAY_URL_SECRET, "https://relay.example.test");
    yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
    yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");

    const relay = yield* AgentAwarenessRelay.make.pipe(
      Effect.provideService(TeamPolicy, {
        checkProvider: () => Effect.void,
        canPublishActivity: Effect.succeed(true),
      }),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.store),
      Effect.provideService(
        BackgroundPolicy,
        backgroundPolicyStub(
          Effect.sync(() => {
            presence.reads += 1;
            return presence.current;
          }),
        ),
      ),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed("env-1" as EnvironmentId),
        getDescriptor: Effect.die("Should not read descriptor"),
      }),
      Effect.provideService(ProjectionSnapshotQuery, {
        // Startup catch-up publishes outside the worker; keep it out of these tests.
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [project],
            threads: [],
            updatedAt: now,
          } satisfies OrchestrationShellSnapshot),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      } as unknown as ProjectionSnapshotQueryShape),
      Effect.provideService(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provideService(FetchHttpClient.Fetch, relayFetch),
    );
    yield* relay.start();
    const publishThread = (threadId: ThreadId) =>
      relay.publishThread(threadId).pipe(Effect.provideService(FetchHttpClient.Fetch, relayFetch));
    return { relay, publishThread, presence, publishes, relayFetchState: fetchState, failures };
  });

  it.effect("tells the relay whether the user is present at publish time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { publishThread, presence, publishes } = yield* makeHarness([
          makeThread("thread-present", { hasPendingUserInput: true }),
          makeThread("thread-away", { hasPendingUserInput: true }),
        ]);

        presence.current = true;
        yield* publishThread("thread-present" as ThreadId);
        expect(yield* Queue.take(publishes)).toMatchObject({ userPresent: true });

        presence.current = false;
        yield* publishThread("thread-away" as ThreadId);
        expect(yield* Queue.take(publishes)).toMatchObject({ userPresent: false });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rings once after the user leaves when a thread needed input while they were present",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = "thread-1" as ThreadId;
          const { relay, publishThread, presence, publishes } = yield* makeHarness([
            makeThread(threadId, { hasPendingUserInput: true }),
          ]);

          presence.current = true;
          yield* publishThread(threadId);
          expect(yield* Queue.take(publishes)).toMatchObject({
            state: { phase: "waiting_for_input" },
            userPresent: true,
          });

          // The user is still present at the next check: nothing is redelivered.
          const readsBeforeCheck = presence.reads;
          yield* TestClock.adjust("30 seconds");
          yield* relay.drain;
          expect(presence.reads).toBe(readsBeforeCheck + 1);
          expect(yield* Queue.size(publishes)).toBe(0);

          presence.current = false;
          yield* TestClock.adjust("30 seconds");
          expect(yield* Queue.take(publishes)).toMatchObject({
            state: { phase: "waiting_for_input" },
            userPresent: false,
          });
          yield* relay.drain;

          yield* TestClock.adjust("2 minutes");
          yield* relay.drain;
          expect(yield* Queue.size(publishes)).toBe(0);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a failed redelivery on the next check, then stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = "thread-1" as ThreadId;
        const activation = yield* Deferred.make<void>();
        const { relay, publishThread, presence, publishes, relayFetchState, failures } =
          yield* makeHarness([makeThread(threadId, { hasPendingUserInput: true })]).pipe(
            Effect.provideService(ServerActivation, Deferred.await(activation)),
          );

        presence.current = true;
        yield* publishThread(threadId);
        expect(yield* Queue.take(publishes)).toMatchObject({ userPresent: true });

        presence.current = false;
        relayFetchState.failNext = true;
        // Let startup fibers run only after a suppressed event exists. There must
        // still be a full interval before the first attempt, not an immediate retry.
        yield* Deferred.succeed(activation, undefined);
        yield* TestClock.adjust("29 seconds");
        yield* relay.drain;
        expect(yield* Queue.size(failures)).toBe(0);
        expect(yield* Queue.size(publishes)).toBe(0);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(failures);
        yield* relay.drain;
        expect(yield* Queue.size(publishes)).toBe(0);

        yield* TestClock.adjust("30 seconds");
        expect(yield* Queue.take(publishes)).toMatchObject({
          state: { phase: "waiting_for_input" },
          userPresent: false,
        });
        yield* relay.drain;

        yield* TestClock.adjust("2 minutes");
        yield* relay.drain;
        expect(yield* Queue.size(publishes)).toBe(0);
        expect(yield* Queue.size(failures)).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("redelivers a suppressed completion without a second confirmation delay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = "thread-1" as ThreadId;
        const { relay, publishThread, presence, publishes } = yield* makeHarness([
          makeThread(threadId, {
            latestTurn: {
              turnId: "turn-1" as TurnId,
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId: null,
            },
          }),
        ]);

        // Completed as a first state is confirmed five seconds later.
        presence.current = true;
        yield* publishThread(threadId);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Queue.take(publishes)).toMatchObject({
          state: { phase: "completed" },
          userPresent: true,
        });
        yield* relay.drain;

        // The check at 30s republishes straight away; a second confirmation
        // delay would need the clock to move again and this take would hang.
        presence.current = false;
        yield* TestClock.adjust("25 seconds");
        expect(yield* Queue.take(publishes)).toMatchObject({
          state: { phase: "completed" },
          userPresent: false,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
