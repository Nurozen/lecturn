import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  GitMergeIcon,
  SendIcon,
  RefreshCwIcon,
  EyeIcon,
  EyeOffIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  MinusCircleIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  mergeHandoffMessage,
  selectMergeHandoffThread,
} from "@lecturn/client-runtime/state/pullRequestHandoff";
import {
  activityVisualState,
  describeThreadActivity,
  threadActivityExcerpt,
} from "@lecturn/client-runtime/state/activityContext";
import { ActivityWatchFrame, ActivityWatchState, ActivityCheckBar } from "./ActivityWatchVisual";
import { useEnvironment } from "../../state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { StaveIcon } from "../StaveIcon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { useSagaRepositoryIndex } from "../../state/stave";
import { DesktopActivityToggle } from "./DesktopActivityToggle";
import { randomUUID } from "../../lib/utils";
import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  PullRequestWatch,
  PullRequestWatchCommandInput,
  ThreadId,
} from "@lecturn/contracts";
import { isRepositoryWatchManagerEligible } from "@lecturn/client-runtime/state/repositoryScope";
import { formatEnvironmentQueryError } from "../../state/query";
import { useProjects, useThreadShells, useThreadDetail } from "../../state/entities";
import { pullRequestWatchEnvironment, usePullRequestWatches } from "../../state/pullRequestWatch";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useQuickSteer } from "./useQuickSteer";

function WatchIconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          size="xs"
          variant="outline"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function CheckStatusGlyph({ status }: { status: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" aria-label={status} />}>
        {status === "success" ? (
          <CheckCircle2Icon className="size-3.5 text-emerald-500" />
        ) : status === "failure" ? (
          <CircleAlertIcon className="size-3.5 text-destructive" />
        ) : status === "action-required" ? (
          <CircleAlertIcon className="size-3.5 text-amber-500" />
        ) : status === "pending" ? (
          <ClockIcon className="size-3.5 text-primary" />
        ) : (
          <MinusCircleIcon className="size-3.5 text-muted-foreground" />
        )}
      </TooltipTrigger>
      <TooltipPopup>{status}</TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestWatchButton({
  environmentId,
  reference,
  threadId,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadId?: ThreadId;
}) {
  const { values } = usePullRequestWatches([environmentId]);
  const watch = values[0]?.[1].watches.find(
    (item) =>
      item.reference.projectId === reference.projectId &&
      item.reference.repository.toLowerCase() === reference.repository.toLowerCase() &&
      (item.reference.host ?? "github.com").toLowerCase() ===
        (reference.host ?? "github.com").toLowerCase() &&
      item.reference.number === reference.number,
  );
  const track = useAtomCommand(pullRequestWatchEnvironment.track);
  const command = useAtomCommand(pullRequestWatchEnvironment.command);
  const [pending, setPending] = useState(false);
  return (
    <WatchIconAction
      label={watch?.watching ? "Stop watching" : "Watch pull request"}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          if (watch)
            await command({
              environmentId,
              input: {
                requestId: randomUUID(),
                watchId: watch.id,
                action: watch.watching ? "pause" : "resume",
              },
            });
          else
            await track({
              environmentId,
              input: {
                requestId: randomUUID(),
                reference,
                ...(threadId ? { threadId, manage: true } : {}),
              },
            });
        } finally {
          setPending(false);
        }
      }}
    >
      {watch?.watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
    </WatchIconAction>
  );
}

