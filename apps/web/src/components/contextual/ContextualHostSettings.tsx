import { useState } from "react";
import type { ContextualSource, ContextualSourcePolicy, EnvironmentId } from "@lecturn/contracts";
import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import {
  ArchiveIcon,
  DatabaseIcon,
  LaptopIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
} from "lucide-react";
import {
  contextualEnvironment,
  useContextualAccess,
  useContextualAvailable,
} from "../../state/contextual";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { ExtensionsFunding } from "../ExtensionsFunding";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { contextualCollectionPresentation } from "@lecturn/client-runtime/state/contextual";
import { updateSourceSelection } from "./ContextualHostSettings.logic";
import { ContextualArchive } from "./ContextualArchive";

export function ContextualHostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const available = useContextualAvailable(environmentId);
  return available ? (
    <HostSettings key={environmentId} environmentId={environmentId} />
  ) : (
    <p className="p-4 text-sm text-muted-foreground">Update this host to configure Contextual.</p>
  );
}
function HostSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const access = useContextualAccess(environmentId);
  const host = useEnvironment(environmentId)?.label ?? "this host";
  const capture = useEnvironmentQuery(
    contextualEnvironment.captureStatus({ environmentId, input: {} }),
  );
  const funding = useEnvironmentQuery(
    contextualEnvironment.fundingStatus({ environmentId, input: { featureId: "contextual" } }),
  );
  const setCapture = useAtomCommand(contextualEnvironment.setCapture, { reportFailure: false });
  const [discover, setDiscover] = useState(false);
  const [archive, setArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function changeCollection() {
    if (!capture.data || !access.administer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setCapture({
        environmentId,
        input: {
          state: capture.data.state === "running" ? "paused" : "running",
          expectedGeneration: capture.data.generation,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      capture.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Collection could not be changed.");
    } finally {
      setBusy(false);
    }
  }
  const collection = contextualCollectionPresentation({
    capture: capture.data,
    funding: funding.data,
    captureFailed: Boolean(capture.error),
    fundingFailed: Boolean(funding.error),
  });
  return (
    <div className="space-y-5 text-sm">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <LaptopIcon className="size-4" />
          Collection host
        </div>
        <h2 className="break-words text-lg font-semibold">Contextual on {host}</h2>
        <p className="text-sm text-muted-foreground">
          Bring useful exchanges from selected Slack desktop caches and saved Decisions into a
          thread’s next turn.
        </p>
      </header>
      <section
        className="rounded-xl border border-border/60 bg-card/50 p-4"
        aria-label="Contextual collection"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 font-medium">
            <DatabaseIcon className="size-4 text-primary" />
            Local collection
          </h3>
          <Badge variant={capture.data?.state === "running" ? "success" : "outline"}>
            {capture.data?.state === "running"
              ? "Running"
              : capture.data?.state === "paused"
                ? "Paused"
                : capture.data
                  ? "Unavailable"
                  : "Checking"}
          </Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{collection.message}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Pausing stops new intake. Existing permitted archive and saved Decisions can still be
          retrieved by enabled threads. Turning a thread off does not pause collection.
        </p>
        {capture.data && (
          <p className="mt-3 text-xs tabular-nums">
            {capture.data.capturedRecords.toLocaleString()} cached records ·{" "}
            {capture.data.coverage === "complete-for-observed-cache"
              ? "Observed cache only"
              : capture.data.coverage === "partial"
                ? "Partial coverage"
                : "Coverage unknown"}
          </p>
        )}
        {access.administer ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy || !capture.data || (capture.data.state !== "running" && !collection.canStart)
              }
              onClick={() => void changeCollection()}
            >
              {capture.data?.state === "running" ? <PauseIcon /> : <PlayIcon />}
              {busy
                ? "Updating…"
                : capture.data?.state === "running"
                  ? "Pause collection"
                  : "Start collection"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                capture.refresh();
                funding.refresh();
              }}
            >
              Refresh status
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Source selection, collection, and raw archive access require host administration
            permission.
          </p>
        )}
        {(error ?? capture.error) && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error ?? capture.error}
          </p>
        )}
      </section>
      {access.administer && (
        <section className="space-y-3" aria-label="Contextual sources">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Sources on {host}</h3>
            <Button size="sm" variant="outline" onClick={() => setDiscover((value) => !value)}>
              <SearchIcon />
              {discover ? "Hide source selection" : "Discover sources"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Discovery previews metadata only. Select individual conversations before starting
            collection. Existing cached records may include older messages; this does not fetch
            Slack history.
          </p>
          <p className="rounded-lg bg-warning/8 px-3 py-2 text-xs text-warning-foreground">
            People who can operate {host} can see evidence attached to its threads. Select only
            conversations you want to share with this host’s users.
          </p>
          {discover && <SourceSelection environmentId={environmentId} />}
        </section>
      )}
      <ExtensionsFunding
        environmentId={environmentId}
        featureId="contextual"
        onChange={() => {
          funding.refresh();
          capture.refresh();
        }}
      />
      {access.administer && (
        <section
          className="space-y-3 border-t border-border/60 pt-4"
          aria-label="Contextual archive"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-medium">
              <ArchiveIcon className="size-4 text-primary" />
              Local archive
            </h3>
            <Button size="sm" variant="outline" onClick={() => setArchive((value) => !value)}>
              {archive ? "Close archive" : "Inspect, export, or forget"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Data management remains available without paid access. Forgetting prevents recapture,
            but cannot retract evidence already sent to an agent.
          </p>
          {archive && <ContextualArchive environmentId={environmentId} />}
        </section>
      )}
    </div>
  );
}
function SourceSelection({ environmentId }: { environmentId: EnvironmentId }) {
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const sources = useEnvironmentQuery(
    contextualEnvironment.sources({
      environmentId,
      input: { ...(cursor ? { cursor } : {}), limit: 25 },
    }),
  );
  const configure = useAtomCommand(contextualEnvironment.configureSources, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ContextualSourcePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const policy = draft ?? sources.data?.policy;
  const stale =
    draft !== null && sources.data !== null && draft.revision !== sources.data.policy.revision;
  async function save() {
    if (!draft || stale || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await configure({
        environmentId,
        input: {
          expectedRevision: draft.revision,
          policy: { ...draft, revision: draft.revision + 1 },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setDraft(null);
      setSaved(true);
      sources.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Source selection could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const groups = new Map<string, ContextualSource[]>();
  for (const source of sources.data?.sources ?? []) {
    const key = source.workspaceId ?? "saved-decisions";
    const items = groups.get(key) ?? [];
    items.push(source);
    groups.set(key, items);
  }
  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-3">
      <p className="text-xs text-muted-foreground">
        Direct and group messages require individual selection. New conversations stay unselected.
        Drafts and unclassified conversations are always excluded.
      </p>
      {sources.isPending && !sources.data && (
        <p role="status" className="text-xs">
          Discovering sources…
        </p>
      )}
      {sources.data?.sources.length === 0 && (
        <p className="text-xs">
          No sources found on this host. Slack collection requires a supported local desktop cache.
          Saved Decisions are available independently.
        </p>
      )}
      {[...groups].map(([workspace, items]) => (
        <fieldset key={workspace} className="space-y-1">
          <legend className="mb-1 break-all text-xs font-medium text-muted-foreground">
            {workspace === "saved-decisions" ? "Lecturn Decisions" : `Workspace ${workspace}`}
          </legend>
          {items.map((source) => (
            <label
              key={source.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-muted/40"
            >
              <Checkbox
                checked={policy?.allowedSourceIds.includes(source.id) ?? source.selected}
                disabled={
                  busy ||
                  !policy ||
                  (source.conversationType === "unknown" &&
                    !policy.allowedSourceIds.includes(source.id)) ||
                  (!source.available && !policy.allowedSourceIds.includes(source.id)) ||
                  (policy.allowedSourceIds.length >= 256 &&
                    !policy.allowedSourceIds.includes(source.id))
                }
                onCheckedChange={(selected) => {
                  if (policy) {
                    setDraft(updateSourceSelection(policy, source, selected));
                    setSaved(false);
                  }
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm">{source.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {source.conversationType === "dm"
                    ? "Direct message · explicit opt-in"
                    : source.conversationType === "group-dm"
                      ? "Group direct message · explicit opt-in"
                      : source.conversationType === "private-channel"
                        ? "Private channel"
                        : source.conversationType === "unknown"
                          ? "Unclassified · excluded"
                          : source.sourceKind === "lecturn-decision"
                            ? "Saved Decisions · independent of Slack"
                            : "Channel"}
                  {!source.available ? " · unavailable" : ""}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {policy?.allowedSourceIds.length ?? 0} selected across all pages · up to 256
        </p>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={cursors.length <= 1 || sources.isPending}
            onClick={() => setCursors((value) => value.slice(0, -1))}
          >
            Previous
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
            Next
          </Button>
        </div>
      </div>
      {stale && (
        <p role="alert" className="text-xs text-warning-foreground">
          Another administrator changed these sources. Discard your draft and review the current
          selection before saving.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!draft || stale || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save source selection"}
        </Button>
        {draft && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              sources.refresh();
            }}
          >
            Discard changes
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => sources.refresh()}>
          Refresh discovery
        </Button>
      </div>
      {saved && (
        <p role="status" className="text-xs text-success-foreground">
          Source selection saved. Collection starts only when you enable it.
        </p>
      )}
      {(error ?? sources.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? sources.error}
        </p>
      )}
    </div>
  );
}
