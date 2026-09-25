import { environmentSupportsStave } from "@lecturn/client-runtime/state/stave";
import type { EnvironmentId, StaveOperation, StaveProjectInfo } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { staveStatus } from "../../state/stave";
import { staveOperationUnavailableReason } from "./staveCompatibility.logic";

export interface StaveSpaceConfirmation {
  readonly title: string;
  readonly operation: StaveOperation;
}

/**
 * Space settings and the sidebar open the same archive confirmation. A saga
 * member's archive is one reviewed action that leaves the saga first; other
 * spaces skip the server's saga membership scan.
 */
export function staveArchiveSpaceConfirmation(
  workspaceRoot: string,
  stave: StaveProjectInfo,
): StaveSpaceConfirmation {
  return {
    title: stave.memberOf ? `Archive space and leave saga ${stave.memberOf}` : "Archive space",
    operation: {
      kind: "archiveSpace",
      workspaceRoot,
      expectedManifestCreatedAt: stave.createdAt,
      force: false,
      memory: "keep",
      ...(stave.memberOf ? { sagaRemoveConfirmed: true } : {}),
    },
  };
}

export function staveUnarchiveSpaceConfirmation(
  workspaceRoot: string,
  stave: StaveProjectInfo,
  from: string,
): StaveSpaceConfirmation {
  return {
    title: "Unarchive space",
    operation: {
      kind: "restoreSpace",
      workspaceRoot,
      expectedManifestCreatedAt: stave.createdAt,
      from,
    },
  };
}

/**
 * The Archive or Unarchive menu entry for a Stave space row, read at
 * menu-open time. Null for sagas, non-Stave projects, and environments where
 * Stave is off; disabled for unbound manifests or a binary that lacks the
 * operation (the same check space settings applies).
 */
export function readStaveSpaceLifecycleMenuEntry(member: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly stave?: StaveProjectInfo | null | undefined;
}): (StaveSpaceConfirmation & { readonly disabled: boolean }) | null {
  const stave = member.stave;
  if (!stave || stave.isSaga || stave.kind === "saga") return null;
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(member.environmentId));
  if (!environmentSupportsStave(config) || config?.settings.stave.enabled !== true) return null;
  const status = Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(staveStatus({ environmentId: member.environmentId, input: {} })),
    ),
  );
  const unsupported = (kind: StaveOperation["kind"]) =>
    staveOperationUnavailableReason(status, kind) !== null;
  if (stave.state === "archived") {
    if (!stave.archiveBasename) return null;
    return {
      ...staveUnarchiveSpaceConfirmation(member.workspaceRoot, stave, stave.archiveBasename),
      disabled: !stave.createdAt || unsupported("restoreSpace"),
    };
  }
  if (stave.state !== "live") return null;
  return {
    ...staveArchiveSpaceConfirmation(member.workspaceRoot, stave),
    disabled: !stave.createdAt || unsupported("archiveSpace"),
  };
}
