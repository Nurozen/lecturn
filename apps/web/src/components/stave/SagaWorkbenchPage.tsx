import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  buildSagaDependencyWaves,
  countSagaWorkbenchStages,
  reconcileSagaWorkbenchSnapshot,
  sagaWorkbenchSummaryFallback,
  sagaWorkbenchStageLabel,
  SAGA_WORKBENCH_STAGES,
} from "@t3tools/client-runtime/state/sagaWorkbench";
import {
  ThreadId,
  type EnvironmentId,
  type ProjectId,
  type SagaWorkbenchSnapshot,
  type SagaWorkbenchWorkflow,
} from "@t3tools/contracts";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import * as workbench from "../../state/sagaWorkbench";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { subscribeStaveMutation } from "../../staveMutation";
import { randomUUID } from "../../lib/utils";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { Button } from "../ui/button";
import {
  sagaSummarySourceTarget,
  sagaProjectActivities,
  sagaRunningProjects,
  sagaStageDropInput,
  captureSagaStageDrag,
  sagaThreadActivity,
  sagaWorkflowLabel,
  SAGA_VIEWS,
  type parseSagaWorkbenchSearch,
} from "./sagaWorkbench.logic";

import { SagaWorkbenchBoard, SagaWorkbenchCard, SagaPhaseColumn } from "./SagaWorkbenchBoard";

