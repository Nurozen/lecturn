import type { StaveOperation } from "@t3tools/contracts";

/** Only refusals that Stave explicitly allows --force to bypass offer a retry. */
export function canForceStaveOperation(operation: StaveOperation, code: string | undefined) {
  return (
    "force" in operation &&
    !operation.force &&
    (code === "dirty_worktrees" || code === "dependent_spaces")
  );
}

export function forceStaveOperation(operation: StaveOperation): StaveOperation {
  return "force" in operation ? { ...operation, force: true } : operation;
}

export function staveOperationLossCopy(operation: StaveOperation): string {
  switch (operation.kind) {
    case "destroySpace":
    case "sagaDestroy":
    case "removePartialSpace":
      return "This permanently removes the space directory, including its spec and notes. Committed branches remain in Stave's repository cache.";
    case "archiveSpace":
    case "sagaArchive":
      return "This stops sessions, removes worktrees, and moves the space into the archive. Its manifest, spec, notes, and committed branches survive. Unarchive restores the worktrees.";
    case "removeRepo":
      return "This removes the selected checkout from this space. Its committed branch remains in Stave's repository cache.";
    case "memoryDetach":
      return operation.fate === "destroy"
        ? "This detaches the memory and destroys its owned store. An attached store owned elsewhere is kept."
        : "This detaches the memory and keeps its store.";
    case "restoreSpace":
      return "This rebuilds the archived space's worktrees and moves the project back to its live location.";
    default:
      return "Review the changes Stave will make to this space before continuing.";
  }
}

export function staveRefusalCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
