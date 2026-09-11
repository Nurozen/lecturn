import type {
  ProjectId,
  StaveLifecycleActionOperation,
  StaveLifecycleSettings,
  StaveProjectNotice,
} from "@lecturn/contracts";

export function lifecycleOperation(input: {
  projectId: ProjectId;
  workspaceRoot: string;
  createdAt?: string | null | undefined;
  action: StaveLifecycleActionOperation["action"];
  policy: StaveLifecycleSettings;
  force?: boolean;
}): StaveLifecycleActionOperation | null {
  const destructive = input.action === "retry" || input.action === "archiveNow";
  if (destructive && !input.createdAt) return null;
  if (input.action === "retry" && input.policy.onProjectDelete === "keep") return null;
  return {
    kind: "lifecycleAction",
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    ...(input.createdAt ? { expectedManifestCreatedAt: input.createdAt } : {}),
    action: input.action,
    ...(input.action === "retry" && input.policy.onProjectDelete !== "keep"
      ? { target: input.policy.onProjectDelete }
      : {}),
    force: destructive && (input.force ?? false),
    memory:
      input.action === "retry" && input.policy.onProjectDelete === "destroy"
        ? input.policy.memoryFateOnDestroy
        : "keep",
  };
}

export function lifecycleNoticeLabel(notice: StaveProjectNotice | null | undefined): string | null {
  switch (notice?.kind) {
    case "archive_scheduled":
      return notice.code === "archive_suggested" ? "Archive suggested" : "Archive pending";
    case "refused":
      return "Cleanup refused";
    case "pending_cleanup":
      return "Cleanup pending";
    default:
      return null;
  }
}

export function lifecycleNoticeDescription(
  notice: StaveProjectNotice,
  policy: StaveLifecycleSettings,
): string {
  if (notice.message) return notice.message;
  if (notice.kind === "archive_scheduled") {
    if (policy.onAllThreadsSettled === "suggest")
      return "All threads are settled. You can archive this space when ready.";
    if (notice.at)
      return `This space is scheduled to archive after ${new Date(notice.at).toLocaleString()}.`;
    return "This space is scheduled to archive.";
  }
  return notice.code
    ? `Cleanup needs attention: ${notice.code}.`
    : "Space cleanup needs your attention.";
}
