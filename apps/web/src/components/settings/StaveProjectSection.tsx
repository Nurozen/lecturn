import type { StaveProjectInfo } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Read-only view of the `.stave.yaml` manifest the server attached to a
// project. Everything here is owned by Stave; edits go through the CLI.
export function StaveProjectSection({ stave }: { stave: StaveProjectInfo }) {
  const kind = stave.isSaga || stave.kind === "saga" ? "saga" : (stave.kind ?? "space");
  const archived = stave.state === "archived";
  return (
    <SettingsSection title="Stave space">
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
            header={["Name", "Mode", "Branch", "Base", "Ref"]}
            rows={stave.repos.map((repo) => [
              repo.name,
              repo.mode,
              repo.branch ?? null,
              repo.base ?? null,
              repo.ref ?? null,
            ])}
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
            header={["Name", "Provider", "Ownership"]}
            rows={stave.memories.map((memory) => [
              memory.name,
              memory.provider,
              memory.owned ? "owned" : "attached",
            ])}
          />
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function ManifestValue({ children }: { children: string }) {
  return (
    <span className="max-w-[20rem] break-all font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}

// Hand-rolled rows: a plain grid matches the surrounding SettingsRow rhythm
// without pulling in a table component for a handful of read-only values.
function ManifestTable({
  header,
  rows,
}: {
  header: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
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
          key={row.map((cell) => cell ?? "").join("\u0000")}
          className="grid gap-3 px-3 py-1.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border/40"
          style={{ gridTemplateColumns: columns }}
        >
          {row.map((cell, cellIndex) => (
            <span
              key={header[cellIndex]}
              className={
                cell === null ? "text-muted-foreground/60" : "break-all font-mono text-foreground"
              }
            >
              {cell ?? "—"}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