export function SagaWorkbenchPage({
  environmentId,
  projectId,
  search,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  search: ReturnType<typeof parseSagaWorkbenchSearch>;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const threadShellState = useEnvironmentQuery(environmentShell.stateAtom(environmentId));
  const threadFactsAvailable = threadShellState.data?.snapshot._tag === "Some";
  const activities = useMemo(
    () => sagaProjectActivities(threads, environmentId),
    [threads, environmentId],
  );
  const runningProjects = useMemo(
    () => sagaRunningProjects(threads, environmentId),
    [threads, environmentId],
  );
  const environment = useEnvironment(environmentId);
  const disconnected = environment?.connection.phase !== "connected";
  const settingsGroups = useSettingsProjectGroups();
  const createThread = useNewThreadHandler();
  const query = useEnvironmentQuery(
    workbench.sagaWorkbenchSnapshot({ environmentId, input: { projectId } }),
  );
  const [previous, setPrevious] = useState<SagaWorkbenchSnapshot | null>(null);
  const snapshot = query.data ? reconcileSagaWorkbenchSnapshot(previous, query.data) : previous;
  const [observedData, setObservedData] = useState<SagaWorkbenchSnapshot | null>(null);
  if (query.data !== observedData) {
    setObservedData(query.data);
    if (query.data) setPrevious(reconcileSagaWorkbenchSnapshot(previous, query.data));
  }
  const selected = snapshot?.members.find((member) => member.id === search.member);
  const workflow = selected
    ? selected.workflow
    : search.member
      ? null
      : (snapshot?.workflow ?? null);
  const identity = selected?.identity ?? workflow?.identity ?? null;
  const lifecycleReadonly = selected !== undefined && selected.state !== "live";
  const evidence = useEnvironmentQuery(
    identity && !lifecycleReadonly
      ? workbench.sagaWorkbenchEvidence({ environmentId, input: { identity } })
      : null,
  );
  const activity = useEnvironmentQuery(
    identity && search.view === "activity"
      ? workbench.sagaWorkbenchActivity({ environmentId, input: { identity } })
      : null,
  );
  const refresh = query.refresh;
  const refreshEvidence = evidence.refresh;
  const refreshActivity = activity.refresh;
  useEffect(() => {
    if (!disconnected) {
      refresh();
      refreshEvidence();
      refreshActivity();
    }
  }, [disconnected, refresh, refreshEvidence, refreshActivity]);
  useEffect(() => {
    const update = () => {
      refresh();
      refreshEvidence();
      refreshActivity();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") update();
    }, 15_000);
    const unsubscribe = subscribeStaveMutation((changed) => {
      if (changed === environmentId) update();
    });
    window.addEventListener("online", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("online", update);
      window.removeEventListener("focus", update);
    };
  }, [environmentId, refresh, refreshEvidence, refreshActivity]);
  const configure = useAtomCommand(workbench.sagaWorkbenchConfigure, { reportFailure: false });
  const setStage = useAtomCommand(workbench.sagaWorkbenchSetStage, { reportFailure: false });
  const approve = useAtomCommand(workbench.sagaWorkbenchApprove, { reportFailure: false });
  const complete = useAtomCommand(workbench.sagaWorkbenchComplete, { reportFailure: false });
  const reopen = useAtomCommand(workbench.sagaWorkbenchReopen, { reportFailure: false });
  const summarize = useAtomCommand(workbench.sagaWorkbenchSummarize, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: ReturnType<typeof setStage>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "The operation failed. Refresh and try again.",
        );
      } else {
        setPrevious((old) =>
          old
            ? reconcileSagaWorkbenchSnapshot(old, {
                ...old,
                workflow:
                  old.workflow.identity.projectId === result.value.identity.projectId &&
                  old.workflow.identity.createdAt === result.value.identity.createdAt &&
                  old.workflow.identity.workspaceRoot === result.value.identity.workspaceRoot
                    ? result.value
                    : old.workflow,
                members: old.members.map((member) =>
                  member.identity?.projectId === result.value.identity.projectId &&
                  member.identity.createdAt === result.value.identity.createdAt &&
                  member.identity.workspaceRoot === result.value.identity.workspaceRoot
                    ? { ...member, workflow: result.value }
                    : member,
                ),
              })
            : old,
        );
      }
    } finally {
      setBusy(false);
      refresh();
      refreshEvidence();
      refreshActivity();
    }
  };
  const input = workflow
    ? { identity: workflow.identity, expectedRevision: workflow.revision, requestId: randomUUID() }
    : null;
  const project = projects.find(
    (item) => item.environmentId === environmentId && item.id === projectId,
  );
  const targetProject = identity
    ? projects.find(
        (item) => item.environmentId === environmentId && item.id === identity.projectId,
      )
    : null;
  const targetThreads = threads.filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === identity?.projectId,
  );
  const settingsGroup = settingsGroups.find((group) =>
    group.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === identity?.projectId,
    ),
  );
  const counts = snapshot ? countSagaWorkbenchStages(snapshot) : null;
  const dependencies = useMemo(
    () => buildSagaDependencyWaves(snapshot?.members ?? []),
    [snapshot?.members],
  );
  const select = (member?: string) =>
    void navigate({
      to: "/sagas/$environmentId/$projectId",
      params: { environmentId, projectId },
      search: { view: search.view, ...(member ? { member } : {}) },
    });
  const card = (member: NonNullable<typeof snapshot>["members"][number], onBoard = false) => (
    <SagaWorkbenchCard
      key={member.id}
      id={member.id}
      stage={member.workflow?.stage ?? "spec"}
      draggable={
        onBoard &&
        !!sagaStageDropInput(
          [member],
          captureSagaStageDrag(member),
          member.workflow?.stage === "spec" ? "plan" : "spec",
          !busy && !disconnected && !query.error,
          "check",
        )
      }
      pinned={member.workflow?.stagePinned === true}
      canPin={
        !busy &&
        !disconnected &&
        !query.error &&
        member.state === "live" &&
        !!member.workflow &&
        !member.workflow.completedAt
      }
      onPin={() => {
        if (member.workflow)
          void run(
            configure({
              environmentId,
              input: {
                identity: member.workflow.identity,
                expectedRevision: member.workflow.revision,
                requestId: randomUUID(),
                stagePinned: !member.workflow.stagePinned,
              },
            }),
          );
      }}
      running={
        !disconnected &&
        threadFactsAvailable &&
        member.state === "live" &&
        !!member.identity &&
        runningProjects.has(member.identity.projectId)
      }
    >
      <button
        key={member.id}
        data-lecturn-hover
        aria-pressed={search.member === member.id}
        onClick={() => select(member.id)}
        className={`w-full rounded-lg border p-3 text-left ${search.member === member.id ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-accent"}`}
      >
        <span className="block truncate pr-14 font-medium">{member.id}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {sagaWorkflowLabel(member.workflow)} · {member.state}
        </span>
        <span
          className={`mt-2 block text-xs ${member.identity && activities.get(member.identity.projectId)?.kind !== "idle" && activities.has(member.identity.projectId) ? "text-primary" : "text-muted-foreground"}`}
        >
          Agent activity{disconnected ? " (last known)" : ""}:{" "}
          {member.state !== "live"
            ? "Unavailable · inactive space"
            : !threadFactsAvailable
              ? "Unavailable · conversations syncing"
              : member.identity
                ? (activities.get(member.identity.projectId)?.label ??
                  "Idle · no active conversations")
                : "Unavailable"}
        </span>
        <span className="mt-2 block text-xs text-muted-foreground">
          {member.workflow?.summary?.text ?? sagaWorkbenchSummaryFallback(member.workflow)}
        </span>
        {member.workflow?.summary ? (
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Summary snapshot · {new Date(member.workflow.summary.generatedAt).toLocaleString()}
          </span>
        ) : null}
        {member.after.length ? (
          <span className="mt-2 block text-xs text-muted-foreground">
            After {member.after.join(", ")}
          </span>
        ) : null}
      </button>
    </SagaWorkbenchCard>
  );
  const active =
    snapshot?.members.filter(
      (member) => !member.workflow?.completedAt || member.workflow.evidenceState === "stale",
    ) ?? [];
  const completed =
    snapshot?.members.filter(
      (member) => member.workflow?.completedAt && member.workflow.evidenceState !== "stale",
    ) ?? [];
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-background text-foreground">
      <header className="border-b border-border px-6 py-5">
        <Link to="/" className="text-xs text-muted-foreground hover:text-primary">
          Projects
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{project?.title ?? "Saga workbench"}</h1>
          <span className="rounded border border-primary/30 px-2 py-0.5 text-xs text-primary">
            Saga
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={query.isPending}
            onClick={() => {
              refresh();
              refreshEvidence();
              refreshActivity();
            }}
          >
            Refresh facts
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {environment?.label ?? environmentId} ·{" "}
          {project?.workspaceRoot ?? snapshot?.identity.workspaceRoot}
        </p>
        {counts ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {SAGA_WORKBENCH_STAGES.map(
              (stage) => `${counts[stage]} ${sagaWorkbenchStageLabel(stage)}`,
            ).join(" · ")}{" "}
            · {counts.completed} completed · {counts.unavailable} unavailable
          </p>
        ) : null}
        <nav aria-label="Saga views" className="mt-4 flex flex-wrap gap-1">
          {SAGA_VIEWS.map((view) => (
            <Link
              key={view}
              data-lecturn-hover
              to="/sagas/$environmentId/$projectId"
              params={{ environmentId, projectId }}
              search={{ ...search, view }}
              aria-current={search.view === view ? "page" : undefined}
              className={`rounded-md px-3 py-2 text-sm capitalize ${search.view === view ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent"}`}
            >
              {view}
            </Link>
          ))}
        </nav>
      </header>
      {disconnected ? (
        <p role="status" className="mx-6 mt-4 rounded border border-border p-3 text-sm">
          Environment {environment?.connection.phase ?? "unavailable"}. Displayed facts may be
          stale; workflow actions are unavailable until connected.
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="mx-6 mt-4 rounded border border-destructive/40 p-3 text-sm">
          Facts may be stale. {query.error}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status" className="p-6 text-muted-foreground">
          {query.isPending ? "Loading saga…" : "Saga unavailable in this environment."}
        </p>
      ) : (
        <div className="grid flex-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section aria-label="Saga members" className="min-w-0 space-y-4">
            <button
              data-lecturn-hover
              className="text-sm text-primary"
              aria-pressed={!search.member}
              onClick={() => select()}
            >
              Saga overview & conversations
            </button>
            {search.view === "board" ? (
              <SagaWorkbenchBoard
                onPick={(memberId) =>
                  captureSagaStageDrag(snapshot.members.find((member) => member.id === memberId))
                }
                onMove={(gesture, stage) => {
                  const drop = sagaStageDropInput(
                    snapshot.members,
                    gesture,
                    stage,
                    !busy && !disconnected && !query.error,
                    randomUUID(),
                  );
                  if (drop) void run(setStage({ environmentId, input: drop }));
                }}
              >
                {SAGA_WORKBENCH_STAGES.map((stage) => (
                  <SagaPhaseColumn key={stage} stage={stage} count={counts?.[stage] ?? 0}>
                    {active
                      .filter((member) => member.workflow?.stage === stage)
                      .map((member) => card(member, true))}
                  </SagaPhaseColumn>
                ))}
              </SagaWorkbenchBoard>
            ) : null}
            {search.view === "list" ? (
              <div className="space-y-2">{active.map((member) => card(member))}</div>
            ) : null}
            {search.view === "dependencies" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Dependencies describe prerequisites between spaces. Workflow stages and agent
                  activity are independent.
                </p>
                {dependencies.waves.map((wave, index) => (
                  <section
                    key={wave.map((member) => member.id).join(":")}
                    className="rounded-lg border border-border p-3"
                  >
                    <h2 className="mb-3 text-sm font-medium">Wave {index + 1}</h2>
                    <div className="grid gap-2 md:grid-cols-2">
                      {wave.map((member) => card(member))}
                    </div>
                  </section>
                ))}
                {dependencies.unresolved.length ? (
                  <section className="space-y-2">
                    <h2 className="text-sm font-medium">Unresolved dependencies</h2>
                    {dependencies.unresolved.map((member) => (
                      <div key={member.id}>
                        {card(member)}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {dependencies.missing.has(member.id)
                            ? `Missing: ${dependencies.missing.get(member.id)!.join(", ")}`
                            : "Cycle or unresolved prerequisite. No dependency wave can be verified."}
                        </p>
                      </div>
                    ))}
                  </section>
                ) : null}
              </>
            ) : null}
            {search.view === "activity" ? (
              <section>
                <h2 className="mb-3 font-medium">{selected?.id ?? "Saga"} workflow activity</h2>
                <p className="mb-3 text-xs text-muted-foreground">
                  Select a member to inspect its history. Session activity is shown separately in
                  its conversations.
                </p>
                {activity.error ? <p role="alert">Activity unavailable: {activity.error}</p> : null}
                {activity.data?.length ? (
                  <ol className="space-y-3">
                    {activity.data.map((entry) => (
                      <li key={entry.revision} className="rounded border border-border p-3 text-sm">
                        <p>
                          {entry.action} · {entry.detail}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {new Date(entry.at).toLocaleString()} · {entry.subject}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">No workflow events available.</p>
                )}
                <div className="mt-4 space-y-2">
                  {snapshot.members.map((member) => card(member))}
                </div>
              </section>
            ) : null}
            {search.view === "settings" ? (
              <section className="space-y-3">
                <h2 className="font-medium">Project settings</h2>
                <p className="text-sm text-muted-foreground">
                  Saga and member projects retain their existing settings scope. Select a project to
                  open its settings.
                </p>
                <div className="space-y-2">{snapshot.members.map((member) => card(member))}</div>
              </section>
            ) : null}
            {search.view === "board" && active.some((member) => !member.workflow) ? (
              <section className="space-y-2">
                <h2 className="text-sm font-medium">Unavailable members</h2>
                {active.filter((member) => !member.workflow).map((member) => card(member))}
              </section>
            ) : null}
            {(search.view === "board" || search.view === "list") && completed.length > 0 ? (
              <details open className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Completed ({completed.length})
                </summary>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {completed.map((member) => card(member))}
                </div>
              </details>
            ) : null}
            {snapshot.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No member spaces. Add members through saga Project Settings.
              </p>
            ) : null}
          </section>
          <aside
            aria-label="Selected project details"
            className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 self-start"
          >
            <div>
              <h2 className="font-semibold">
                {selected?.id ?? (search.member ? search.member : (project?.title ?? "Saga"))}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{sagaWorkflowLabel(workflow)}</p>
              {workflow?.completedAt ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Completion recorded {new Date(workflow.completedAt).toLocaleString()}
                  {workflow.evidenceState === "stale" ? " · stale" : " · historical verification"}
                </p>
              ) : null}
              {identity ? (
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  {identity.workspaceRoot}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  This member is unavailable. Open its physical workspace before changing its
                  workflow.
                </p>
              )}
            </div>
            {settingsGroup ? (
              <Link
                data-lecturn-hover
                to="/projects/$projectKey"
                params={{ projectKey: settingsGroup.projectKey }}
                className="inline-block text-sm text-primary"
              >
                Open Project Settings
              </Link>
            ) : null}
            {workflow ? (
              <>
                {lifecycleReadonly ? (
                  <p className="text-sm text-muted-foreground">
                    This space is {selected?.state}. Showing saved workflow history. Restore it
                    through Project Settings before refreshing evidence or changing its workflow.
                  </p>
                ) : null}
                <Summary workflow={workflow} environmentId={environmentId} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || lifecycleReadonly || !!query.error || disconnected}
                  onClick={() => input && void run(summarize({ environmentId, input }))}
                >
                  Update summary & inferred stage
                </Button>
                {selected ? (
                  <section className="space-y-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={workflow.automaticStage !== false}
                        disabled={
                          busy ||
                          lifecycleReadonly ||
                          !!workflow.completedAt ||
                          !!query.error ||
                          disconnected
                        }
                        onChange={(event) =>
                          input &&
                          void run(
                            configure({
                              environmentId,
                              input: { ...input, automaticStage: event.target.checked },
                            }),
                          )
                        }
                      />
                      Automatically infer stage
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={workflow.stagePinned === true}
                        disabled={
                          busy ||
                          lifecycleReadonly ||
                          !!workflow.completedAt ||
                          !!query.error ||
                          disconnected
                        }
                        onChange={(event) =>
                          input &&
                          void run(
                            configure({
                              environmentId,
                              input: { ...input, stagePinned: event.target.checked },
                            }),
                          )
                        }
                      />
                      Pin this stage
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {workflow.stagePinned
                        ? "Stage pinned: automatic updates and dragging cannot move this space."
                        : workflow.automaticStage !== false
                          ? "The model updates the phase from the previous three completed conversation turns when a prompt is submitted."
                          : "Drag the card by its handle to another phase on the Board. Keyboard: Space, arrow keys, Space."}{" "}
                      Summaries update automatically even with stage inference disabled or the stage
                      pinned. Phase changes never approve, merge, or complete work.
                    </p>
                    {workflow.evidenceState ? (
                      <p className="text-xs text-muted-foreground">
                        {workflow.evidenceState === "stale"
                          ? "Evidence changed. Acceptance or completion must be verified again."
                          : "Saved acceptance has not been freshly verified."}
                      </p>
                    ) : null}
                    {workflow.accepted ? (
                      <p className="text-xs text-muted-foreground">
                        Accepted by {workflow.accepted.subject} ·{" "}
                        {new Date(workflow.accepted.at).toLocaleString()}
                      </p>
                    ) : null}
                    {workflow.completedAt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || lifecycleReadonly || !!query.error || disconnected}
                        onClick={() => input && void run(reopen({ environmentId, input }))}
                      >
                        Reopen work
                      </Button>
                    ) : workflow.stage === "accept" ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={
                            busy ||
                            lifecycleReadonly ||
                            !!query.error ||
                            disconnected ||
                            !evidence.data ||
                            !!evidence.error ||
                            evidence.isPending
                          }
                          onClick={() =>
                            input &&
                            evidence.data &&
                            void run(
                              approve({
                                environmentId,
                                input: {
                                  ...input,
                                  expectedEvidenceRevision: evidence.data.sourceRevision,
                                },
                              }),
                            )
                          }
                        >
                          {workflow.accepted
                            ? "Accept current revisions again"
                            : "Accept current revisions"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            lifecycleReadonly ||
                            !!query.error ||
                            disconnected ||
                            !workflow.accepted
                          }
                          onClick={() => input && void run(complete({ environmentId, input }))}
                        >
                          Verify CI & merge; complete
                        </Button>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Conversations ({targetThreads.length})</h3>
                  {targetThreads.map((thread) => (
                    <Link
                      key={thread.id}
                      data-lecturn-hover
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: thread.id }}
                      className="block rounded border border-border p-2 text-sm hover:bg-accent"
                    >
                      {thread.title}
                      <span
                        className={`block text-xs ${sagaThreadActivity(thread).kind === "idle" ? "text-muted-foreground" : "text-primary"}`}
                      >
                        Agent activity{disconnected ? " (last known)" : ""}:{" "}
                        {sagaThreadActivity(thread).label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {thread.archivedAt
                          ? "Archived"
                          : thread.settledAt
                            ? "Settled"
                            : thread.snoozedUntil
                              ? "Snoozed"
                              : "Open conversation"}
                      </span>
                    </Link>
                  ))}
                  {targetProject &&
                  !lifecycleReadonly &&
                  targetProject.stave?.state !== "archived" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void createThread(scopeProjectRef(environmentId, targetProject.id))
                      }
                    >
                      New conversation
                    </Button>
                  ) : null}
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Repository evidence</h3>
                  {evidence.error ? (
                    <p role="alert" className="text-xs text-destructive">
                      Evidence unavailable or stale: {evidence.error}
                    </p>
                  ) : null}
                  {evidence.isPending ? (
                    <p className="text-xs text-muted-foreground">Refreshing evidence…</p>
                  ) : null}
                  {evidence.data ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Observed {new Date(evidence.data.observedAt).toLocaleString()} ·{" "}
                        {evidence.data.complete ? "Evidence available" : "Evidence incomplete"}
                      </p>
                      {evidence.data.requirements.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No code-delivery requirements.
                        </p>
                      ) : null}
                      {evidence.data.requirements.map((requirement) => (
                        <article
                          key={requirement.key}
                          className="space-y-1 rounded border border-border p-2 text-xs"
                        >
                          <p className="font-medium">
                            {requirement.repoName} · {requirement.kind}
                          </p>
                          <p className="break-all text-muted-foreground">
                            {requirement.host ?? "Unknown host"} /{" "}
                            {requirement.repository ?? "Unknown repository"}
                          </p>
                          {requirement.url ? (
                            <a
                              href={requirement.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary"
                            >
                              Open PR {requirement.number}
                            </a>
                          ) : null}
                          <p>
                            Local: {requirement.localChanges} · Required CI:{" "}
                            {requirement.requiredChecks}
                          </p>
                          <p>
                            Merge:{" "}
                            {requirement.merged === null
                              ? "unknown"
                              : requirement.merged
                                ? "merged"
                                : "not merged"}
                          </p>
                          <p className="break-all text-muted-foreground">
                            Source {requirement.headRevision ?? "unknown"}
                            <br />
                            Checks {requirement.checksRevision ?? "unknown"}
                            <br />
                            Local {requirement.localHeadRevision ?? "unknown"}
                            <br />
                            Base {requirement.baseRevision ?? "unknown"}
                          </p>
                          {requirement.blockers.map((blocker) => (
                            <p key={blocker} className="text-destructive">
                              {blocker}
                            </p>
                          ))}
                        </article>
                      ))}
                      {evidence.data.blockers.map((blocker) => (
                        <p key={blocker} className="text-xs text-destructive">
                          {blocker}
                        </p>
                      ))}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {lifecycleReadonly
                        ? "Fresh evidence is unavailable while the space is inactive. Restore it through Project Settings first."
                        : "No verified repository facts available."}
                    </p>
                  )}
                </section>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </main>
  );
}
function Summary({
  workflow,
  environmentId,
}: {
  workflow: SagaWorkbenchWorkflow;
  environmentId: EnvironmentId;
}) {
  const summary = workflow.summary;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Summary {summary ? "snapshot" : ""}</h3>
      <p className="text-sm text-muted-foreground">
        {summary?.text ?? sagaWorkbenchSummaryFallback(workflow)}
      </p>
      {summary?.inferredStage ? (
        <p className="text-xs text-muted-foreground">
          Model inference: {sagaWorkbenchStageLabel(summary.inferredStage)}
          {summary.confidence !== undefined
            ? ` · ${Math.round(summary.confidence * 100)}% confidence`
            : ""}
          . This is a classification, not acceptance or completion evidence.
        </p>
      ) : null}
      {summary ? (
        <>
          <p className="text-xs text-muted-foreground">
            Generated {new Date(summary.generatedAt).toLocaleString()}. Saved narrative may be
            stale; refresh to include recent changes.
          </p>
          <ul className="space-y-1 text-xs">
            {summary.sources.map((source) => {
              const target = sagaSummarySourceTarget(source.url, environmentId);
              return (
                <li key={source.url}>
                  {target.kind === "thread" ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: ThreadId.make(target.threadId) }}
                      className="text-primary"
                    >
                      {source.label}
                    </Link>
                  ) : target.kind === "external" ? (
                    <a href={target.url} target="_blank" rel="noreferrer" className="text-primary">
                      {source.label}
                    </a>
                  ) : (
                    <span className="break-all text-muted-foreground">
                      {source.label}: {target.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
