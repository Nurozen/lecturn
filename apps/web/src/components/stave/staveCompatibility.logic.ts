import type { StaveOperation, StaveSpaceStatus, StaveStatus } from "@t3tools/contracts";

const OPERATION_LABELS: Record<StaveOperation["kind"], string> = {
  createSpace: "Create space",
  registerRepo: "Register repository",
  removePartialSpace: "Remove partial space",
  setup: "Set up Stave",
  addRepo: "Add repository",
  removeRepo: "Remove repository",
  syncSpace: "Sync space",
  retarget: "Retarget repository",
  archiveSpace: "Archive space",
  destroySpace: "Destroy space",
  restoreSpace: "Unarchive space",
  memoryAttach: "Attach memory",
  memoryDetach: "Detach memory",
  createSaga: "Create saga",
  sagaAdd: "Add saga member",
  sagaRemove: "Remove saga member",
  sagaSync: "Sync saga",
  sagaArchive: "Archive saga",
  sagaDestroy: "Destroy saga",
  lifecycleAction: "Automatic cleanup",
};

export function staveOperationLabel(kind: string): string {
  return Object.hasOwn(OPERATION_LABELS, kind)
    ? OPERATION_LABELS[kind as StaveOperation["kind"]]
    : "Additional action";
}

/** Optional probe fields preserve compatibility with older integration servers. */
export function staveOperationUnavailableReason(
  status: StaveStatus | null | undefined,
  operation: StaveOperation | StaveOperation["kind"],
  lifecycleIsSaga?: boolean,
): string | null {
  if (
    typeof operation !== "string" &&
    operation.kind === "lifecycleAction" &&
    (operation.action === "keep" || operation.action === "dismiss")
  )
    return null;
  // Deleted cleanup DTOs do not carry root kind. Their server-side preview resolves it;
  // guessing here could incorrectly block a supported saga action as a space action.
  if (
    typeof operation !== "string" &&
    operation.kind === "lifecycleAction" &&
    lifecycleIsSaga === undefined
  )
    return null;
  const kind =
    typeof operation === "string"
      ? operation
      : operation.kind === "lifecycleAction"
        ? operation.action === "archiveNow" || operation.target === "archive"
          ? lifecycleIsSaga
            ? "sagaArchive"
            : "archiveSpace"
          : lifecycleIsSaga
            ? "sagaDestroy"
            : "destroySpace"
        : operation.kind;
  if (!status?.features?.unsupportedOperations.includes(kind)) return null;
  return `${staveOperationLabel(kind)} is unavailable with this Stave binary. Select a compatible binary in Settings → Stave.`;
}

export function staveMemoryConfigurationText(wiring: StaveSpaceStatus["memoryWiring"]): string {
  switch (wiring?.state) {
    case "configured":
      return "Memory configuration is ready for supported provider sessions. A live connection has not been verified.";
    case "absent":
      return "No active Stave memory configuration is available for this space.";
    case "unavailable":
      return wiring.code === "missing_config"
        ? "Stave's memory configuration is missing. Reattach the memory store with Stave to regenerate it."
        : "Stave's memory configuration could not be loaded. Review the space's memory configuration with Stave.";
    default:
      return "This server has not reported memory wiring status.";
  }
}

export function staveProviderSupportText(row: { supported: boolean; limitation?: string }): string {
  if (!row.supported) return "Unavailable";
  if (row.limitation === "external_server_unsupported") return "Local servers only";
  return row.limitation ? "Supported with limitations" : "Supported";
}
