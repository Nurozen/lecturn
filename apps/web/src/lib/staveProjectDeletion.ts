import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { staveMembershipDeletionWarning } from "./staveProjectDeletion.logic";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { serverEnvironment } from "../state/server";
import { staveSpaceStatusRead } from "../state/stave";

/** Fetch immediately before asking: a cached manifest cannot authorize roster removal. */
export async function prepareStaveProjectDeletion(member: SidebarProjectGroupMember) {
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
