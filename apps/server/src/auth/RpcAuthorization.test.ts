import {
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
  rpcAuthorizationError,
  rpcScopeAuthorizationLayer,
} from "./RpcAuthorization.ts";

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
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
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

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
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
      for (const [tag, rpc] of WsRpcGroup.requests) {
        expect(rpc.middlewares.has(RpcScopeAuthorization), tag).toBe(true);
        const required = requiredScopeForRpcMethod(tag);
        for (const scope of AuthEnvironmentScope.literals) {
          const middleware = yield* Effect.service(RpcScopeAuthorization).pipe(
            Effect.provide(rpcScopeAuthorizationLayer([scope])),
          );
          type MiddlewareArgs = Parameters<typeof middleware>;
          const handler = Effect.succeed("handled") as unknown as MiddlewareArgs[0];
          const outcome = yield* middleware(handler, { rpc } as unknown as MiddlewareArgs[1]).pipe(
            Effect.catch((error) => Effect.succeed(error)),
          );
          expect(outcome, `${tag} with ${scope}`).toEqual(
            scope === required ? "handled" : rpcAuthorizationError(required),
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

  it.effect("checks each RPC's declared scope before its handler runs", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            rpcScopeAuthorizationLayer([AuthOrchestrationReadScope]),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