function WatchCard({
  environmentId,
  watch,
}: {
  environmentId: EnvironmentId;
  watch: PullRequestWatch;
}) {
  const projects = useProjects();
  const environment = useEnvironment(environmentId);
  const sagaIndex = useSagaRepositoryIndex(projects);
  const allThreads = useThreadShells();
  const threads = allThreads.filter(
    (thread) =>
      !thread.archivedAt &&
      isRepositoryWatchManagerEligible({ projects, sagaIndex, environmentId, thread, watch }),
  );
  const command = useAtomCommand(pullRequestWatchEnvironment.command, { reportFailure: false });
  const navigate = useNavigate();
  const steer = useQuickSteer();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const recipient = selectMergeHandoffThread(watch, threads);
  const legacyAuthorization =
    watch.authorization && !["merged", "needs-authorization"].includes(watch.authorization.status);
  const observation = watch.observation;
  const act = async (
    action: PullRequestWatchCommandInput["action"],
    extra: Partial<PullRequestWatchCommandInput> = {},
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await command({
        environmentId,
        input: { requestId: randomUUID(), watchId: watch.id, action, ...extra },
      });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    } finally {
      setBusy(false);
    }
  };
  const manager = allThreads.find(
    (thread) => thread.environmentId === environmentId && thread.id === watch.managerThreadId,
  );
  const managerDetail = useThreadDetail(manager ? { environmentId, threadId: manager.id } : null);
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === environmentId &&
      candidate.id === (manager?.projectId ?? watch.reference.projectId),
  );
  const provider = environment?.serverConfig?.providers.find(
    (candidate) => candidate.instanceId === manager?.modelSelection.instanceId,
  );
  const model = provider?.models.find(
    (candidate) =>
      candidate.slug === manager?.modelSelection.model ||
      (manager && candidate.aliases?.includes(manager.modelSelection.model)),
  );
  const managerState = manager?.hasPendingApprovals
    ? "Needs approval"
    : manager?.hasPendingUserInput
      ? "Needs input"
      : (manager?.session?.status ??
        (watch.managerStatus === "offline" ? "idle" : watch.managerStatus));
  const state = activityVisualState({
    status:
      environment?.connection.phase !== "connected"
        ? "Offline"
        : [
            error || watch.error ? "Error" : "",
            busy ? "Updating" : "",
            observation?.state ?? "",
            observation?.checksState ?? "",
            managerState,
          ].join(" · "),
    ...(watch.watching ? { checks: observation?.checks ?? [] } : {}),
  });
  const stateDetail = `${watch.watching ? "Watching" : "Paused"} · ${watch.managerStatus} · ${observation?.state ?? "Unobserved"}`;
  return (
    <ActivityWatchFrame state={state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">
            {watch.reference.repository} #{watch.reference.number}
          </div>
          <strong className="mt-0.5 block">{observation?.title ?? "Awaiting observation"}</strong>
        </div>
        <ActivityWatchState state={state} detail={stateDetail} />
      </div>
      {project || manager ? (
        <div className="space-y-1.5 rounded-md bg-background/30 p-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {project ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {project.stave ? <StaveIcon className="size-3.5 text-primary" /> : null}
                {!project.stave || project.projectIcon || project.faviconPath ? (
                  <ProjectFavicon
                    environmentId={environmentId}
                    cwd={project.workspaceRoot}
                    projectName={project.title}
                    faviconPath={project.faviconPath}
                    projectIcon={project.projectIcon}
                    className="size-3.5"
                  />
                ) : null}
                <span className="max-w-56 truncate">{project.title}</span>
              </span>
            ) : null}
            {provider ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className="inline-flex min-w-0 items-center gap-1.5 rounded"
                    />
                  }
                >
                  <ProviderInstanceIcon
                    driverKind={provider.driver}
                    displayName={provider.displayName ?? provider.instanceId}
                    accentColor={provider.accentColor}
                    showBadge={
                      (environment?.serverConfig?.providers.filter(
                        (candidate) => candidate.driver === provider.driver,
                      ).length ?? 0) > 1
                    }
                    iconClassName="size-3.5"
                  />
                  <span className="max-w-56 truncate">
                    {model ? getTriggerDisplayModelName(model) : manager?.modelSelection.model}
                  </span>
                </TooltipTrigger>
                <TooltipPopup>{provider.displayName ?? provider.instanceId}</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {manager ? (
            <>
              <button
                type="button"
                data-lecturn-hover
                className="flex max-w-full items-center gap-1.5 rounded text-left text-xs font-medium hover:text-primary"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: manager.id },
                  })
                }
              >
                <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{manager.title}</span>
              </button>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {threadActivityExcerpt(manager, managerDetail?.messages)}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <div tabIndex={0} className="flex items-center gap-2 text-xs text-muted-foreground" />
          }
        >
          <span>{observation?.state ?? "Unknown"}</span>
          <span aria-label={stateDetail} className="inline-flex items-center gap-1">
            {watch.watching ? (
              <EyeIcon aria-hidden className="size-3.5" />
            ) : (
              <EyeOffIcon aria-hidden className="size-3.5" />
            )}
          </span>
          <span className="ml-auto">Required: {observation?.requiredChecks ?? "unknown"}</span>
        </TooltipTrigger>
        <TooltipPopup>
          {stateDetail}.{" "}
          {observation
            ? `CI: ${observation.checksState}. Required checks: ${observation.requiredChecks}. Observed ${new Date(observation.observedAt).toLocaleString()}`
            : "Not yet observed"}
        </TooltipPopup>
      </Tooltip>
      {observation?.checks.length ? <ActivityCheckBar checks={observation.checks} /> : null}
      {observation?.checks.length ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            CI jobs ({observation.checks.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {observation.checks.map((check) => (
              <li key={JSON.stringify(check)} className="flex items-center gap-2 text-xs">
                <CheckStatusGlyph status={check.status} />
                <span>
                  {check.name}
                  {check.description ? (
                    <span className="block text-muted-foreground">{check.description}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {watch.error ? (
        <p role="alert" className="text-destructive">
          {watch.error}
        </p>
      ) : null}
      {watch.authorization ? (
        <p>
          Automatic merge: {watch.authorization.status}
          {legacyAuthorization ? " · Revoke before handing off" : ""}
          {watch.authorization.message ? ` · ${watch.authorization.message}` : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <WatchIconAction
          label={watch.watching ? "Stop watching" : "Resume watch"}
          disabled={busy}
          onClick={() => void act(watch.watching ? "pause" : "resume")}
        >
          {watch.watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </WatchIconAction>
        <WatchIconAction
          label="Refresh pull request"
          disabled={busy}
          onClick={() => void act("refresh")}
        >
          <RefreshCwIcon className="size-3.5" />
        </WatchIconAction>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              size="xs"
              disabled={
                busy || observation?.state !== "open" || !recipient || !!legacyAuthorization
              }
              onClick={async () => {
                if (!recipient || busy) return;
                setBusy(true);
                setError(null);
                try {
                  if (!watch.managerThreadId) {
                    const assigned = await command({
                      environmentId,
                      input: {
                        requestId: randomUUID(),
                        watchId: watch.id,
                        action: "set-manager",
                        expectedBinding: watch.binding,
                        managerThreadId: recipient.id,
                      },
                    });
                    if (assigned._tag === "Failure")
                      throw new Error(formatEnvironmentQueryError(assigned.cause));
                  }
                  await steer(environmentId, recipient.id, mergeHandoffMessage(watch));
                  setSentTo(recipient.title);
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : "Could not send merge instructions.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <GitMergeIcon className="size-3.5" /> Merge when ready
            </Button>
          </TooltipTrigger>
          <TooltipPopup>
            {legacyAuthorization
              ? "Revoke the existing automatic merge authorization first"
              : recipient
                ? `Send merge instructions to ${recipient.title}`
                : "Choose a managing thread below"}
          </TooltipPopup>
        </Tooltip>
        <span className="text-xs text-muted-foreground" role="status">
          {sentTo
            ? `Sent to ${sentTo}`
            : recipient
              ? `→ ${recipient.title}`
              : "Choose a managing thread"}
        </span>
        {watch.authorization ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void act("revoke-merge")}
          >
            Revoke merge
          </Button>
        ) : null}
      </div>
      <details className="space-y-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          <MessageSquareIcon className="mr-1 inline size-3.5" />{" "}
          {recipient ? "Agent" : "Choose agent"}
        </summary>
        <div className="flex flex-wrap items-center gap-2">
          <label>
            Managing thread{" "}
            <select
              className="max-w-64 rounded border bg-background p-1"
              value={watch.managerThreadId ?? ""}
              disabled={busy}
              onChange={(event) =>
                void act("set-manager", {
                  managerThreadId: (event.target.value || null) as ThreadId | null,
                })
              }
            >
              <option value="">Unassigned</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
          </label>
          {manager ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: manager.id },
                })
              }
            >
              Open thread
            </Button>
          ) : null}
        </div>
        {manager ? (
          <p className="whitespace-pre-line text-xs text-muted-foreground">
            {describeThreadActivity(manager, managerDetail?.messages)}
          </p>
        ) : null}
        {manager ? (
          <form
            className="flex gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!text.trim() || busy) return;
              setBusy(true);
              setError(null);
              const submitted = text;
              try {
                await steer(environmentId, manager.id, submitted);
                setText((current) => (current === submitted ? "" : current));
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : "Could not send steering message.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              aria-label="Steer managing thread"
              placeholder="Steer managing thread…"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
              maxLength={8000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Button size="xs" disabled={busy || !text.trim()}>
              <SendIcon className="size-3.5" /> Send
            </Button>
          </form>
        ) : null}
      </details>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </ActivityWatchFrame>
  );
}

export function PullRequestWatchSection({
  environmentIds,
  projectIdsByEnvironment,
}: {
  environmentIds: readonly EnvironmentId[];
  projectIdsByEnvironment?: readonly {
    environmentId: EnvironmentId;
    projectIds?: readonly ProjectId[];
  }[];
}) {
  const query = usePullRequestWatches(environmentIds);
  const errors = query.errors;
  const values = query.values.map(([environmentId, snapshot]) => {
    const ids = projectIdsByEnvironment?.find(
      (scope) => scope.environmentId === environmentId,
    )?.projectIds;
    return [
      environmentId,
      {
        ...snapshot,
        watches: snapshot.watches.filter(
          (watch) =>
            !projectIdsByEnvironment ||
            (projectIdsByEnvironment.some((scope) => scope.environmentId === environmentId) &&
              (!ids || ids.includes(watch.reference.projectId))),
        ),
      },
    ] as const;
  });
  const [openHistory, setOpenHistory] = useState<ReadonlySet<EnvironmentId>>(new Set());
  return (
    <details className="rounded-lg border p-3" open>
      <summary className="cursor-pointer text-sm font-medium">
        Watched pull requests (
        {values.reduce(
          (total, [, snapshot]) =>
            total + snapshot.watches.filter((watch) => watch.watching).length,
          0,
        )}
        )
      </summary>
      <div className="mt-3 space-y-3">
        <DesktopActivityToggle />
        {[...new Set(errors)].map((error) => (
          <p role="alert" key={error} className="text-xs text-destructive">
            {error}
          </p>
        ))}
        {values.map(([environmentId, snapshot]) => (
          <div key={environmentId} className="space-y-3">
            {snapshot.watches
              .filter((watch) => watch.watching)
              .map((watch) => (
                <WatchCard key={watch.id} environmentId={environmentId} watch={watch} />
              ))}
            {snapshot.watches.some((watch) => !watch.watching) ? (
              <details
                className="rounded border p-2"
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setOpenHistory((current) => {
                    const next = new Set(current);
                    if (open) next.add(environmentId);
                    else next.delete(environmentId);
                    return next;
                  });
                }}
              >
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Watch history ({snapshot.watches.filter((watch) => !watch.watching).length})
                </summary>
                <div className="mt-2 space-y-3">
                  {(openHistory.has(environmentId) ? snapshot.watches : [])
                    .filter((watch) => !watch.watching)
                    .map((watch) => (
                      <WatchCard key={watch.id} environmentId={environmentId} watch={watch} />
                    ))}
                </div>
              </details>
            ) : null}
          </div>
        ))}
        {values.every(([, snapshot]) => snapshot.watches.every((watch) => !watch.watching)) ? (
          <p className="text-xs text-muted-foreground">
            Watch a pull request to follow checks and send instructions to its agent.
          </p>
        ) : null}
      </div>
    </details>
  );
}
