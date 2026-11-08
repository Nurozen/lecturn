import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import { isAtomCommandInterrupted } from "@lecturn/client-runtime/state/runtime";
import {
  runSquireAlwaysAllow,
  squireAllowRuleInput,
  squireApprovalControls,
  squireCardCaption,
  squireCardOrigins,
  squireControlText,
  squireDiffStatsLabel,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireOverlapThreadLine,
  squireOverlapView,
  squirePullRequestChips,
  squireQuestionRecommendation,
  squireQuestionRepeatsTitle,
  squireQuestionWhyFallback,
  squireWaitingSince,
  squireWhyText,
  type SquireApprovalEntry,
  type SquireApprovalResult,
  type SquireChipTone,
  type SquireKnownPayload,
} from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES, UnknownUnionMember } from "@lecturn/contracts";
import type {
  EnvironmentId,
  ProviderInstanceId,
  SquireCard,
  SquireCardRow,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { memo, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { useClientSettings } from "../../../hooks/useSettings";
import { assistantCitationNavigation } from "../../../lib/assistantCitationNavigation";
import { randomUUID } from "../../../lib/utils";
import { useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentProviders } from "../../../state/environments";
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
import { SquireProposalSummary } from "../lead/SquireProposalSummary";
import { openSquireSetup } from "../setup/squireSetupStore";
import { squireChildAgeText } from "../sidebar/squireSidebar.logic";
import { SquireIndicator } from "../SquireIndicator";
import { commandFailureMessage } from "../squireCommandFailure";
import {
  useSquireApprovalRuleSaved,
  useSquireItemsAct,
  useSquireMarkOpened,
} from "./squireApprovalsState";
import {
  squireCardRecommendation,
  squireOpenInThreadTarget,
  squireQuestionMode,
  squireSteerKindLabel,
} from "./squireCard.logic";
import { SquireQuestionAnswer, type SquireAnswer } from "./SquireQuestionAnswer";

const CHIP_VARIANT: Readonly<Record<SquireChipTone, "error" | "success" | "warning" | "outline">> =
  {
    failing: "error",
    passing: "success",
    pending: "warning",
    neutral: "outline",
  };

const useThreadShell = (environmentId: EnvironmentId, threadId: ThreadId | null) =>
  useQuietThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId));

function useProviderName(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null | undefined,
) {
  const providers = useEnvironmentProviders().get(environmentId);
  const provider =
    instanceId == null ? undefined : providers?.find((p) => p.instanceId === instanceId);
  return provider === undefined ? null : resolveProviderInstanceDisplayName(provider);
}

/**
 * An approval, question, or overlap at its place in a Squire's chat, with its full text in
 * view. Its detail loads when the row mounts, and the timeline mounts only what is on screen.
 */
export const SquireApprovalRow = memo(function SquireApprovalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly viewSquireId: SquireId;
  readonly entry: SquireApprovalEntry<SquireCardRow>;
}) {
  const { environmentId, viewSquireId, entry } = props;
  const { row } = entry;
  const detail = useEnvironmentQuery(
    squireEnvironment.item({ environmentId, input: { squireId: viewSquireId, cardId: row.id } }),
  );
  const card = detail.data?.card ?? null;
  const age = squireChildAgeText(useRelativeTimeState(squireWaitingSince(row)));
  useSquireMarkOpened(environmentId, entry.phase === "open" ? row.id : null, row.openedAt);
  return (
    <section
      aria-label={row.title}
      data-squire-card={row.id}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm"
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <h3 className="min-w-0 flex-1 font-medium text-foreground">{row.title}</h3>
        {age === "" ? null : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{age}</span>
        )}
      </header>
      {card === null ? (
        <p className="text-xs text-muted-foreground">
          {detail.error ?? (detail.isPending ? "Loading…" : "")}
        </p>
      ) : (
        <SquireApprovalBody environmentId={environmentId} entry={entry} card={card} />
      )}
      {card === null ? null : (
        <SquireApprovalActions environmentId={environmentId} entry={entry} card={card} />
      )}
    </section>
  );
});

function payloadOf(card: SquireCard): SquireKnownPayload | null {
  return card.payload instanceof UnknownUnionMember ? null : card.payload;
}

