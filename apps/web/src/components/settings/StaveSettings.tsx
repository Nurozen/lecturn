import { StaveLifecycleSettings } from "./StaveLifecycleSettings";
import { StavePendingCleanups } from "./StavePendingCleanups";
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_UNIFIED_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useEffect, useState } from "react";
import { staveOperations } from "../../state/staveOperations";
import { useAtomCommand } from "../../state/use-atom-command";
import { StaveOperationProgress } from "../stave/StaveOperationProgress";
import {
  useClientSettings,
  useUpdateClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { cn, randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
import { useStaveStatus, staveStatus } from "../../state/stave";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { summarizeStaveStatus } from "./StaveSettings.logic";

/**
 * Stave block of Settings → General. Only server builds that advertise
 * `capabilities.stave` render it, so an older server never shows rows whose
 * settings it would ignore.
 */
export function StaveSettingsSection() {
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  if (primaryServerConfig?.environment.capabilities.stave === undefined) return null;
  return (
    <SettingsSection title="Stave">
      <StaveEnabledSetting />
      <StaveLifecycleSettings />
      <StaveStatusRow />
      <StaveBinaryPathSetting />
      <StaveConfigPathSetting />
      <StaveSagaNestingSetting />
      <StavePendingCleanups />
    </SettingsSection>
  );
}

function StaveEnabledSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("stave-enabled")}
      description="Create and manage Stave spaces from Lecturn. Spaces group repo worktrees and memories under one project."
      resetAction={
        settings.stave.enabled !== DEFAULT_UNIFIED_SETTINGS.stave.enabled ? (
          <SettingResetButton
            label="Stave"
            onClick={() =>
              updateSettings({ stave: { enabled: DEFAULT_UNIFIED_SETTINGS.stave.enabled } })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.stave.enabled}
          onCheckedChange={(checked) => updateSettings({ stave: { enabled: Boolean(checked) } })}
          aria-label="Enable Stave"
        />
      }
    />
  );
}

function StaveStatusRow() {
  const environmentId = usePrimaryEnvironmentId();
  const status = useStaveStatus(environmentId);
  const summary = summarizeStaveStatus({
    status: status.data,
    error: status.error,
    isPending: status.isPending,
  });
  const settings = usePrimarySettings();
  const run = useAtomCommand(staveOperations.run, { reportFailure: false });
  const [setupId, setSetupId] = useState(randomUUID);
  const [setupStarted, setSetupStarted] = useState(false);
  const [setupEnvironmentId, setSetupEnvironmentId] = useState<EnvironmentId | null>(null);
  const operation = useAtomValue(staveOperations.stateAtom(setupId));
  const setupBusy =
    setupStarted &&
    (operation.status === "idle" ||
      operation.status === "running" ||
      operation.status === "disconnected");
  useEffect(() => {
    if (operation.status === "finished" && setupEnvironmentId !== null) {
      appAtomRegistry.refresh(staveStatus({ environmentId: setupEnvironmentId, input: {} }));
    }
  }, [operation.status, setupEnvironmentId]);

  return (
    <SettingsRow
      {...searchableSetting("stave-status")}
      description="The Stave binary and config the server would use."
      status={
        summary.detail ? (
          <span className={cn("break-all", summary.detailIsPath && "font-mono")}>
            {summary.detail}
          </span>
        ) : undefined
      }
      control={
        <>
          <span className="text-xs text-muted-foreground">{summary.text}</span>
          {summary.needsSetup ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!settings.stave.enabled || setupBusy || environmentId === null}
              title={!settings.stave.enabled ? "Enable Stave before setting it up." : undefined}
              onClick={() => {
                if (environmentId === null) return;
                const operationId = randomUUID();
                setSetupId(operationId);
                setSetupEnvironmentId(environmentId);
                setSetupStarted(true);
                void run({
                  environmentId,
                  operationId,
                  operation: { kind: "setup", force: false },
                });
              }}
            >
              Set up
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={status.isPending}
                  onClick={status.refresh}
                  aria-label="Refresh Stave status"
                >
                  <RefreshCwIcon className={cn(status.isPending && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh Stave status</TooltipPopup>
          </Tooltip>
        </>
      }
    >
      {setupStarted && setupEnvironmentId !== null ? (
        <div className="pb-3">
          <StaveOperationProgress environmentId={setupEnvironmentId} operationId={setupId} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function StaveBinaryPathSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("stave-binary-path")}
      description="Leave empty to auto-detect. Resolution order: this path, then T3CODE_STAVE_PATH, then the desktop bundle, then the binary bundled with the server, then `stave` on PATH."
      resetAction={
        settings.stave.binaryPath !== DEFAULT_UNIFIED_SETTINGS.stave.binaryPath ? (
          <SettingResetButton
            label="Stave binary path"
            onClick={() =>
              updateSettings({ stave: { binaryPath: DEFAULT_UNIFIED_SETTINGS.stave.binaryPath } })
            }
          />
        ) : null
      }
      control={
        <DraftInput
          size="sm"
          className="w-full sm:w-72"
          value={settings.stave.binaryPath}
          onCommit={(next) => updateSettings({ stave: { binaryPath: next } })}
          placeholder="Auto-detect"
          spellCheck={false}
          aria-label="Stave binary path"
        />
      }
    />
  );
}

function StaveConfigPathSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("stave-config-path")}
      description="Leave empty to use Stave's default, ~/.config/stave/config.yaml."
      resetAction={
        settings.stave.configPath !== DEFAULT_UNIFIED_SETTINGS.stave.configPath ? (
          <SettingResetButton
            label="Stave config path"
            onClick={() =>
              updateSettings({ stave: { configPath: DEFAULT_UNIFIED_SETTINGS.stave.configPath } })
            }
          />
        ) : null
      }
      control={
        <DraftInput
          size="sm"
          className="w-full sm:w-72"
          value={settings.stave.configPath}
          onCommit={(next) => updateSettings({ stave: { configPath: next } })}
          placeholder="~/.config/stave/config.yaml"
          spellCheck={false}
          aria-label="Stave config path"
        />
      }
    />
  );
}

function StaveSagaNestingSetting() {
  const enabled = useClientSettings((settings) => settings.sidebarNestSagas);
  const update = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("stave-nest-sagas")}
      description="Group member projects under their saga in dependency order in this client's sidebars."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => update({ sidebarNestSagas: checked })}
          aria-label="Nest saga members"
        />
      }
    />
  );
}
