import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import {
  squireOverlapThreadLine,
  squireOverlapView,
  squireQuestionRecommendation,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES, ProjectId, UnknownUnionMember } from "@lecturn/contracts";
import type {
  EnvironmentId,
  SquireCard,
  SquireCardRow,
  SquireId,
  SquireRuleOffer,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { useClientSettings } from "../../../hooks/useSettings";
import { assistantCitationNavigation } from "../../../lib/assistantCitationNavigation";
import { cn, randomUUID } from "../../../lib/utils";
import { useProject, useProjects } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatShortTimestamp } from "../../../timestampFormat";
import {
  PullRequestDiffStat,
  PullRequestMetaLine,
} from "../../pullRequest/pullRequestPresentation";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { squireProposalScopeLabels } from "../lead/squireLead.logic";
import { SquireProposalSummary } from "../lead/SquireProposalSummary";
import { openSquireSetup } from "../setup/squireSetupStore";
import { squireChildAgeText } from "../sidebar/squireSidebar.logic";
import { SquireIndicator } from "../SquireIndicator";
import {
  SQUIRE_KIND_LABEL,
  squireAskCopy,
  squireCardActionable,
  squireCardTimeline,
  squireTimelineRows,
  squireCardCaption,
  squireCardOrigins,
  squireCardPrimaryLabel,
  squireCardRecommendation,
  squireCardSubtitle,
  squireControlText,
  squireDiffStatsLabel,
  squireEditedText,
  squireFollowUpDraft,
  squireOpenInThreadTarget,
  squirePullRequestChips,
  squireQuestionMode,
  squireRaiserLabel,
  squireQuestionRepeatsTitle,
  squireQuestionWhyFallback,
  squireSteerKindLabel,
  squireTitleBesideKind,
  squireWaitingSince,
  squireWhyText,
  type SquireChipTone,
  type SquireKnownPayload,
} from "./squireQueue.logic";
import { useSquireItemsAct } from "./squireQueueState";
import { SquireQuestionAnswer, type SquireAnswer } from "./SquireQuestionAnswer";
import {
  SquireAge,
  SquireKindDot,
  SquireMarkers,
  useSquireProvider,
  useSquireThreadShell,
} from "./SquireQueueRow";

export function commandFailureMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

const CHIP_VARIANT: Readonly<Record<SquireChipTone, "error" | "success" | "warning" | "outline">> =
  {
    failing: "error",
    passing: "success",
    pending: "warning",
    neutral: "outline",
  };

interface SquireEvidenceProps {
  readonly environmentId: EnvironmentId;
  /** The viewed queue's Squire; its revision refreshes the card. */
  readonly squireId: SquireId;
  readonly row: SquireCardRow;
  readonly raiser: SquireSnapshotEntry | null;
  readonly squireName: (squireId: SquireId) => string;
  /** After a successful accept or dismiss, with an accept's rule offer. */
  readonly onActed: (
    card: SquireCardRow,
    action: "accept" | "dismiss",
    offer: SquireRuleOffer | undefined,
  ) => void;
}

/**
 * P7.3 evidence, below the row it expands from. Its detail loads only while it is shown (R37);
 * a question card reads the thread's request from the card payload and never subscribes to the
 * thread's detail.
 */
export function SquireEvidenceBody(props: SquireEvidenceProps & { readonly inInbox: boolean }) {
  const { environmentId, row } = props;
  const detail = useEnvironmentQuery(
    squireEnvironment.item({ environmentId, input: { squireId: props.squireId, cardId: row.id } }),
  );
  const card = detail.data?.card ?? null;
  if (card === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {detail.error ?? (detail.isPending ? "Loading…" : "")}
      </p>
    );
  }
  return (
    <div data-squire-evidence={row.id} className="flex flex-col gap-2 text-sm">
      <SquireCardBody
        environmentId={environmentId}
        card={card}
        raiser={props.raiser}
        squireName={props.squireName}
        inInbox={props.inInbox}
        onActed={props.onActed}
      />
    </div>
  );
}

