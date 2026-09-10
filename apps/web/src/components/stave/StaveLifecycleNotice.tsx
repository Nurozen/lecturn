import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  StaveLifecycleActionOperation,
  StaveProjectInfo,
  StaveProjectNotice,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useStaveFeatureAvailable } from "../../state/stave";
import { Button } from "../ui/button";
import { canForceStaveOperation } from "./staveConfirm.logic";
import { StaveConfirmDialog } from "./StaveConfirmDialog";
import { lifecycleNoticeDescription, lifecycleOperation } from "./staveLifecycle.logic";

export function StaveLifecycleNotice({
  environmentId,
  projectId,
  workspaceRoot,
  stave,
  notice,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceRoot: string;
  stave: StaveProjectInfo;
  notice: StaveProjectNotice;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const feature = useStaveFeatureAvailable(environmentId);
  const [operation, setOperation] = useState<StaveLifecycleActionOperation | null>(null);
  const archive = lifecycleOperation({
    projectId,
    workspaceRoot,
    createdAt: stave.createdAt,
    action: "archiveNow",
    policy: settings.stave.lifecycle,
  });
  const keep = lifecycleOperation({
    projectId,
    workspaceRoot,
    createdAt: stave.createdAt,
    action: "keep",
    policy: settings.stave.lifecycle,
  })!;
  const mutable = feature.available && stave.state !== "archived";
  return (
    <div
      className="mx-3 mb-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
      role="status"
    >
      <p>{lifecycleNoticeDescription(notice, settings.stave.lifecycle)}</p>
      {!stave.createdAt ? (
        <p className="text-xs text-muted-foreground">
          This legacy manifest has no creation stamp. Repair the manifest before running cleanup;
          Keep is still available.
        </p>
      ) : null}
      {!feature.available ? (
        <p className="text-xs text-muted-foreground">
          Enable Stave and configure a runnable binary to resume cleanup.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!mutable || archive === null}
          onClick={() => setOperation(archive)}
        >
          Archive now
        </Button>
        {archive && canForceStaveOperation(archive, notice.code) ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!mutable}
            onClick={() => setOperation({ ...archive, force: true })}
          >
            Review forced archive
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!feature.supported}
          onClick={() => setOperation(keep)}
        >
          Keep
        </Button>
      </div>
      {operation ? (
        <StaveConfirmDialog
          environmentId={environmentId}
          operation={operation}
          title={operation.action === "keep" ? "Keep space" : "Archive space"}
          onClose={() => setOperation(null)}
          onFinished={() => {}}
        />
      ) : null}
    </div>
  );
}