function SquireApprovalBody(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireApprovalEntry<SquireCardRow>;
  readonly card: SquireCard;
}) {
  const { environmentId, entry, card } = props;
  const payload = payloadOf(card);
  const state = useSquireEnvironmentState(environmentId);
  const squires = state?.squires ?? [];
  const entryOf = (id: SquireId) => squires.find((candidate) => candidate.squire.id === id) ?? null;
  const squireName = (id: SquireId) => entryOf(id)?.squire.name ?? "A Squire";
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const caption = squireCardCaption(card, entryOf(card.squireId), (iso) =>
    formatShortTimestamp(iso, timestampFormat),
  );
  const recommendation = payload === null ? null : squireCardRecommendation(payload);
  return (
    <div className="flex flex-col gap-2">
      <SquireApprovalMeta environmentId={environmentId} card={card} squireName={squireName} />
      <SquireErrorEvidence card={card} />
      {payload?.type === "question" ? (
        <SquireQuestionBody environmentId={environmentId} card={card} payload={payload} />
      ) : payload?.type === "squire-proposal" ? (
        <SquireProposalSummary environmentId={environmentId} proposal={payload} />
      ) : payload?.type === "overlap" ? (
        <SquireOverlapEvidence environmentId={environmentId} payload={payload} />
      ) : payload?.type === "control" ? (
        <p className="rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
          {squireControlText(payload, squireName, card.why)}
        </p>
      ) : recommendation === null ? null : (
        <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
          {recommendation}
        </p>
      )}
      {payload?.type === "question" || payload?.type === "control" ? null : (
        <SquireWhy environmentId={environmentId} card={card} waitingFallback={false} />
      )}
      {entry.phase === "open" && caption !== null ? (
        <p className="text-xs text-muted-foreground">{caption}</p>
      ) : null}
    </div>
  );
}