/** The inbox's right pane: the selected item's card with its own header and timeline. */
export function SquireEvidenceCard(props: SquireEvidenceProps) {
  const { row } = props;
  return (
    <section
      aria-label={row.title}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
    >
      <header className="flex items-center gap-2">
        <SquireKindDot kind={row.kind} />
        <span className="text-xs font-medium text-muted-foreground">
          {SQUIRE_KIND_LABEL[row.kind]}
        </span>
        <SquireAge at={squireWaitingSince(row)} prefix="waiting" />
        <SquireMarkers row={row} />
      </header>
      <h3 className="text-base font-medium text-foreground">
        {squireTitleBesideKind(row.title, row.kind)}
      </h3>
      <SquireEvidenceBody {...props} inInbox />
    </section>
  );
}

function SquireCardBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly raiser: SquireSnapshotEntry | null;
  readonly squireName: (squireId: SquireId) => string;
  /** The inbox pane has no row above it, so it names the thread and shows the timeline. */
  readonly inInbox: boolean;
  /** After a successful accept or dismiss, with an accept's rule offer. */
  readonly onActed: (
    card: SquireCardRow,
    action: "accept" | "dismiss",
    offer: SquireRuleOffer | undefined,
  ) => void;
}) {
  const { environmentId, card } = props;
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { canAct, run } = useSquireItemsAct(environmentId);
  const payload = card.payload instanceof UnknownUnionMember ? null : card.payload;
  const recommendation = payload === null ? null : squireCardRecommendation(payload);
  const primary = payload === null ? null : squireCardPrimaryLabel(payload);
  const question = payload === null ? null : squireQuestionMode(payload);
  const questionRecommendation =
    payload === null ? null : squireQuestionRecommendation(payload, card.title);
  // Kept across server updates, so a newer recommendation never overwrites an edit (P7.6).
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionable = squireCardActionable(card);
  const steerKind = squireSteerKindLabel(card.steerKind);
  const caption = squireCardCaption(card, props.raiser, (iso) =>
    formatShortTimestamp(iso, timestampFormat),
  );
  const target = squireOpenInThreadTarget(environmentId, card);
  const timeline = props.inInbox
    ? squireTimelineRows(
        squireCardTimeline(card),
        (iso) => formatShortTimestamp(iso, timestampFormat),
        props.raiser === null
          ? props.squireName(card.squireId)
          : squireRaiserLabel(props.raiser.squire),
      )
    : [];
  const [asking, setAsking] = useState(false);
  const timelineLabelId = useId();

  const act = async (
    action: "accept" | "dismiss",
    extra: { readonly text?: string | undefined; readonly answer?: SquireAnswer } = {},
  ) => {
    setBusy(true);
    setError(null);
    const result = await run([card.id], action, extra);
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(commandFailureMessage(result, "The item could not be updated. Try again."));
      }
      return false;
    }
    const outcome = result.value.results.find((entry) => entry.cardId === card.id);
    if (outcome?.error) {
      setError(outcome.error.message);
      return false;
    }
    setDraft(null);
    props.onActed(card, action, outcome?.ruleOffer);
    return true;
  };

  const openInThread = () => {
    if (target === null) return;
    void navigate(
      target.type === "citation"
        ? assistantCitationNavigation(target.citation)
        : { to: "/$environmentId/$threadId", params: { environmentId, threadId: target.threadId } },
    );
  };

  const followUp = () => {
    if (payload?.type !== "question") return;
    const ref = scopeThreadRef(environmentId, payload.threadId);
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      ref,
      squireFollowUpDraft(payload.question, store.getComposerDraft(ref)?.prompt ?? ""),
    );
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: payload.threadId },
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SquireCardTarget
          environmentId={environmentId}
          card={card}
          payload={payload}
          squireName={props.squireName}
          showSubtitle={props.inInbox}
        />
        <SquireCardChips
          environmentId={environmentId}
          card={card}
          steerKind={props.inInbox ? steerKind : null}
          squireName={props.squireName}
        />
      </div>
      <SquireCardEvidence card={card} />
      {/* A question's recommendation and evidence come before its options, so they inform the answer. */}
      {payload?.type === "question" ? (
        <SquireWhy environmentId={environmentId} card={card} waitingFallback />
      ) : null}
      {payload?.type === "question" ? (
        <div className="flex flex-col gap-2">
          {question?.type === "user-input" ||
          squireQuestionRepeatsTitle(payload.question, card.title) ? null : (
            <p className="whitespace-pre-wrap text-foreground/90">{payload.question}</p>
          )}
          {questionRecommendation === null ? null : (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Recommended</span>
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
                {questionRecommendation}
              </p>
            </div>
          )}
          {question?.type === "approval" || question?.type === "user-input" ? (
            actionable && canAct ? (
              <SquireQuestionAnswer
                environmentId={environmentId}
                payload={payload}
                title={card.title}
                disabled={busy}
                onAnswer={(answer) => act("accept", { answer })}
              />
            ) : null
          ) : question?.type === "secret" ? (
            <p className="text-xs text-muted-foreground">
              Secrets are entered in the thread's own prompt, never through a card.
            </p>
          ) : question?.type === "in-thread" ? (
            <p className="text-xs text-muted-foreground">{question.reason}</p>
          ) : null}
        </div>
      ) : payload?.type === "squire-proposal" ? (
        <SquireProposalSummary environmentId={environmentId} proposal={payload} />
      ) : payload?.type === "overlap" ? (
        <SquireOverlapEvidence environmentId={environmentId} payload={payload} />
      ) : payload?.type === "control" ? (
        <p className="rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
          {squireControlText(payload, props.squireName, card.why)}
        </p>
      ) : recommendation === null ? null : (
        // A steer or first prompt is the Squire's recommendation, labelled as a question's is;
        // an FYI's text is only news.
        <div className="flex flex-col gap-1">
          {recommendation.editable ? (
            <span className="text-xs font-medium text-muted-foreground">Recommended</span>
          ) : null}
          {draft !== null && recommendation.editable ? (
            <Textarea
              aria-label="Recommendation"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          ) : (
            <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
              {recommendation.text}
            </p>
          )}
        </div>
      )}
      {/* A control proposal's reason is already part of its one line. */}
      {payload?.type === "question" || payload?.type === "control" ? null : (
        <SquireWhy environmentId={environmentId} card={card} waitingFallback={false} />
      )}
      {caption === null ? null : <p className="text-xs text-muted-foreground">{caption}</p>}
      {timeline.length > 0 ? (
        <section
          aria-labelledby={timelineLabelId}
          className="flex flex-col gap-1 border-t border-border/60 pt-2"
        >
          <h4 id={timelineLabelId} className="text-xs font-medium text-muted-foreground">
            Timeline
          </h4>
          <ol className="flex flex-col gap-0.5 text-xs">
            {timeline.map((row) => (
              <li key={row.key} className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground tabular-nums">{row.time}</span>
                <span aria-hidden className="text-muted-foreground">
                  ·
                </span>
                <span className="min-w-0 text-foreground/85">{row.text}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      {/* Sticky, so a tall card's actions stay in reach in the queue's scroll area. */}
      <div className="sticky bottom-0 z-10 -mx-3 flex flex-wrap items-center gap-1.5 border-t border-border bg-card px-3 py-1.5">
        {actionable && canAct && primary !== null ? (
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void act("accept", {
                text:
                  recommendation === null
                    ? undefined
                    : squireEditedText(recommendation.text, draft),
              })
            }
          >
            {primary}
          </Button>
        ) : null}
        {actionable && canAct && recommendation?.editable ? (
          <Button
            size="xs"
            variant="outline"
            aria-pressed={draft !== null}
            onClick={() => setDraft(draft === null ? recommendation.text : null)}
          >
            {draft === null ? "Edit" : "Cancel edit"}
          </Button>
        ) : null}
        {actionable && canAct && payload?.type === "squire-proposal" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openSquireSetup({
                kind: "proposal",
                environmentId,
                cardId: card.id,
                proposal: payload,
              })
            }
          >
            Edit
          </Button>
        ) : null}
        {canAct && (actionable || card.status === "outdated") ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act("dismiss")}>
            Dismiss
          </Button>
        ) : null}
        <span className="flex-1" />
        {card.targetThreadId === null ? null : (
          <SquireAskButton
            environmentId={environmentId}
            card={card}
            open={asking}
            onOpen={() => setAsking(true)}
          />
        )}
        {payload?.type === "question" ? (
          <Button size="xs" variant="ghost" onClick={followUp}>
            Follow up in thread
            <ArrowUpRightIcon />
          </Button>
        ) : null}
        {target === null ? null : (
          <Button size="xs" variant="ghost" onClick={openInThread}>
            Open in thread
            <ArrowUpRightIcon />
          </Button>
        )}
      </div>
      {card.targetThreadId === null ? null : (
        <SquireAsk
          environmentId={environmentId}
          card={card}
          open={asking}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}

function SquireCardTarget(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly payload: SquireKnownPayload | null;
  readonly squireName: (squireId: SquireId) => string;
  /** The inbox pane has no row above it, so it names what the card is about. */
  readonly showSubtitle: boolean;
}) {
  const { environmentId, card, payload } = props;
  const shell = useSquireThreadShell(environmentId, card.targetThreadId);
  // An overlap's repository is a project id when its threads share one (the server's identity).
  const projectId =
    card.projectId ??
    (payload?.type === "thread-proposal"
      ? payload.projectId
      : payload?.type === "overlap"
        ? ProjectId.make(payload.repository)
        : null);
  const project = useProject(
    props.showSubtitle && card.targetThreadId === null && projectId !== null
      ? scopeProjectRef(environmentId, projectId)
      : null,
  );
  const provider = useSquireProvider(environmentId, shell?.providerInstanceId);
  const branch = card.evidence.headBranch ?? shell?.branch ?? null;
  const stats = card.evidence.diffStats;
  const subtitle = props.showSubtitle
    ? squireCardSubtitle(card, payload, {
        threadTitle: shell?.title ?? null,
        provider: provider?.name ?? null,
        projectTitle: project?.title ?? null,
        proposalScope: null,
        squireName: props.squireName,
      })
    : [];
  const segments = [
    ...(payload?.type === "squire-proposal" && props.showSubtitle
      ? [
          <SquireProposalSubtitle
            key="subtitle"
            environmentId={environmentId}
            payload={payload}
            squireName={props.squireName}
          />,
        ]
      : subtitle.map((text, index) => (
          <span
            key={`subtitle:${text}`}
            className={index === 0 ? "min-w-0 truncate text-foreground/90" : undefined}
          >
            {text}
          </span>
        ))),
    branch === null ? null : (
      <span key="branch" className="min-w-0 truncate font-mono">
        {branch}
      </span>
    ),
    stats === undefined ? null : (
      <span key="diff" className="inline-flex items-baseline gap-1">
        <PullRequestDiffStat additions={stats.insertions} deletions={stats.deletions} />
        <span>{squireDiffStatsLabel(stats)}</span>
      </span>
    ),
  ].filter((segment) => segment !== null);
  if (segments.length === 0) return null;
  return (
    <PullRequestMetaLine className="min-w-0 flex-wrap text-xs text-muted-foreground">
      {segments}
    </PullRequestMetaLine>
  );
}

