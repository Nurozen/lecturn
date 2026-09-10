import { useEffect, useState } from "react";
import type {
  EnvironmentId,
  StaveLifecycleActionOperation,
  StavePendingCleanup,
} from "@t3tools/contracts";
import { usePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useStaveFeatureAvailable } from "../../state/stave";
import { subscribeStaveMutation } from "../../staveMutation";
import { Button } from "../ui/button";
import { StaveConfirmDialog } from "../stave/StaveConfirmDialog";
import { canForceStaveOperation } from "../stave/staveConfirm.logic";
import { lifecycleOperation } from "../stave/staveLifecycle.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function StavePendingCleanups() {
  const environmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const { status, available, supported } = useStaveFeatureAvailable(environmentId);
  const [confirmation, setConfirmation] = useState<{
    environmentId: EnvironmentId;
    operation: StaveLifecycleActionOperation;
  } | null>(null);
  const refresh = status.refresh;
  useEffect(() => {
    if (environmentId === null) return;
    refresh();
    const timer = setInterval(refresh, 15_000);
    const unsubscribe = subscribeStaveMutation((changed) => {
      if (changed === environmentId) refresh();
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [environmentId, refresh]);
  const choose = (
    row: StavePendingCleanup,
    action: StaveLifecycleActionOperation["action"],
    force = false,
  ) => {
    if (environmentId === null) return;
    const operation = lifecycleOperation({
      projectId: row.projectId,
      workspaceRoot: row.workspaceRoot,
      createdAt: row.manifestCreatedAt,
      action,
      force,
      policy: settings.stave.lifecycle,
    });
    if (operation) setConfirmation({ environmentId, operation });
  };
  return (
    <SettingsRow
      {...searchableSetting("stave-pending-cleanups")}
      description="Cleanup remaining after projects were removed. Refusals survive a server restart; retries require your review."
    >
      <div className="space-y-3 pb-3">
        {status.error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Pending cleanups could not be refreshed.{" "}
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh
            </Button>
          </p>
        ) : null}
        {status.data?.pendingCleanups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No pending cleanups.</p>
        ) : null}
        {status.data?.pendingCleanups.map((row) => {
          const retry = lifecycleOperation({
            projectId: row.projectId,
            workspaceRoot: row.workspaceRoot,
            createdAt: row.manifestCreatedAt,
            action: "retry",
            policy: settings.stave.lifecycle,
          });
          return (
            <div
              key={`${environmentId}:${row.projectId}:${row.workspaceRoot}:${row.manifestCreatedAt}`}
              className="space-y-2 rounded-lg border p-3 text-sm"
            >
              <p className="font-medium">{row.spaceId ?? "Unidentified space"}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {row.workspaceRoot}
              </p>
              <p>{row.refusalMessage ?? row.refusalCode ?? row.disposition.replaceAll("_", " ")}</p>
              {!row.manifestCreatedAt ? (
                <p className="text-xs text-muted-foreground">
                  No recorded creation stamp. Repair the manifest and cleanup record before
                  retrying. You can dismiss this record and leave its files in place.
                </p>
              ) : null}
              {settings.stave.lifecycle.onProjectDelete === "keep" ? (
                <p className="text-xs text-muted-foreground">
                  The current deletion policy keeps spaces. Dismiss this record to leave the files
                  in place.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!available || retry === null}
                  onClick={() => choose(row, "retry")}
                >
                  {row.refusalCode === "saga_member" && retry?.target === "destroy"
                    ? "Review removal from saga and destroy"
                    : "Retry cleanup"}
                </Button>
                {retry && canForceStaveOperation(retry, row.refusalCode ?? undefined) ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={!available}
                    onClick={() => choose(row, "retry", true)}
                  >
                    Review forced cleanup
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!supported}
                  onClick={() => choose(row, "dismiss")}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {confirmation ? (
        <StaveConfirmDialog
          key={`${confirmation.environmentId}:${JSON.stringify(confirmation.operation)}`}
          environmentId={confirmation.environmentId}
          operation={confirmation.operation}
          title={confirmation.operation.action === "dismiss" ? "Dismiss cleanup" : "Retry cleanup"}
          onClose={() => setConfirmation(null)}
          onFinished={() => {}}
        />
      ) : null}
    </SettingsRow>
  );
}
