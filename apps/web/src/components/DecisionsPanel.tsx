import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { downloadTextFile } from "../lib/downloadTextFile";
import type {
  DecisionEvidence,
  DecisionRelationship,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadDecision,
  ThreadDecisionListInput,
  ThreadDecisionMutateInput,
  ThreadDecisionScanResult,
  ThreadDecisionExportResult,
} from "@lecturn/contracts";
import {
  assembleDecisionJsonExport,
  decisionToMarkdown,
} from "@lecturn/client-runtime/state/threadDecisions";
import {
  executeAtomQuery,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@lecturn/client-runtime/state/runtime";
import { threadDecisionEnvironment, useDecisionOperateAccess } from "../state/threadDecisions";
import { useEnvironmentQuery } from "../state/query";
import { useServerConfigs } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "./ui/dialog";
import { DecisionSourceDialog } from "./DecisionSourceDialog";
import { DecisionsFunding } from "./DecisionsFunding";
import { DecisionEditor } from "./DecisionEditor";
import {
  decisionFilterKey,
  decisionRelationshipLabel,
  decisionStatusLabel,
  reconcileVisibleDecisions,
} from "./DecisionsPanel.logic";

const EMPTY: readonly ThreadDecision[] = [];
const inputClass = "rounded-md border border-border bg-background px-2 py-1.5 text-sm";
export function DecisionsPanel({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId?: ThreadId;
}) {
  const available =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadDecisions === true;
  if (!available)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Decisions are unavailable on this environment.
      </p>
    );
  return (
    <AvailableDecisionsPanel
      key={`${environmentId}:${projectId}:${threadId ?? "project"}`}
      environmentId={environmentId}
      projectId={projectId}
      {...(threadId ? { threadId } : {})}
    />
  );
}
function AvailableDecisionsPanel({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId?: ThreadId;
}) {
  const canOperate = useDecisionOperateAccess(environmentId);
  const [search, setSearch] = useState(""),
    [review, setReview] = useState<"active" | "all" | "unreviewed" | "confirmed" | "dismissed">(
      "active",
    ),
    [lifecycle, setLifecycle] = useState<"current" | "superseded" | "all">("current");
  const [cursor, setCursor] = useState<string | undefined>(),
    [history, setHistory] = useState<(string | undefined)[]>([]);
  const input = useMemo<ThreadDecisionListInput>(
    () => ({
      projectId,
      ...(threadId ? { threadId } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(review === "active" ? {} : { reviewState: review }),
      lifecycle,
      ...(cursor ? { cursor } : {}),
    }),
    [projectId, threadId, search, review, lifecycle, cursor],
  );
  const list = useEnvironmentQuery(threadDecisionEnvironment.list({ environmentId, input }));
  const status = useEnvironmentQuery(
    threadDecisionEnvironment.status({
      environmentId,
      input: { projectId, ...(threadId ? { threadId } : {}) },
    }),
  );
  const [view, setView] = useState<{ visible: readonly ThreadDecision[]; newCount: number }>({
    visible: EMPTY,
    newCount: 0,
  });
  const { visible, newCount } = view;
  const shownKey = useRef(""),
    seenInitial = useRef(false);
  const filterKey = decisionFilterKey(input);
  useEffect(() => {
    if (!list.data) return;
    if (shownKey.current !== filterKey || !seenInitial.current) {
      shownKey.current = filterKey;
      seenInitial.current = true;
      setView({ visible: list.data.decisions, newCount: 0 });
      return;
    }
    setView((previous) => reconcileVisibleDecisions(previous.visible, list.data!.decisions));
  }, [list.data, filterKey]);
  const [relationshipReview, setRelationshipReview] = useState<{
    action: "accept-replacement" | "reject-replacement" | "undo-replacement";
    relation: DecisionRelationship;
    before: ThreadDecision;
    after: ThreadDecision;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false),
    [description, setDescription] = useState("");
  const [editing, setEditing] = useState<{ note: ThreadDecision; mode: "edit" | "comment" } | null>(
    null,
  );
  const [source, setSource] = useState<{ note: ThreadDecision; evidence: DecisionEvidence } | null>(
    null,
  );
  const [scanOpen, setScanOpen] = useState(false);
  const [deleting, setDeleting] = useState<ThreadDecision | "project" | null>(null),
    [scan, setScan] = useState<ThreadDecisionScanResult | null>(null);
  const mutateCommand = useAtomCommand(threadDecisionEnvironment.mutate, { reportFailure: false });
  const settingsCommand = useAtomCommand(threadDecisionEnvironment.settings, {
    reportFailure: false,
  });
  const scanCommand = useAtomCommand(threadDecisionEnvironment.scan, { reportFailure: false });
  const exportCommand = useAtomCommand(threadDecisionEnvironment.export, { reportFailure: false });
  const navigate = useNavigate();
  async function perform<A, E>(execute: () => Promise<AtomCommandResult<A, E>>): Promise<A | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await execute();
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(
          cause instanceof Error ? cause.message : "The request failed. Refresh and try again.",
        );
        return null;
      }
      return result.value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function mutate(input: ThreadDecisionMutateInput) {
    const result = await perform(() => mutateCommand({ environmentId, input }));
    return result !== null;
  }
  function setFilters(change: () => void) {
    change();
    setCursor(undefined);
    setHistory([]);
  }
  async function relationship(
    action: "accept-replacement" | "reject-replacement" | "undo-replacement",
    relation: DecisionRelationship,
  ) {
    setBusy(true);
    setError(null);
    try {
      const [before, after] = await Promise.all(
        [relation.predecessorId, relation.successorId].map((id) =>
          executeAtomQuery(
            appAtomRegistry,
            threadDecisionEnvironment.get({ environmentId, input: { projectId, id } }),
            { refresh: true, reportFailure: false },
          ),
        ),
      );
      if (!before || !after || before._tag === "Failure" || after._tag === "Failure") {
        setError(
          "Both decisions must be available to change this replacement. Refresh and try again.",
        );
        return;
      }
      setRelationshipReview({ action, relation, before: before.value, after: after.value });
    } finally {
      setBusy(false);
    }
  }
  async function exportNotes(format: "markdown" | "json") {
    const revision = list.data?.projectRevision;
    if (revision === undefined) return;
    setBusy(true);
    setError(null);
    try {
      let next: string | null = null;
      const pages: string[] = [];
      const exportPages: ThreadDecisionExportResult[] = [];
      const cursors = new Set<string>();
      do {
        const { cursor: _cursor, limit: _limit, ...filters } = input;
        const result = await exportCommand({
          environmentId,
          input: {
            ...filters,
            format,
            expectedProjectRevision: revision,
            ...(next ? { cursor: next } : {}),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (format === "json") exportPages.push(result.value);
        else pages.push(result.value.content);
        next = result.value.nextCursor;
        if (next) {
          if (cursors.has(next)) throw new Error("Export did not advance. Refresh and try again.");
          cursors.add(next);
        }
      } while (next);
      const content =
        format === "json"
          ? assembleDecisionJsonExport(projectId, exportPages)
          : pages.join("\n\n---\n\n");
      const saved = await downloadTextFile(
        content,
        `decisions.${format === "json" ? "json" : "md"}`,
        format === "json" ? "application/json" : "text/markdown",
      );
      if (saved.status === "error") setError(saved.message);
      else
        setNotice(
          saved.status === "saved"
            ? "Decisions saved."
            : saved.status === "canceled"
              ? "Export canceled."
              : "Download requested. Complete the save dialog if prompted.",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }
  const settings = status.data?.settings,
    processing = status.data?.processing;
  const canAnalyze =
    canOperate &&
    settings?.enabled &&
    settings.fundingState === "active" &&
    processing?.writerSupported &&
    !["access-expired", "allowance-exhausted", "unfunded"].includes(processing.blockedReason ?? "");
  const message = error ?? list.error ?? status.error;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Decisions">
      <div className="space-y-3 border-b border-border/50 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="mr-auto text-xs text-muted-foreground">
            {processing ? decisionStatusLabel(processing) : "Loading tracking status…"}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              list.refresh();
              status.refresh();
            }}
          >
            Refresh
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setDescription(settings?.description ?? "");
              setConfigOpen(true);
            }}
          >
            Settings
          </Button>
        </div>
        {!canOperate ? (
          <p className="text-xs text-muted-foreground">
            Read-only access. You can read, copy, and export saved decisions.
          </p>
        ) : null}
        <label className="block">
          <span className="sr-only">Search decisions</span>
          <input
            className={`${inputClass} w-full`}
            placeholder="Search decisions and evidence…"
            value={search}
            maxLength={500}
            onChange={(event) => setFilters(() => setSearch(event.target.value))}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <label className="text-xs">
            Review{" "}
            <select
              className={inputClass}
              value={review}
              onChange={(e) => setFilters(() => setReview(e.target.value as typeof review))}
            >
              <option value="active">Not dismissed</option>
              <option value="unreviewed">Unreviewed</option>
              <option value="confirmed">Confirmed</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All reviews</option>
            </select>
          </label>
          <label className="text-xs">
            History{" "}
            <select
              className={inputClass}
              value={lifecycle}
              onChange={(e) => setFilters(() => setLifecycle(e.target.value as typeof lifecycle))}
            >
              <option value="current">Current</option>
              <option value="superseded">Superseded</option>
              <option value="all">All decisions</option>
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !list.data}
            onClick={() => void exportNotes("markdown")}
          >
            Export Markdown
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !list.data}
            onClick={() => void exportNotes("json")}
          >
            Export JSON
          </Button>
          {threadId && canOperate && processing ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  settingsCommand({
                    environmentId,
                    input: {
                      operation: "pause-thread",
                      projectId,
                      threadId,
                      paused: !processing.paused,
                      expectedPauseEpoch: processing.pauseEpoch,
                    },
                  }),
                )
              }
            >
              {processing.paused ? "Resume thread" : "Pause thread"}
            </Button>
          ) : null}
        </div>
        {processing ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Processing details</summary>
            <p className="mt-2">
              {processing.pendingCount} pending · {processing.incompleteCount} incomplete ·{" "}
              {processing.unscannedMessageCount} unscanned messages
            </p>
            <p>
              Tracking ready covers new conversation only; earlier history is scanned separately.
            </p>
            {processing.writerSupportReason ? <p>{processing.writerSupportReason}</p> : null}
            {settings?.fundingAccountLabel ? (
              <p>Detection allowance: {settings.fundingAccountLabel}</p>
            ) : null}
          </details>
        ) : null}
        {status.data?.activeScans.length ? (
          <details className="text-xs">
            <summary>Historical scans ({status.data.activeScans.length})</summary>
            {status.data.activeScans.map((active) => (
              <div key={active.scanId} className="mt-2 flex items-center gap-2">
                <span className="mr-auto">
                  {active.messageCount} messages · {active.state}
                </span>
                {canOperate ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        scanCommand({
                          environmentId,
                          input: { operation: "cancel", projectId, scanId: active.scanId },
                        }),
                      )
                    }
                  >
                    Cancel scan
                  </Button>
                ) : null}
              </div>
            ))}
          </details>
        ) : null}
        {status.data?.incompleteJobs.length ? (
          <details className="text-xs">
            <summary>Unfinished analysis ({status.data.incompleteJobs.length})</summary>
            <div className="mt-2 space-y-2">
              {status.data.incompleteJobs.map((job) => (
                <div key={job.id} className="flex items-center gap-2">
                  <span className="mr-auto">
                    {job.state} · {job.reason ?? "Needs attention"}
                  </span>
                  {canAnalyze &&
                  (!job.reason ||
                    [
                      "budget",
                      "error",
                      "provider-unavailable",
                      "detector-unavailable",
                      "host-policy",
                    ].includes(job.reason)) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          scanCommand({
                            environmentId,
                            input: { operation: "retry", projectId, jobId: job.id },
                          }),
                        )
                      }
                    >
                      {job.reason === "detector-unavailable" ? "Retry detection" : "Retry"}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs">
            {notice}
          </p>
        ) : null}
        {newCount > 0 ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setView({ visible: list.data?.decisions ?? EMPTY, newCount: 0 });
            }}
          >
            {newCount} new decisions — show
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {list.isPending && !list.data ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading decisions…
          </p>
        ) : null}
        {!list.isPending && visible.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">
            <p>No decisions match this view.</p>
            <p className="mt-2">
              Decisions capture agreed choices, constraints, and reversals with their source
              evidence.
            </p>
            {canOperate && !settings?.enabled ? (
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() => {
                  setDescription(settings?.description ?? "");
                  setConfigOpen(true);
                }}
              >
                Set up tracking
              </Button>
            ) : null}
          </div>
        ) : null}
        {visible.map((note) => (
          <article
            key={note.id}
            tabIndex={0}
            className="lecturn-panel-tile rounded-lg p-4 focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={note.title}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" && note.evidence[0]) {
                event.preventDefault();
                setSource({ note, evidence: note.evidence[0] });
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next =
                  event.key === "ArrowDown"
                    ? event.currentTarget.nextElementSibling
                    : event.currentTarget.previousElementSibling;
                if (next instanceof HTMLElement) next.focus();
              }
            }}
          >
            <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              <span>
                {note.attribution === "user-directed"
                  ? "User directed"
                  : note.attribution === "user-accepted"
                    ? "User accepted"
                    : "Agent chosen"}
              </span>
              <span>{note.reviewState}</span>
              {note.lifecycle === "superseded" ? <span>Superseded</span> : null}
              {note.userEdited ? <span>Edited</span> : null}
            </div>
            <h3 className="text-sm font-semibold">{note.title}</h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{note.body}</p>
            {note.rationale ? (
              <p className="mt-2 text-xs text-muted-foreground">Rationale: {note.rationale}</p>
            ) : null}
            {note.comment ? (
              <p className="mt-3 rounded border border-border/50 p-2 text-sm whitespace-pre-wrap">
                Comment: {note.comment}
              </p>
            ) : null}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {note.evidence.length} source {note.evidence.length === 1 ? "excerpt" : "excerpts"}
                {note.threadTitle ? ` · ${note.threadTitle}` : ""}
              </summary>
              <div className="mt-2 space-y-2">
                {note.evidence.map((evidence) => (
                  <button
                    key={evidence.id}
                    className="block w-full rounded border border-border/50 p-2 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => setSource({ note, evidence })}
                  >
                    <span className="block whitespace-pre-wrap">{evidence.quote}</span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">
                      {evidence.availability === "available"
                        ? "Open source"
                        : "Saved evidence · source may be unavailable"}
                    </span>
                  </button>
                ))}
              </div>
            </details>
            {note.relationships
              .filter((r) => r.state !== "rejected" && r.state !== "undone")
              .map((relation) => (
                <div key={relation.id} className="mt-3 border-t border-border/50 pt-2 text-xs">
                  <p>{decisionRelationshipLabel(note.id, relation)}</p>
                  {canOperate ? (
                    <div className="mt-1 flex gap-2">
                      {relation.state === "proposed" ? (
                        <>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void relationship("accept-replacement", relation)}
                          >
                            Accept replacement
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void relationship("reject-replacement", relation)}
                          >
                            Reject
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void relationship("undo-replacement", relation)}
                        >
                          Undo replacement
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            <div className="mt-3 flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void writeTextToClipboard(
                    decisionToMarkdown(note, environmentId),
                    "decision",
                  ).then(
                    () => setNotice("Decision copied."),
                    () => setError("Could not copy the decision."),
                  )
                }
              >
                Copy
              </Button>
              {canOperate ? (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        operation: "review",
                        projectId,
                        id: note.id,
                        expectedRevision: note.revision,
                        reviewState: note.reviewState === "confirmed" ? "unreviewed" : "confirmed",
                      })
                    }
                  >
                    {note.reviewState === "confirmed" ? "Undo confirmation" : "Confirm"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing({ note, mode: "edit" })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing({ note, mode: "comment" })}
                  >
                    Comment
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        operation: "review",
                        projectId,
                        id: note.id,
                        expectedRevision: note.revision,
                        reviewState: note.reviewState === "dismissed" ? "unreviewed" : "dismissed",
                      })
                    }
                  >
                    {note.reviewState === "dismissed" ? "Restore" : "Dismiss"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setDeleting(note)}
                  >
                    Delete…
                  </Button>
                </>
              ) : null}
            </div>
          </article>
        ))}
        <div className="flex justify-between gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={!history.length || busy}
            onClick={() => {
              setCursor(history.at(-1));
              setHistory(history.slice(0, -1));
            }}
          >
            Previous page
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={!list.data?.nextCursor || busy}
            onClick={() => {
              setHistory([...history, cursor]);
              setCursor(list.data?.nextCursor ?? undefined);
            }}
          >
            Next page
          </Button>
        </div>
      </div>
      {source ? (
        <DecisionSourceDialog
          environmentId={environmentId}
          projectId={projectId}
          {...source}
          onClose={() => setSource(null)}
        />
      ) : null}
      {editing ? (
        <DecisionEditor
          {...editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(value) =>
            mutate(
              editing.mode === "edit"
                ? {
                    operation: "edit",
                    projectId,
                    id: editing.note.id,
                    expectedRevision: editing.note.revision,
                    title: value.title,
                    body: value.body,
                    rationale: value.rationale,
                  }
                : {
                    operation: "comment",
                    projectId,
                    id: editing.note.id,
                    expectedRevision: editing.note.revision,
                    comment: value.comment,
                  },
            )
          }
        />
      ) : null}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Decision tracking</DialogTitle>
            <DialogDescription>
              Settings apply to this project on this environment.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <DecisionsFunding environmentId={environmentId} onChange={status.refresh} />
            <p className="text-sm">
              Lecturn uses TypeSafe to find decisions in conversation excerpts. Your thread’s
              connected agent writes the notes using that account’s usage allowance. Detection uses
              your membership allowance.
            </p>
            <label className="block text-sm">
              What decisions should Lecturn track?
              <textarea
                className={`${inputClass} mt-1 w-full`}
                rows={4}
                maxLength={2000}
                disabled={!canOperate}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Track agreed architecture, product behavior, scope, and constraints."
              />
            </label>
            {settings ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={
                    !canOperate || busy || (!settings.enabled && settings.fundingState !== "active")
                  }
                  onClick={() =>
                    void perform(() =>
                      settingsCommand({
                        environmentId,
                        input: {
                          operation: "update",
                          projectId,
                          expectedRevision: settings.revision,
                          enabled: !settings.enabled,
                          description,
                        },
                      }),
                    )
                  }
                >
                  {settings.enabled ? "Turn tracking off" : "Enable from now on"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || busy || description === settings.description}
                  onClick={() =>
                    void perform(() =>
                      settingsCommand({
                        environmentId,
                        input: {
                          operation: "update",
                          projectId,
                          expectedRevision: settings.revision,
                          enabled: settings.enabled,
                          description,
                        },
                      }),
                    )
                  }
                >
                  Save description
                </Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Changing the description affects future work. Existing notes stay unchanged. Turning
              tracking off preserves notes.
            </p>
            {settings?.fundingState !== "active" ? (
              <p className="text-sm">
                Membership funding is required before new tracking can start. Saved decisions remain
                available.
              </p>
            ) : null}
            {scan?.scanId ? (
              <Button size="sm" variant="outline" onClick={() => setScanOpen(true)}>
                View last historical scan
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!canAnalyze || busy}
              onClick={() =>
                void perform(() =>
                  scanCommand({
                    environmentId,
                    input: { operation: "preview", projectId, ...(threadId ? { threadId } : {}) },
                  }),
                ).then((result) => {
                  if (result) {
                    setScan(result);
                    setScanOpen(true);
                  }
                })
              }
            >
              Scan existing conversation…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canOperate || busy}
              onClick={() => setDeleting("project")}
            >
              Delete project decision data…
            </Button>
            {threadId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void navigate({
                    to: "/decisions/$environmentId/$projectId",
                    params: { environmentId, projectId },
                  })
                }
              >
                Open all project decisions
              </Button>
            ) : null}
            {message ? (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={relationshipReview !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRelationshipReview(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Review decision replacement</DialogTitle>
            <DialogDescription>
              Both notes and their evidence stay available. This changes which decision is current.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {relationshipReview ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">Earlier decision</p>
                  <h3 className="font-medium">{relationshipReview.before.title}</h3>
                  <p className="whitespace-pre-wrap text-sm">{relationshipReview.before.body}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Proposed replacement</p>
                  <h3 className="font-medium">{relationshipReview.after.title}</h3>
                  <p className="whitespace-pre-wrap text-sm">{relationshipReview.after.body}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRelationshipReview(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={busy || !canOperate}
                    onClick={() =>
                      void mutate({
                        operation: relationshipReview.action,
                        projectId,
                        relationshipId: relationshipReview.relation.id,
                        expectedRevision: relationshipReview.relation.revision,
                        expectedPredecessorRevision: relationshipReview.before.revision,
                        expectedSuccessorRevision: relationshipReview.after.revision,
                      }).then((ok) => {
                        if (ok) setRelationshipReview(null);
                      })
                    }
                  >
                    {relationshipReview.action === "accept-replacement"
                      ? "Accept replacement"
                      : relationshipReview.action === "reject-replacement"
                        ? "Reject proposal"
                        : "Undo replacement"}
                  </Button>
                </div>
              </>
            ) : null}
            {message ? <p role="alert">{message}</p> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog open={scanOpen} onOpenChange={setScanOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Scan existing conversation</DialogTitle>
            <DialogDescription>
              Historical analysis uses detection allowance and your agent’s account.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {scan ? (
              <>
                <p className="text-sm">
                  Range: all finalized user and assistant messages currently in this{" "}
                  {threadId ? "thread" : "project"}. The scan uses this captured snapshot; if its
                  source changes before preparation finishes, preview a new scan.
                </p>
                <p>
                  {scan.messageCount} messages
                  {scan.state === "preview" ? (
                    <>
                      {" "}
                      · approximately {scan.estimatedInputTokens.toLocaleString()} detection input
                      tokens.
                    </>
                  ) : null}
                </p>
                <p className="text-sm">
                  Funding account: {settings?.fundingAccountLabel ?? "Not linked"}
                </p>
                <p className="text-xs">Status: {scan.state}</p>
                {scan.state === "preview" && scan.previewToken && settings ? (
                  <Button
                    disabled={!canAnalyze || busy}
                    onClick={() =>
                      void perform(() =>
                        scanCommand({
                          environmentId,
                          input: {
                            operation: "start",
                            projectId,
                            ...(threadId ? { threadId } : {}),
                            expectedSettingsRevision: settings.revision,
                            previewToken: scan.previewToken!,
                          },
                        }),
                      ).then((value) => {
                        if (value) setScan(value);
                      })
                    }
                  >
                    Start this scan
                  </Button>
                ) : null}
                {scan.scanId && ["queued", "running", "incomplete"].includes(scan.state) ? (
                  <Button
                    variant="outline"
                    disabled={!canOperate || busy}
                    onClick={() =>
                      void perform(() =>
                        scanCommand({
                          environmentId,
                          input: { operation: "cancel", projectId, scanId: scan.scanId! },
                        }),
                      ).then((value) => {
                        if (value) setScan(value);
                      })
                    }
                  >
                    Cancel scan
                  </Button>
                ) : null}
              </>
            ) : null}
            {message ? <p role="alert">{message}</p> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {deleting === "project"
                ? "Delete all project decision data?"
                : "Permanently delete this decision?"}
            </DialogTitle>
            <DialogDescription>
              {deleting === "project"
                ? "This disables tracking and removes this project’s decisions, evidence, processing jobs, and suppression history. Saved manual notes and conversation messages stay intact."
                : "This deletes the note and keeps a minimal suppression marker to avoid immediate recreation. Conversation messages stay intact."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy || !canOperate}
                onClick={() => {
                  if (deleting === "project" && settings)
                    void perform(() =>
                      settingsCommand({
                        environmentId,
                        input: {
                          operation: "purge",
                          projectId,
                          expectedRevision: settings.revision,
                        },
                      }),
                    ).then((result) => {
                      if (result) setDeleting(null);
                    });
                  else if (deleting && deleting !== "project")
                    void mutate({
                      operation: "delete",
                      projectId,
                      id: deleting.id,
                      expectedRevision: deleting.revision,
                    }).then((ok) => {
                      if (ok) setDeleting(null);
                    });
                }}
              >
                Delete permanently
              </Button>
            </div>
            {message ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {message}
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
