import { useId, useState } from "react";
import type {
  ContextualDataJobReceipt,
  ContextualDataSelection,
  EnvironmentId,
} from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { DownloadIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { contextualEnvironment } from "../../state/contextual";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";

/** Mounted only for host administrators; raw archive queries start after an explicit search. */
export function ContextualArchive({ environmentId }: { environmentId: EnvironmentId }) {
  const id = useId();
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const sources = useEnvironmentQuery(
    contextualEnvironment.sources({
      environmentId,
      input: { ...(cursor ? { cursor } : {}), limit: 25 },
    }),
  );
  const [source, setSource] = useState<{ id: string; label: string } | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ query: string; sourceId: string } | null>(null);
  const inspect = useEnvironmentQuery(
    search
      ? contextualEnvironment.inspect({
          environmentId,
          input: { query: search.query, sourceIds: [search.sourceId], limit: 24 },
        })
      : null,
  );
  const capture = useEnvironmentQuery(
    contextualEnvironment.captureStatus({ environmentId, input: {} }),
  );
  const exportData = useAtomCommand(contextualEnvironment.export, { reportFailure: false });
  const forgetData = useAtomCommand(contextualEnvironment.forget, { reportFailure: false });
  const download = useAtomCommand(contextualEnvironment.downloadExport, { reportFailure: false });
  const [forget, setForget] = useState<{
    selection: ContextualDataSelection;
    label: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<ContextualDataJobReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function manage(operation: "export" | "forget", selection: ContextualDataSelection) {
    if (!capture.data || busy) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const input = {
        actionId: randomUUID(),
        selection,
        expectedSourceGeneration: inspect.data?.sourceGeneration ?? capture.data.sourceGeneration,
        expectedPurgeGeneration: inspect.data?.purgeGeneration ?? capture.data.purgeGeneration,
      };
      const result =
        operation === "export"
          ? await exportData({ environmentId, input })
          : await forgetData({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setReceipt(result.value);
      if (operation === "forget") {
        setForget(null);
        setSearch(null);
      }
      capture.refresh();
      sources.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `The archive could not ${operation} this selection.`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function saveExport(artifactId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await download({ environmentId, input: { artifactId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = URL.createObjectURL(new Blob([result.value], { type: "application/x-ndjson" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `lecturn-contextual-${artifactId}.ndjson`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The export could not be downloaded.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4 rounded-xl border border-border/60 p-3 text-xs">
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">Choose an archive source</legend>
        {sources.data?.sources.map((entry) => (
          <label
            key={entry.id}
            className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/40"
          >
            <input
              type="radio"
              name={`${id}-source`}
              value={entry.id}
              checked={source?.id === entry.id}
              onChange={() => {
                setSource({ id: entry.id, label: entry.label });
                setSearch(null);
                setForget(null);
                setReceipt(null);
              }}
              className="mt-0.5 accent-primary"
            />
            <span className="min-w-0 break-words">
              {entry.label}
              <span className="ml-1 text-muted-foreground">
                · {entry.sourceKind === "slack" ? "Slack" : "Saved Decisions"}
              </span>
            </span>
          </label>
        ))}
        {sources.data?.sources.length === 0 && (
          <p className="text-muted-foreground">No archive sources were discovered.</p>
        )}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={cursors.length <= 1 || sources.isPending}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous sources
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!sources.data?.nextCursor || sources.isPending}
            onClick={() => {
              if (sources.data?.nextCursor)
                setCursors((value) => [...value, sources.data!.nextCursor!]);
            }}
          >
            Next sources
          </Button>
        </div>
      </fieldset>
      {source && (
        <>
          <p className="break-words text-muted-foreground">
            Selected: <span className="font-medium text-foreground">{source.label}</span>
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch({ query: query.trim(), sourceId: source.id });
              setError(null);
              inspect.refresh();
            }}
          >
            <div className="min-w-0 flex-1">
              <label htmlFor={`${id}-query`} className="mb-1 block font-medium">
                Search stored exchanges
              </label>
              <input
                id={`${id}-query`}
                value={query}
                maxLength={1000}
                placeholder="Keyword, issue, or decision"
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <Button size="sm" variant="outline" type="submit" disabled={inspect.isPending}>
              <SearchIcon />
              Search archive
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !capture.data}
              onClick={() => void manage("export", { kind: "sources", sourceIds: [source.id] })}
            >
              <DownloadIcon />
              Export this source
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy || !capture.data}
              onClick={() =>
                setForget({
                  selection: { kind: "sources", sourceIds: [source.id] },
                  label: source.label,
                })
              }
            >
              <Trash2Icon />
              Forget this source…
            </Button>
          </div>
        </>
      )}
      {forget && (
        <div className="space-y-2 rounded-lg border border-destructive/30 p-3">
          <p className="break-words font-medium">Forget {forget.label}?</p>
          <p>
            Stored content and derived data will be purged and suppressed against recapture. Linked
            Decisions will not automatically resupply forgotten evidence; authoritative saved notes
            remain. Evidence already delivered to an agent cannot be retracted.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void manage("forget", forget.selection)}
            >
              {busy ? "Forgetting…" : "Forget stored data"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setForget(null)}>
              Keep data
            </Button>
          </div>
        </div>
      )}
      {receipt && (
        <div role="status" className="space-y-2 rounded-lg bg-muted/40 p-3">
          <p>
            {receipt.operation === "export" ? "Export" : "Forget request"} {receipt.state} ·{" "}
            {receipt.affectedRecords.toLocaleString()} records
          </p>
          {receipt.state === "completed" && receipt.artifactId && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void saveExport(receipt.artifactId!)}
            >
              <DownloadIcon />
              Download NDJSON
            </Button>
          )}
          {receipt.state === "accepted" || receipt.state === "running" ? (
            <p className="text-muted-foreground">
              The host is processing this request. This is not a completed export or deletion.
            </p>
          ) : null}
        </div>
      )}
      {inspect.isPending && <p role="status">Searching local archive…</p>}
      {search && inspect.data && !inspect.isPending && (
        <div className="space-y-3">
          <p className="text-muted-foreground">
            {inspect.data.candidates.length} exchanges returned, up to 24 per search. Narrow your
            search to inspect other records.
            {!inspect.data.coverage.complete || inspect.data.coverage.truncated
              ? " Results have partial coverage."
              : ""}
            {inspect.data.coverage.unexaminedCount > 0
              ? ` ${inspect.data.coverage.unexaminedCount} candidates were not examined.`
              : ""}
          </p>
          {inspect.data.candidates.length === 0 && <p>No stored exchanges matched this search.</p>}
          {inspect.data.candidates.map((candidate) => (
            <article
              key={candidate.id}
              className="space-y-2 rounded-lg border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {candidate.sourceKind === "slack" ? "Slack exchange" : "Saved Decision"}
                </Badge>
                {candidate.coverage.missingAntecedents && (
                  <span className="text-warning-foreground">Missing conversation context</span>
                )}
              </div>
              {candidate.evidence.map((evidence) => (
                <div key={evidence.id} className="space-y-1">
                  <p className="break-words text-muted-foreground">
                    {evidence.author} · {new Date(evidence.occurredAt).toLocaleString()}
                  </p>
                  <blockquote className="whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-3 text-sm">
                    {evidence.quote}
                  </blockquote>
                  <p className="text-muted-foreground">
                    Observed {new Date(evidence.observedAt).toLocaleString()} ·{" "}
                    {evidence.availability}
                  </p>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void manage("export", {
                      kind: "items",
                      sourceId: candidate.sourceId,
                      occurrenceIds: [candidate.occurrenceId],
                    })
                  }
                >
                  Export exchange
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setForget({
                      selection: {
                        kind: "items",
                        sourceId: candidate.sourceId,
                        occurrenceIds: [candidate.occurrenceId],
                      },
                      label: "this exchange",
                    })
                  }
                >
                  Forget exchange…
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {(error ?? sources.error ?? inspect.error ?? capture.error) && (
        <p role="alert" className="text-destructive">
          {error ?? sources.error ?? inspect.error ?? capture.error}
        </p>
      )}
    </div>
  );
}
