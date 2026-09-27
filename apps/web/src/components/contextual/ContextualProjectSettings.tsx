import { useState } from "react";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import {
  contextualEnvironment,
  contextualErrorMessage,
  useContextualAccess,
  useContextualAvailable,
} from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
export function ContextualProjectSettings({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const available = useContextualAvailable(environmentId);
  const access = useContextualAccess(environmentId);
  const query = useEnvironmentQuery(
    available
      ? contextualEnvironment.projectSettings({ environmentId, input: { projectId } })
      : null,
  );
  const [sourceCursor, setSourceCursor] = useState<string | undefined>();
  const sources = useEnvironmentQuery(
    available && access.administer
      ? contextualEnvironment.sources({
          environmentId,
          input: { limit: 50, ...(sourceCursor ? { cursor: sourceCursor } : {}) },
        })
      : null,
  );
  const save = useAtomCommand(contextualEnvironment.updateProjectSettings, {
    reportFailure: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = query.data;
  async function update(defaultEnabled: boolean, sourceIds: readonly string[]) {
    if (!settings || !access.operate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await save({
        environmentId,
        input: { projectId, expectedRevision: settings.revision, defaultEnabled, sourceIds },
      });
      if (result._tag === "Failure")
        setError(contextualErrorMessage(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  }
  if (!available) return null;
  return (
    <SettingsSection title="Contextual">
      <SettingsRow
        title="Default for new threads"
        description="Copies this setting to new threads. Existing threads keep their own setting."
        control={
          <Switch
            aria-label="Contextual default for new threads"
            checked={settings?.defaultEnabled ?? false}
            disabled={!settings || !access.operate || busy}
            onCheckedChange={(value) => void update(value, settings?.sourceIds ?? [])}
          />
        }
      />
      {settings ? (
        <div className="space-y-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.sourceIds.includes(`decisions:${projectId}`)}
              disabled={!access.operate || busy}
              onChange={(event) =>
                void update(
                  settings.defaultEnabled,
                  event.target.checked
                    ? [...settings.sourceIds, `decisions:${projectId}`]
                    : settings.sourceIds.filter((id) => id !== `decisions:${projectId}`),
                )
              }
            />
            Saved Decisions from this project
          </label>
          {sources.data?.sources
            .filter((source) => source.selected && source.sourceKind === "slack")
            .map((source) => (
              <label key={source.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.sourceIds.includes(source.id)}
                  disabled={
                    !access.operate ||
                    busy ||
                    (!settings.sourceIds.includes(source.id) && settings.sourceIds.length >= 256)
                  }
                  onChange={(event) =>
                    void update(
                      settings.defaultEnabled,
                      event.target.checked
                        ? [...settings.sourceIds, source.id]
                        : settings.sourceIds.filter((id) => id !== source.id),
                    )
                  }
                />
                <span>
                  {source.label} · {source.hostName}
                </span>
              </label>
            ))}
          {access.administer ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={!sourceCursor}
                onClick={() => setSourceCursor(undefined)}
              >
                First source page
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={!sources.data?.nextCursor}
                onClick={() => setSourceCursor(sources.data?.nextCursor ?? undefined)}
              >
                More permitted sources
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {settings ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Project sources limit what threads can use. Host administrators manage the available
            source list.
          </p>
          {settings.sourceIds.length ? (
            settings.sourceIds.map((sourceId) => (
              <div
                key={sourceId}
                className="flex items-center justify-between gap-3 rounded-lg border p-2"
              >
                <span className="break-all">
                  {sourceId === `decisions:${projectId}`
                    ? "Saved Decisions"
                    : (sources.data?.sources.find((source) => source.id === sourceId)?.label ??
                      sourceId)}
                </span>
                {access.operate ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void update(
                        settings.defaultEnabled,
                        settings.sourceIds.filter((id) => id !== sourceId),
                      )
                    }
                  >
                    Remove from project
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p>No sources selected for this project.</p>
          )}
        </div>
      ) : null}
      {!access.operate ? (
        <p className="text-xs text-muted-foreground">
          Your connection can view these settings. Changing them requires thread operation access.
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
