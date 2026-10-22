import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
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
