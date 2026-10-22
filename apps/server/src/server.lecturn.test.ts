// Lecturn wiring promises re-homed from the fork's server.test.ts (upstream deleted it
// with orchestration V2): fork RPC registration and scopes, the thread forking kill
// switch, and the fork capabilities the environment descriptor advertises.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
  CommandId,
  CONTEXTUAL_RPC_SCOPES,
  CONTEXTUAL_WS_METHODS,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { forkKillSwitchRejection, WS_RPC_HANDLER_GROUPS } from "./ws.ts";

const read = AuthOrchestrationReadScope;
const operate = AuthOrchestrationOperateScope;

/** Fork RPC scopes as shipped by Lecturn before orchestration V2 (322890f6). */
const FORK_RPC_SCOPES: ReadonlyArray<readonly [string, string]> = [
  [WS_METHODS.staveGetStatus, read],
  [WS_METHODS.staveSpaceStatus, read],
  [WS_METHODS.staveSagaStatus, read],
  [WS_METHODS.staveListRepos, read],
  [WS_METHODS.staveListSpaces, read],
  [WS_METHODS.staveListSagas, read],
  [WS_METHODS.staveMemoryProviders, read],
  [WS_METHODS.staveDryRun, read],
  [WS_METHODS.staveObserveOperation, read],
  [WS_METHODS.staveRunOperation, operate],
  [WS_METHODS.threadDecisionsFundingStatus, read],
  [WS_METHODS.threadDecisionsFunding, AuthRelayWriteScope],
  [WS_METHODS.threadDecisionsList, read],
  [WS_METHODS.threadDecisionsGet, read],
  [WS_METHODS.threadDecisionsStatus, read],
  [WS_METHODS.threadDecisionsSourceWindow, read],
  [WS_METHODS.threadDecisionsExport, read],
  [WS_METHODS.threadDecisionsSubscribe, read],
  [WS_METHODS.threadDecisionsMutate, operate],
  [WS_METHODS.threadDecisionsSettings, operate],
  [WS_METHODS.threadDecisionsScan, operate],
  [WS_METHODS.threadNotesList, read],
  [WS_METHODS.threadNotesCreate, operate],
  [WS_METHODS.threadNotesUpdate, operate],
  [WS_METHODS.threadNotesDelete, operate],
  [WS_METHODS.pullRequestWatchList, read],
  [WS_METHODS.pullRequestWatchTrack, operate],
  [WS_METHODS.pullRequestWatchCommand, operate],
  [WS_METHODS.pullRequestWatchConfigure, operate],
  [WS_METHODS.sagaWorkbenchGetSnapshot, read],
  [WS_METHODS.sagaWorkbenchGetEvidence, read],
  [WS_METHODS.sagaWorkbenchGetActivity, read],
  [WS_METHODS.sagaWorkbenchConfigure, operate],
  [WS_METHODS.sagaWorkbenchSetStage, operate],
  [WS_METHODS.sagaWorkbenchApprove, operate],
  [WS_METHODS.sagaWorkbenchComplete, operate],
  [WS_METHODS.sagaWorkbenchReopen, operate],
  [WS_METHODS.sagaWorkbenchSummarize, operate],
  [WS_METHODS.externalSessionsList, read],
  [WS_METHODS.cloudCreateManualLinkProof, AuthRelayWriteScope],
  [WS_METHODS.cloudApplyManualRelayConfig, AuthRelayWriteScope],
  [ORCHESTRATION_V2_WS_METHODS.previewCheckpointRevert, read],
];

const groupTags = (group: { readonly requests: ReadonlyMap<string, unknown> }) =>
  new Set(group.requests.keys());

describe("Lecturn WS RPC wiring", () => {
  it("serves every WS RPC from exactly one handler group", () => {
    const groups = Object.values(WS_RPC_HANDLER_GROUPS).map(groupTags);
    const served = groups.flatMap((tags) => [...tags]);
    expect(served.length).toBe(new Set(served).size);
    expect(new Set(served)).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("routes the fork RPC families to the Lecturn and Contextual handler groups", () => {
    const lecturn = groupTags(WS_RPC_HANDLER_GROUPS.lecturn);
    for (const [method] of FORK_RPC_SCOPES) {
      expect(lecturn.has(method), method).toBe(true);
    }
    const contextual = groupTags(WS_RPC_HANDLER_GROUPS.contextual);
    for (const method of Object.values(CONTEXTUAL_WS_METHODS)) {
      expect(contextual.has(method), method).toBe(true);
    }
  });

  it("keeps fork RPC scopes at their pre-V2 values", () => {
    for (const [method, scope] of FORK_RPC_SCOPES) {
      expect(requiredScopeForRpcMethod(method), method).toBe(scope);
    }
    for (const [method, scope] of Object.entries(CONTEXTUAL_RPC_SCOPES)) {
      expect(requiredScopeForRpcMethod(method), method).toBe(scope);
    }
  });
});

describe("thread forking kill switch", () => {
  const commandId = CommandId.make("kill-switch-command");

  it("refuses thread.fork and thread.import while disabled, before dispatch", () => {
    const fork = forkKillSwitchRejection(false, { type: "thread.fork", commandId });
    expect(fork?.message).toContain("disabled");
    expect(fork?.threadImportFailure).toBeUndefined();

    const imported = forkKillSwitchRejection(false, { type: "thread.import", commandId });
    expect(imported?.threadImportFailure).toBe("forking-disabled");
    expect(imported?.commandType).toBe("thread.import");
  });

  it("passes other commands, and everything while enabled", () => {
    expect(forkKillSwitchRejection(false, { type: "thread.turn.start", commandId })).toBe(
      undefined,
    );
    expect(forkKillSwitchRejection(true, { type: "thread.fork", commandId })).toBe(undefined);
    expect(forkKillSwitchRejection(true, { type: "thread.import", commandId })).toBe(undefined);
  });
});

it.layer(NodeServices.layer)("Lecturn environment descriptor", (it) => {
  const describeWith = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layer({ ...config, ...overrides })),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-server-descriptor-test-" }),
      ),
    );

  it.effect("advertises protocol 2 and the fork capabilities", () =>
    Effect.gen(function* () {
      const descriptor = yield* describeWith({});
      expect(descriptor.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
      expect(ORCHESTRATION_PROTOCOL_VERSION).toBe(2);
      expect(descriptor.capabilities).toMatchObject({
        threadForking: true,
        threadNotes: true,
        threadDecisions: true,
        contextual: true,
        manualCloudLink: true,
        stave: { protocolVersion: 1 },
      });
    }),
  );

  it.effect("withdraws threadForking when the kill switch is off", () =>
    Effect.gen(function* () {
      const descriptor = yield* describeWith({ threadForkingEnabled: false });
      expect(descriptor.capabilities.threadForking).toBeUndefined();
      expect(descriptor.capabilities.threadNotes).toBe(true);
    }),
  );
});
