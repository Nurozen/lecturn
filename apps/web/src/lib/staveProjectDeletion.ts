import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { StaveSagaTeardownAuthorization } from "@t3tools/contracts";
import {
  staveMembershipDeletionWarning,
  staveSagaReviewLines,
  staveSagaTeardownAuthorization,
} from "./staveProjectDeletion.logic";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { serverEnvironment } from "../state/server";
import { staveDryRun, staveSpaceStatusRead } from "../state/stave";

/** Fetch immediately before asking: a cached manifest cannot authorize roster removal. */
export interface StaveProjectDeletionPreview {
  lines: string[];
  staveSagaRemoveConfirmed: boolean;
  staveSagaTeardown?: StaveSagaTeardownAuthorization;
}

export async function prepareStaveProjectDeletion(
  member: SidebarProjectGroupMember,
): Promise<StaveProjectDeletionPreview> {
  if (!member.stave) return { lines: [] as string[], staveSagaRemoveConfirmed: false };
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(member.environmentId));
  const lifecycle = config?.settings.stave.lifecycle;
  if (!config?.environment.capabilities.stave || !config.settings.stave.enabled) {
    return {
      lines: ["Stave cleanup is disabled. The space remains on disk."],
      staveSagaRemoveConfirmed: false,
    };
  }
  if (member.stave.state === "archived" || lifecycle?.onProjectDelete === "keep") {
    return { lines: ["The Stave space is left on disk."], staveSagaRemoveConfirmed: false };
  }
  if (member.stave.isSaga) {
    const archive = lifecycle?.onProjectDelete === "archive";
    const memory = archive ? "keep" : (lifecycle?.memoryFateOnDestroy ?? "keep");
    const result = await runAtomCommand(
      appAtomRegistry,
      staveDryRun,
      {
        environmentId: member.environmentId,
        input: {
          operation: archive
            ? {
                kind: "sagaArchive",
                sagaRoot: member.workspaceRoot,
                ...(member.stave.createdAt
                  ? { expectedManifestCreatedAt: member.stave.createdAt }
                  : {}),
                force: false,
                memory: "keep",
              }
            : {
                kind: "sagaDestroy",
                sagaRoot: member.workspaceRoot,
                ...(member.stave.createdAt
                  ? { expectedManifestCreatedAt: member.stave.createdAt }
                  : {}),
                force: false,
                memory,
              },
        },
      },
      { reportFailure: false },
    );
    const review = result._tag === "Success" ? result.value.sagaReview : undefined;
    const authorization = review ? staveSagaTeardownAuthorization(review) : undefined;
    if (!review || !authorization)
      return {
        lines: [
          "The saga cleanup scope could not be reviewed. Only this project will be removed now; saga cleanup requires review in Stave settings.",
        ],
        staveSagaRemoveConfirmed: false,
      };
    return {
      lines: [
        ...staveSagaReviewLines(review, true),
        ...(review.memory === "destroy" ? ["Owned memory stores will also be destroyed."] : []),
        "Cleanup is never automatically forced.",
      ],
      staveSagaRemoveConfirmed: false,
      staveSagaTeardown: authorization,
    };
  }
  const lines = [
    lifecycle?.onProjectDelete === "archive"
      ? "Stave will archive this space after the project is deleted. Its spec, notes, and committed branches survive."
      : "Stave will destroy this space after the project is deleted. Its spec and notes are permanently removed; committed branches survive. Cleanup is never automatically forced.",
  ];
  if (lifecycle?.onProjectDelete !== "archive" && lifecycle?.memoryFateOnDestroy === "destroy") {
    lines.push("Owned memory stores will also be destroyed.");
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    staveSpaceStatusRead,
    {
      environmentId: member.environmentId,
      input: { workspaceRoot: member.workspaceRoot },
    },
    { reportFailure: false },
  );
  const warning = staveMembershipDeletionWarning(
    result._tag === "Success" ? result.value : { membershipUnknown: true },
  );
  if (warning.message) lines.push(warning.message);
  return { lines, staveSagaRemoveConfirmed: warning.confirmed };
}
