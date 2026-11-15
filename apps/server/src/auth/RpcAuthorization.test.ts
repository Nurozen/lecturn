import {
  AuthAccessWriteScope,
  AuthEnvironmentScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  RpcScopeAuthorization,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  CLIENT_GUARDED_RPC_SCOPES,
  SquireRpcs,
  WS_METHODS,
  WsRpcGroup,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("keeps Decisions data readable without granting processing or mutation", () => {
    for (const method of [
      WS_METHODS.threadDecisionsList,
      WS_METHODS.threadDecisionsGet,
      WS_METHODS.threadDecisionsStatus,
      WS_METHODS.threadDecisionsSourceWindow,
      WS_METHODS.threadDecisionsExport,
      WS_METHODS.threadDecisionsSubscribe,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.threadDecisionsMutate,
      WS_METHODS.threadDecisionsSettings,
      WS_METHODS.threadDecisionsScan,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
  it("allows notes reads while reserving mutations for operators", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.threadNotesList)).toBe(AuthOrchestrationReadScope);
    for (const method of [
      WS_METHODS.threadNotesCreate,
      WS_METHODS.threadNotesUpdate,
      WS_METHODS.threadNotesDelete,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
  it("lets only a client that can manage access create a guest link", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.guestShareCreate)).toBe(AuthAccessWriteScope);
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudCreateManualLinkProof)).toBe(
      AuthRelayWriteScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudApplyManualRelayConfig)).toBe(
      AuthRelayWriteScope,
    );
  });

  it("treats Stave status probes as orchestration reads", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.staveGetStatus)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.staveSpaceStatus)).toBe(AuthOrchestrationReadScope);
  });

  it("lets a read-only client list, dry-run and watch Stave operations but not run them", () => {
    for (const method of [
      WS_METHODS.staveListRepos,
      WS_METHODS.staveListSpaces,
      WS_METHODS.staveListSagas,
      WS_METHODS.staveSagaStatus,
      WS_METHODS.staveMemoryProviders,
      WS_METHODS.staveDryRun,
      WS_METHODS.staveObserveOperation,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    expect(requiredScopeForRpcMethod(WS_METHODS.staveRunOperation)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates workbench reads from explicitly authorized workflow changes", () => {
    for (const method of [
      WS_METHODS.sagaWorkbenchGetSnapshot,
      WS_METHODS.sagaWorkbenchGetEvidence,
      WS_METHODS.sagaWorkbenchGetActivity,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    for (const method of [
      WS_METHODS.sagaWorkbenchSetStage,
      WS_METHODS.sagaWorkbenchConfigure,
      WS_METHODS.sagaWorkbenchApprove,
      WS_METHODS.sagaWorkbenchComplete,
      WS_METHODS.sagaWorkbenchReopen,
      WS_METHODS.sagaWorkbenchSummarize,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  // Covers every RPC in the group, including Lecturn-only ones (Stave, saga
  // workbench, Contextual, devices, decisions, notes, pull requests): each one
  // carries the middleware, which admits its declared scope and no other.
  it.effect("admits each RPC with only its declared scope", () =>
    Effect.gen(function* () {
      expect(WsRpcGroup.requests.size).toBe(Object.keys(RPC_REQUIRED_SCOPES).length);
      // Their scopes depend on the payload or need more than one grant; the
      // tests below cover them.
      const payloadScoped = new Set<string>([
        WS_METHODS.assetsCreateUrl,
        WS_METHODS.serverUpdateSettings,
        WS_METHODS.serverRetryResourceTelemetry,
        WS_METHODS.projectsMutate,
      ]);
      for (const [tag, rpc] of WsRpcGroup.requests) {
        expect(rpc.middlewares.has(RpcScopeAuthorization), tag).toBe(true);
        if (payloadScoped.has(tag)) continue;
        const required = requiredScopeForRpcMethod(tag);
        for (const scope of AuthEnvironmentScope.literals) {
          const middleware = yield* Effect.service(RpcScopeAuthorization).pipe(
            Effect.provide(RpcAuthorization.layer([scope])),
          );
          type MiddlewareArgs = Parameters<typeof middleware>;
          const handler = Effect.succeed("handled") as unknown as MiddlewareArgs[0];
          const outcome = yield* middleware(handler, { rpc } as unknown as MiddlewareArgs[1]).pipe(
            Effect.catch((error) => Effect.succeed(error)),
          );
          expect(outcome, `${tag} with ${scope}`).toEqual(
            scope === required ? "handled" : RpcAuthorization.rpcAuthorizationError(required),
          );
        }
      }
    }),
  );

  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

// Lecturn: Squire reads are open to read-only clients; every mutation operates agents.
const SQUIRE_READS: ReadonlySet<string> = new Set([
  WS_METHODS.squireSubscribe,
  WS_METHODS.squireItemsList,
  WS_METHODS.squireItemGet,
  WS_METHODS.squireSummaryGet,
  WS_METHODS.squireActionLogList,
  WS_METHODS.squireVocabulary,
  WS_METHODS.squireRoomPosts,
  WS_METHODS.squireRuleList,
  WS_METHODS.squireTriggerList,
  WS_METHODS.squireTriggerRuns,
  WS_METHODS.squireLeadReceipts,
  WS_METHODS.squireGet,
  WS_METHODS.squireProviderSupport,
]);

describe("Squire RPC scopes", () => {
  const guarded: Readonly<Record<string, string>> = CLIENT_GUARDED_RPC_SCOPES;
  const tags = SquireRpcs.map((rpc) => rpc._tag);

  it("serves reads under orchestration:read without a client guard", () => {
    for (const method of tags.filter((tag) => SQUIRE_READS.has(tag))) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthOrchestrationReadScope);
      expect(guarded[method], method).toBeUndefined();
    }
  });

  it("requires operate for every mutation and guards it on the client", () => {
    const mutations = tags.filter((tag) => !SQUIRE_READS.has(tag));
    expect(mutations).toContain(WS_METHODS.squireLeadEnsure);
    expect(mutations).toContain(WS_METHODS.squireControlRevert);
    for (const method of mutations) {
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthOrchestrationOperateScope);
      expect(guarded[method], method).toBe(AuthOrchestrationOperateScope);
    }
  });

  it.effect("refuses Lead creation to a read-scoped token before the handler runs", () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.squireLeadEnsure> =>
            tag !== WS_METHODS.squireLeadEnsure,
        ),
      );
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.squireLeadEnsure, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.squireLeadEnsure]({ requestId: "ensure-1" }).pipe(Effect.flip),
      ).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});