/** "New Squire · <scope>": only a Squire proposal reads every project, to name its scope. */
function SquireProposalSubtitle(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: Extract<SquireKnownPayload, { readonly type: "squire-proposal" }>;
  readonly squireName: (squireId: SquireId) => string;
}) {
  const { environmentId, payload } = props;
  const projects = useProjects();
  const scope = squireProposalScopeLabels(payload.grants, {
    project: (projectId) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
    thread: () => null,
  });
  const text = squireCardSubtitle({ targetThreadId: null }, payload, {
    threadTitle: null,
    provider: null,
    projectTitle: null,
    proposalScope: scope.length === 0 ? null : scope.join(" · "),
    squireName: props.squireName,
  }).join(" · ");
  return <span className="min-w-0 truncate text-foreground/90">{text}</span>;
}

/** PR chips, then the steer kind and origin labels, on the card's one meta line. */
function SquireCardChips(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly steerKind: string | null;
  readonly squireName: (squireId: SquireId) => string;
}) {
  const { card } = props;
  // Rules are read only for a card a rule changed, to name it exactly.
  const rules = useEnvironmentQuery(
    card.ruleId === null
      ? null
      : squireEnvironment.rules({
          environmentId: props.environmentId,
          input: { squireId: card.squireId },
        }),
  );
  const labels = squireCardOrigins(card, rules.data?.rules ?? [], {
    squireName: props.squireName,
    targetName: (rule) => rule.targetId,
  });
  const pr = card.evidence.pullRequest;
  const chips = pr === undefined ? [] : squirePullRequestChips(pr);
  if (labels.length === 0 && props.steerKind === null && chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {pr === undefined ? null : (
        <span className="text-xs text-muted-foreground">#{pr.number}</span>
      )}
      {chips.map((chip) => (
        <Badge key={chip.key} size="sm" variant={CHIP_VARIANT[chip.tone]}>
          {chip.label}
        </Badge>
      ))}
      {props.steerKind === null ? null : (
        <Badge size="sm" variant="outline">
          {props.steerKind}
        </Badge>
      )}
      {labels.map((label) => (
        <Badge key={label} size="sm" variant="secondary">
          {label}
        </Badge>
      ))}
    </div>
  );
}

