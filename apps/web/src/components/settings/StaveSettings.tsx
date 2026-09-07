import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
import { useStaveStatus } from "../../state/stave";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { STAVE_SETUP_COMMAND, summarizeStaveStatus } from "./StaveSettings.logic";

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
      <StaveStatusRow />
      <StaveBinaryPathSetting />
      <StaveConfigPathSetting />
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
  // Phase 3 replaces the clipboard hand-off with a real `stave.setup` call.
  const { copyToClipboard } = useCopyToClipboard({
    target: "setup command",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: `Copied \`${STAVE_SETUP_COMMAND}\` — run it in a terminal`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy setup command",
        description: error.message,
      });
    },
  });

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
              onClick={() => copyToClipboard(STAVE_SETUP_COMMAND)}
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
    />
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
