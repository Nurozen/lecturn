import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function StaveLifecycleSettings() {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const policy = settings.stave.lifecycle;
  const defaults = DEFAULT_UNIFIED_SETTINGS.stave.lifecycle;
  if (!settings.stave.enabled) return null;
  return (
    <div className="ml-3 border-l pl-3">
      <SettingsRow
        serverScoped
        {...searchableSetting("stave-on-project-delete")}
        description="What happens to the space on disk when you remove its project from Lecturn."
        resetAction={
          policy.onProjectDelete !== defaults.onProjectDelete ? (
            <SettingResetButton
              label="On project deletion"
              onClick={() =>
                update({ stave: { lifecycle: { onProjectDelete: defaults.onProjectDelete } } })
              }
            />
          ) : null
        }
        control={
          <Select
            value={policy.onProjectDelete}
            onValueChange={(value) => {
              if (value === "destroy" || value === "archive" || value === "keep")
                update({ stave: { lifecycle: { onProjectDelete: value } } });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="destroy">Destroy space</SelectItem>
              <SelectItem value="archive">Archive space</SelectItem>
              <SelectItem value="keep">Keep space</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("stave-on-all-threads-settled")}
        description="Only applies when the project has threads and every thread is settled, archived, or deleted."
        resetAction={
          policy.onAllThreadsSettled !== defaults.onAllThreadsSettled ? (
            <SettingResetButton
              label="On all threads settled"
              onClick={() =>
                update({
                  stave: { lifecycle: { onAllThreadsSettled: defaults.onAllThreadsSettled } },
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={policy.onAllThreadsSettled}
            onValueChange={(value) => {
              if (
                value === "archive-after-grace" ||
                value === "archive" ||
                value === "suggest" ||
                value === "nothing"
              )
                update({ stave: { lifecycle: { onAllThreadsSettled: value } } });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="archive-after-grace">Archive after grace period</SelectItem>
              <SelectItem value="archive">Archive immediately</SelectItem>
              <SelectItem value="suggest">Suggest archiving</SelectItem>
              <SelectItem value="nothing">Do nothing</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {policy.onAllThreadsSettled === "archive-after-grace" ? (
        <SettingsRow
          serverScoped
          {...searchableSetting("stave-archive-grace-days")}
          description="Days to wait before automatic archiving. Starting work again cancels the countdown."
          resetAction={
            policy.archiveGraceDays !== defaults.archiveGraceDays ? (
              <SettingResetButton
                label="Archive grace days"
                onClick={() =>
                  update({ stave: { lifecycle: { archiveGraceDays: defaults.archiveGraceDays } } })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-24"
              type="number"
              min={0}
              step={1}
              value={String(policy.archiveGraceDays)}
              aria-label="Archive grace days"
              onCommit={(value) => {
                const days = Number(value);
                if (value.trim() && Number.isSafeInteger(days) && days >= 0)
                  update({ stave: { lifecycle: { archiveGraceDays: days } } });
              }}
            />
          }
        />
      ) : null}
      {policy.onProjectDelete === "destroy" ? (
        <SettingsRow
          serverScoped
          {...searchableSetting("stave-memory-fate-on-destroy")}
          description="Destroy permanently removes owned memory stores. Stores owned elsewhere are kept."
          resetAction={
            policy.memoryFateOnDestroy !== defaults.memoryFateOnDestroy ? (
              <SettingResetButton
                label="Memory on destroy"
                onClick={() =>
                  update({
                    stave: { lifecycle: { memoryFateOnDestroy: defaults.memoryFateOnDestroy } },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={policy.memoryFateOnDestroy}
              onValueChange={(value) => {
                if (value === "keep" || value === "contribute" || value === "destroy")
                  update({ stave: { lifecycle: { memoryFateOnDestroy: value } } });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="keep">Keep</SelectItem>
                <SelectItem value="contribute">Contribute and keep</SelectItem>
                <SelectItem value="destroy">Destroy owned memory</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <SettingsRow
        serverScoped
        {...searchableSetting("stave-settle-on-saga-merge")}
        description="Settle member threads when every pull request in the saga is merged. This is independent of inactivity-based settlement."
        resetAction={
          policy.settleOnSagaMerge !== defaults.settleOnSagaMerge ? (
            <SettingResetButton
              label="Settle on saga merge"
              onClick={() =>
                update({ stave: { lifecycle: { settleOnSagaMerge: defaults.settleOnSagaMerge } } })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={policy.settleOnSagaMerge}
            aria-label="Settle threads on saga merge"
            onCheckedChange={(value) =>
              update({ stave: { lifecycle: { settleOnSagaMerge: value } } })
            }
          />
        }
      />
    </div>
  );
}