function SquireCardEvidence(props: { readonly card: SquireCard }) {
  const { evidence } = props.card;
  const errorLines = evidence.errorLines ?? [];
  if (errorLines.length === 0 && evidence.ciLog?.status !== "unavailable") return null;
  return (
    <div className="flex flex-col gap-1">
      {errorLines.length === 0 ? null : (
        <pre className="overflow-x-auto rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-foreground/85">
          {errorLines.join("\n")}
        </pre>
      )}
      {evidence.ciLog?.status === "unavailable" ? (
        <p className="text-xs text-muted-foreground">
          The failing job's log could not be read
          {evidence.ciLog.jobs.length === 0
            ? "."
            : `; see ${evidence.ciLog.jobs.map((job) => job.name).join(", ")}.`}
        </p>
      ) : null}
    </div>
  );
}

function SquireWhy(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  /** P7.3: a question always says why it is here, at least how long it has waited. */
  readonly waitingFallback: boolean;
}) {
  const { card } = props;
  const shell = useSquireThreadShell(props.environmentId, card.targetThreadId);
  const quote = card.evidence.triggerText ?? card.trigger.quote ?? null;
  const why = squireWhyText(card.why, { title: card.title, threadTitle: shell?.title ?? null });
  if (why === "" && quote === null) {
    return props.waitingFallback ? (
      <SquireWaitingWhy environmentId={props.environmentId} card={card} />
    ) : null;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">Why</span>
      {why === "" ? null : <p className="text-foreground/85">{why}</p>}
      {quote === null ? null : (
        <blockquote className="border-l-2 border-border pl-2.5 text-xs text-muted-foreground whitespace-pre-wrap">
          {quote}
        </blockquote>
      )}
    </div>
  );
}

