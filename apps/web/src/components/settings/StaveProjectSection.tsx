import { staveRpcErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentId, StaveProjectInfo, StaveSpaceStatus } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { useStaveFeatureAvailable, useStaveSpaceStatus } from "../../state/stave";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { formatStaveRepoStatus } from "./StaveProjectSection.logic";

/**
 * The `.stave.yaml` manifest the server attached to a project, enriched with
 * live drift and memory freshness from `stave.spaceStatus` when the feature
 * gate passes. Manifest rows always render; live columns appear only once
 * the probe answers, and a failed probe is reported inline rather than
 * replacing the view. Everything here is owned by Stave; edits go through
 * the CLI.
 */
export function StaveProjectSection({
  stave,
  environmentId,
  workspaceRoot,
}: {
  stave: StaveProjectInfo;
  environmentId: EnvironmentId;
  workspaceRoot: string;
}) {
  const { available } = useStaveFeatureAvailable(environmentId);
  const live = useStaveSpaceStatus({ environmentId, workspaceRoot, enabled: available });
  const kind = stave.isSaga || stave.kind === "saga" ? "saga" : (stave.kind ?? "space");
  const archived = stave.state === "archived";
  const liveRepoByName = new Map(live.data?.repos.map((repo) => [repo.name, repo]) ?? []);
  const liveMemoryByName = new Map(
    live.data?.memories.map((memory) => [memory.name, memory]) ?? [],
  );
  const showLive = available && live.data !== null;
  return (
    <SettingsSection
      title="Stave space"
      headerAction={available ? <LiveStatusAction live={live} /> : null}
    >
      {available && live.error !== null ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {staveRpcErrorMessage(live.error) ??
            (live.error instanceof Error ? live.error.message : "Live status unavailable.")}
        </p>
      ) : null}
      <SettingsRow title="Space id" control={<ManifestValue>{stave.spaceId}</ManifestValue>} />
      <SettingsRow title="Kind" control={<ManifestValue>{kind}</ManifestValue>} />
      <SettingsRow
        title="State"
        control={
          <span className="inline-flex items-center gap-2">
            <Badge variant={archived ? "warning" : "success"}>
              {archived ? "Archived" : "Live"}
            </Badge>
            {stave.archiveBasename ? <ManifestValue>{stave.archiveBasename}</ManifestValue> : null}
          </span>
        }
      />
      {stave.memberOf ? (
        <SettingsRow title="Member of" control={<ManifestValue>{stave.memberOf}</ManifestValue>} />
      ) : null}
      <SettingsRow
        title="Repos"
        description={
          stave.repos.length === 0
            ? "No repos are listed in this space's manifest."
            : "Repos checked out into this space and the mode Stave manages them in."
        }
      >
        {stave.repos.length > 0 ? (
          <ManifestTable
            header={
              showLive
                ? ["Name", "Mode", "Branch", "Base", "Ref", "Status"]
                : ["Name", "Mode", "Branch", "Base", "Ref"]
            }
            rows={stave.repos.map((repo) => {
              const cells: ManifestCell[] = [
                repo.name,
                repo.mode,
                repo.branch ?? null,
                repo.base ?? null,
                repo.ref ?? null,
              ];
              if (showLive) cells.push(repoStatusCell(liveRepoByName.get(repo.name)));
              return cells;
            })}
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Memories"
        description={
          stave.memories.length === 0
            ? "No memories are attached to this space."
            : "Memory stores this space owns or has attached."
        }
      >
        {stave.memories.length > 0 ? (
          <ManifestTable
            header={
              showLive
                ? ["Name", "Provider", "Ownership", "State"]
                : ["Name", "Provider", "Ownership"]
            }
            rows={stave.memories.map((memory) => {
              const cells: ManifestCell[] = [
                memory.name,
                memory.provider,
                memory.owned ? "owned" : "attached",
              ];
              if (showLive) cells.push(liveMemoryByName.get(memory.name)?.state ?? null);
              return cells;
            })}
          />
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function repoStatusCell(repo: StaveSpaceStatus["repos"][number] | undefined): ManifestCell {
  if (repo === undefined) return null;
  if (!repo.exists) return { text: "missing", tone: "warning" };
  return formatStaveRepoStatus(repo);
}

// Section header slot: pending text while the probe runs, otherwise a
// freshness caption and a manual re-probe.
function LiveStatusAction({ live }: { live: ReturnType<typeof useStaveSpaceStatus> }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {live.isPending ? "Checking…" : live.data !== null ? "Live status" : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={live.isPending}
              onClick={live.refresh}
              aria-label="Refresh live status"
            >
              <RefreshCwIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">Refresh live status</TooltipPopup>
      </Tooltip>
    </span>
  );
}

function ManifestValue({ children }: { children: string }) {
  return (
    <span className="max-w-[20rem] break-all font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}

type ManifestCell = string | null | { text: string; tone: "warning" };

function cellText(cell: ManifestCell): string | null {
  return typeof cell === "string" || cell === null ? cell : cell.text;
}

// Hand-rolled rows: a plain grid matches the surrounding SettingsRow rhythm
// without pulling in a table component for a handful of read-only values.
function ManifestTable({
  header,
  rows,
}: {
  header: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<ManifestCell>>;
}) {
  const columns = `repeat(${header.length}, minmax(0, 1fr))`;
  return (
    <div className="mb-2 mt-1 overflow-hidden rounded-lg border border-border/60 text-xs">
      <div
        className="grid gap-3 border-b border-border/60 bg-muted/40 px-3 py-1.5 font-medium text-muted-foreground"
        style={{ gridTemplateColumns: columns }}
      >
        {header.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div
          key={row.map((cell) => cellText(cell) ?? "").join(" ")}
          className="grid gap-3 px-3 py-1.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/40"
          style={{ gridTemplateColumns: columns }}
        >
          {row.map((cell, cellIndex) => (
            <span
              key={header[cellIndex]}
              className={
                cell === null
                  ? "text-muted-foreground/60"
                  : typeof cell === "string"
                    ? "break-all font-mono text-foreground"
                    : "break-all font-mono text-warning-foreground"
              }
            >
              {cellText(cell) ?? "—"}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