function SquireApprovalMeta(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly squireName: (squireId: SquireId) => string;
}) {
  const { environmentId, card } = props;
  const shell = useThreadShell(environmentId, card.targetThreadId);
  const provider = useProviderName(environmentId, shell?.providerInstanceId);
  const rules = useEnvironmentQuery(
    card.ruleId === null
      ? null
      : squireEnvironment.rules({ environmentId, input: { squireId: card.squireId } }),
  );
  const labels = squireCardOrigins(card, rules.data?.rules ?? [], {
    squireName: props.squireName,
    targetName: (rule) => rule.targetId,
  });
  const pr = card.evidence.pullRequest;
  const chips = pr === undefined ? [] : squirePullRequestChips(pr);
  const steerKind = squireSteerKindLabel(card.steerKind);
  const branch = card.evidence.headBranch ?? shell?.branch ?? null;
  const stats = card.evidence.diffStats;
  const line = [
    shell === null ? null : (
      <span key="thread" className="min-w-0 truncate text-foreground/90">
        {shell.title}
      </span>
    ),
    provider === null ? null : <span key="provider">{provider}</span>,
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
  if (line.length === 0 && labels.length === 0 && steerKind === null && chips.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {line.length === 0 ? null : (
        <PullRequestMetaLine className="min-w-0 flex-wrap text-xs text-muted-foreground">
          {line}
        </PullRequestMetaLine>
      )}
      {pr === undefined ? null : (
        <span className="text-xs text-muted-foreground">#{pr.number}</span>
      )}
      {chips.map((chip) => (
        <Badge key={chip.key} size="sm" variant={CHIP_VARIANT[chip.tone]}>
          {chip.label}
        </Badge>
      ))}
      {steerKind === null ? null : (
        <Badge size="sm" variant="outline">
          {steerKind}
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

function SquireErrorEvidence(props: { readonly card: SquireCard }) {
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
  readonly waitingFallback: boolean;
}) {
  const { card } = props;
  const shell = useThreadShell(props.environmentId, card.targetThreadId);
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
        <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
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
  const shell = useThreadShell(props.environmentId, props.card.targetThreadId);
  const age = squireChildAgeText(useRelativeTimeState(squireWaitingSince(props.card)));
  return (
    <p className="text-xs text-muted-foreground">
      {squireQuestionWhyFallback(shell?.title ?? null, age)}
    </p>
  );
}

type QuestionPayload = Extract<SquireKnownPayload, { readonly type: "question" }>;
type OverlapPayload = Extract<SquireKnownPayload, { readonly type: "overlap" }>;

function SquireQuestionBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly payload: QuestionPayload;
}) {
  const { environmentId, card, payload } = props;
  const question = squireQuestionMode(payload);
  const recommendation = squireQuestionRecommendation(payload, card.title);
  return (
    <>
      <SquireWhy environmentId={environmentId} card={card} waitingFallback />
      <div className="flex flex-col gap-2">
        {question?.type === "user-input" ||
        squireQuestionRepeatsTitle(payload.question, card.title) ? null : (
          <p className="whitespace-pre-wrap text-foreground/90">{payload.question}</p>
        )}
        {recommendation === null ? null : (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Recommended</span>
            <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2.5 py-2 text-foreground/90">
              {recommendation}
            </p>
          </div>
        )}
        {question?.type === "secret" ? (
          <p className="text-xs text-muted-foreground">
            Secrets are entered in the thread's own prompt, never through a card.
          </p>
        ) : question?.type === "in-thread" ? (
          <p className="text-xs text-muted-foreground">{question.reason}</p>
        ) : null}
      </div>
    </>
  );
}

/** Both threads with their owners, the shared files, and the order to land them. */
function SquireOverlapEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: OverlapPayload;
}) {
  const { environmentId, payload } = props;
  const view = squireOverlapView(payload, { showAllPaths: true });
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
  const shell = useThreadShell(environmentId, thread.threadId);
  const instanceName = useProviderName(environmentId, shell?.providerInstanceId);
  const line = squireOverlapThreadLine(
    { ...thread, branch: thread.branch ?? shell?.branch ?? null },
    {
      title: shell?.title ?? null,
      instanceName,
      driverName: (driver) => PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES],
    },
  );
  return (
    <li className="flex min-w-0 items-center gap-2">
      {owner === null ? null : (
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

function SquireApprovalActions(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireApprovalEntry<SquireCardRow>;
  readonly card: SquireCard;
}) {
  const { environmentId, entry, card } = props;
  const { row } = entry;
  const payload = payloadOf(card);
  const navigate = useNavigate();
  const { canAct, run } = useSquireItemsAct(environmentId);
  const canSaveRule = useAtomValue(squireEnvironment.ruleCreate.permissionAtom(environmentId));
  const createRule = useAtomCommand(squireEnvironment.ruleCreate, { reportFailure: false });
  const [ruleSaved, setRuleSaved] = useSquireApprovalRuleSaved(environmentId, row.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controls = squireApprovalControls(entry, payload);
  const question = payload === null ? null : squireQuestionMode(payload);
  const target = squireOpenInThreadTarget(environmentId, card);
  const answerable =
    entry.phase === "open" &&
    canAct &&
    payload?.type === "question" &&
    (question?.type === "approval" || question?.type === "user-input");

  const decide = async (
    action: "accept" | "dismiss",
    extra: { readonly answer?: SquireAnswer } = {},
  ): Promise<SquireApprovalResult> => {
    const result = await run([row.id], action, extra);
    if (result._tag === "Failure") {
      return isAtomCommandInterrupted(result)
        ? { ok: false, error: "" }
        : {
            ok: false,
            error: commandFailureMessage(result, "The item could not be updated. Try again."),
          };
    }
    const outcome = result.value.results.find((candidate) => candidate.cardId === row.id);
    return outcome?.error ? { ok: false, error: outcome.error.message } : { ok: true };
  };
  const saveRule = async (
    input: NonNullable<ReturnType<typeof squireAllowRuleInput>>,
  ): Promise<SquireApprovalResult> => {
    const result = await createRule({
      environmentId,
      input: { requestId: randomUUID(), ...input },
    });
    if (result._tag === "Success") return { ok: true };
    return {
      ok: false,
      error: commandFailureMessage(result, "The rule could not be saved. Try again."),
    };
  };
  const press = async (work: () => Promise<SquireApprovalResult>) => {
    setBusy(true);
    setError(null);
    const result = await work();
    setBusy(false);
    if (!result.ok && result.error !== "") setError(result.error);
    return result.ok;
  };
  const alwaysAllow = async () => {
    const saved = await press(() =>
      runSquireAlwaysAllow(row, { accept: () => decide("accept"), saveRule }),
    );
    if (saved) setRuleSaved(true);
  };
  const allowNextTime = async () => {
    const input = squireAllowRuleInput(row);
    if (input === null) return;
    const saved = await press(() => saveRule(input));
    if (saved) setRuleSaved(true);
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

  const offerText = row.allowRuleOffer?.text;
  const status = entry.phase === "sending" ? "Sending…" : entry.outcome;

  return (
    <div className="flex flex-col gap-2">
      {answerable && payload?.type === "question" ? (
        <SquireQuestionAnswer
          environmentId={environmentId}
          payload={payload}
          title={card.title}
          disabled={busy}
          onAnswer={(answer) => press(() => decide("accept", { answer }))}
        />
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {status === null ? null : <span className="text-xs text-muted-foreground">{status}</span>}
        {ruleSaved ? (
          <Badge size="sm" variant="secondary">
            Saved to rules
          </Badge>
        ) : null}
        {controls.allow !== null && canAct ? (
          <Button size="xs" disabled={busy} onClick={() => void press(() => decide("accept"))}>
            {controls.allow}
          </Button>
        ) : null}
        {controls.alwaysAllow && canAct && canSaveRule ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            title={offerText}
            onClick={() => void alwaysAllow()}
          >
            Always allow
          </Button>
        ) : null}
        {entry.phase === "open" && payload?.type === "squire-proposal" && canAct ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
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
        {controls.deny !== null && canAct ? (
          <Button
            size="xs"
            variant={controls.deny === "Deny" ? "outline" : "ghost"}
            disabled={busy}
            onClick={() => void press(() => decide("dismiss"))}
          >
            {controls.deny}
          </Button>
        ) : null}
        {controls.inactivity && canAct ? (
          <>
            <Button size="xs" disabled={busy} onClick={() => void press(() => decide("accept"))}>
              Keep
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void press(() => decide("dismiss"))}
            >
              Pause
            </Button>
          </>
        ) : null}
        {controls.allowNextTime && canSaveRule && !ruleSaved ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            title={offerText}
            onClick={() => void allowNextTime()}
          >
            Always allow next time
          </Button>
        ) : null}
        <span className="flex-1" />
        {payload !== null && squireOffersFollowUp(payload) ? (
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
    </div>
  );
}