function SquireWaitingWhy(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
}) {
  const shell = useSquireThreadShell(props.environmentId, props.card.targetThreadId);
  const age = squireChildAgeText(useRelativeTimeState(squireWaitingSince(props.card)));
  return (
    <p className="text-xs text-muted-foreground">
      {squireQuestionWhyFallback(shell?.title ?? null, age)}
    </p>
  );
}

type OverlapPayload = Extract<SquireKnownPayload, { readonly type: "overlap" }>;

/** P17.3: both threads with their owners, the shared files, and the order to land them. */
function SquireOverlapEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: OverlapPayload;
}) {
  const { environmentId, payload } = props;
  const [showAllPaths, setShowAllPaths] = useState(false);
  const view = squireOverlapView(payload, { showAllPaths });
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Threads" className="flex flex-col gap-1">
        {payload.threads.map((thread) => (
          <SquireOverlapThread
            key={thread.threadId}
            environmentId={environmentId}
            thread={thread}
          />
        ))}
      </ul>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {payload.paths.length === 1 ? "Shared file" : `${payload.paths.length} shared files`}
        </span>
        <ul className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground/85">
          {view.shownPaths.map((path) => (
            <li key={path} className="break-all">
              {path}
            </li>
          ))}
        </ul>
        {view.moreLabel === null && !showAllPaths ? null : (
          <div>
            <Button size="xs" variant="ghost" onClick={() => setShowAllPaths(!showAllPaths)}>
              {showAllPaths ? "Show fewer" : view.moreLabel}
            </Button>
          </div>
        )}
      </div>
      {view.recommendation === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Recommended order</span>
          <p className="rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
            {view.recommendation}
          </p>
        </div>
      )}
    </div>
  );
}

