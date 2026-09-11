import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const sagaWorkbenchSnapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "saga-workbench:snapshot",
  tag: WS_METHODS.sagaWorkbenchGetSnapshot,
  staleTimeMs: 15_000,
});
export const sagaWorkbenchEvidence = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "saga-workbench:evidence",
  tag: WS_METHODS.sagaWorkbenchGetEvidence,
  staleTimeMs: 15_000,
});
export const sagaWorkbenchActivity = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "saga-workbench:activity",
  tag: WS_METHODS.sagaWorkbenchGetActivity,
  staleTimeMs: 15_000,
});
export const sagaWorkbenchSetStage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:stage",
  tag: WS_METHODS.sagaWorkbenchSetStage,
});
export const sagaWorkbenchApprove = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:approve",
  tag: WS_METHODS.sagaWorkbenchApprove,
});
export const sagaWorkbenchComplete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:complete",
  tag: WS_METHODS.sagaWorkbenchComplete,
});
export const sagaWorkbenchReopen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:reopen",
  tag: WS_METHODS.sagaWorkbenchReopen,
});
export const sagaWorkbenchSummarize = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:summary",
  tag: WS_METHODS.sagaWorkbenchSummarize,
});

export const sagaWorkbenchConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "saga-workbench:configure",
  tag: WS_METHODS.sagaWorkbenchConfigure,
});