function SquireOverlapThread(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OverlapPayload["threads"][number];
}) {
  const { environmentId, thread } = props;
  const navigate = useNavigate();
  const state = useSquireEnvironmentState(environmentId);
  const owner = state?.squires.find((entry) => entry.squire.id === thread.squireId) ?? null;
  const shell = useSquireThreadShell(environmentId, thread.threadId);
  const instance = useSquireProvider(environmentId, shell?.providerInstanceId);
  // The payload's branch is the one seen at detection; the thread's own fills a gap.
  const line = squireOverlapThreadLine(
    { ...thread, branch: thread.branch ?? shell?.branch ?? null },
    {
      title: shell?.title ?? null,
      instanceName: instance?.name ?? null,
      driverName: (driver) => PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES],
    },
  );
  return (
    <li className="flex min-w-0 items-center gap-2">
      {owner === null ? null : (
        // Names the owner, so full color like a row's raiser portrait.
        <SquireIndicator
          state="waiting"
          palette={owner.squire.companion.palette}
          presence={owner.squire.companion.presence}
          appearance={owner.squire.companion.appearance}
          hood={owner.squire.companion.hood}
          isLead={owner.squire.role === "lead"}
          size={22}
          label={`Tracked by ${owner.squire.name}`}
        />
      )}
      <PullRequestMetaLine className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate text-sm text-foreground/90">{line.label}</span>
        <span>{line.provider}</span>
        {line.branch === null ? null : (
          <span className="min-w-0 truncate font-mono">{line.branch}</span>
        )}
        {line.pullRequest === null ? null : <span>{line.pullRequest}</span>}
      </PullRequestMetaLine>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Open ${line.label}`}
        title="Open in thread"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.threadId },
          })
        }
      >
        <ArrowUpRightIcon />
      </Button>
    </li>
  );
}

/** P7.5's entry, in the card's action row beside its other ways into the thread. */
function SquireAskButton(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly open: boolean;
  readonly onOpen: () => void;
}) {
  const canAsk = useAtomValue(squireEnvironment.itemAsk.permissionAtom(props.environmentId));
  if (!canAsk || props.open) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={props.card.ask?.status === "running"}
      onClick={props.onOpen}
    >
      Ask about this
    </Button>
  );
}

/** P7.5: the last answer, and while open the question form, below the action row. */
function SquireAsk(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, card } = props;
  const canAsk = useAtomValue(squireEnvironment.itemAsk.permissionAtom(environmentId));
  const ask = useAtomCommand(squireEnvironment.itemAsk, { reportFailure: false });
  const shell = useSquireThreadShell(environmentId, card.targetThreadId);
  const provider = useSquireProvider(environmentId, shell?.providerInstanceId);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = card.ask;
  if (!canAsk || (current === null && !props.open)) return null;
  const running = current?.status === "running";

  const send = async () => {
    const text = question.trim();
    if (text === "") return;
    setSending(true);
    setError(null);
    const result = await ask({
      environmentId,
      input: { requestId: randomUUID(), cardId: card.id, question: text },
    });
    setSending(false);
    if (result._tag === "Success") {
      setQuestion("");
      return;
    }
    // The server decides whether the provider may probe (`probeSupport`), so its refusal,
    // such as "Ask is not available for Cursor", is what the user sees.
    if (isAtomCommandInterrupted(result)) return;
    const message = commandFailureMessage(result, "The question could not be sent. Try again.");
    setError(message);
  };

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      {current === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{current.question}</span>
          <p
            className={cn(
              "whitespace-pre-wrap",
              current.status === "failed" ? "text-destructive-foreground" : "text-foreground/90",
            )}
          >
            {current.status === "running"
              ? "Asking…"
              : current.status === "failed"
                ? (current.error ?? "The question could not be answered.")
                : (current.answer ?? "")}
          </p>
        </div>
      )}
      {props.open ? (
        <>
          <p className="text-xs text-muted-foreground">{squireAskCopy(provider)}</p>
          <Textarea
            aria-label="Ask about this"
            value={question}
            autoFocus
            onChange={(event) => setQuestion(event.currentTarget.value)}
          />
          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={sending || running || question.trim() === ""}
              onClick={() => void send()}
            >
              Ask
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
