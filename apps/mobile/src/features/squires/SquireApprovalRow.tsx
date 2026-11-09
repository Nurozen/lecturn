import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import {
  runSquireAlwaysAllow,
  squireAllowRuleInput,
  squireOverlapThreadLine,
  squireOverlapView,
  squireQuestionRecommendation,
  type SquireApprovalEntry,
  type SquireApprovalResult,
} from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES, UnknownUnionMember } from "@lecturn/contracts";
import type { EnvironmentId, SquireCard, SquireCardRow, ThreadId } from "@lecturn/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useProject, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { RequestActionButton } from "../threads/RequestActionButton";
import { useOpenThreadOverPage } from "../workspace/useOpenThreadOverPage";
import {
  SquireCiEvidence,
  SquireControlEvidence,
  SquireEvidenceMeta,
  SquireProposalEvidence,
  SquireSectionLabel,
} from "./SquireEvidence";
import {
  SQUIRE_KIND_LABEL,
  squireChatControls,
  squireCardRecommendation,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireQuestionMode,
  squireQuestionRepeatsTitle,
  type SquireAnswer,
  type SquireChatControls,
} from "./squireApproval.logic";
import {
  squireSavedRuleCardsAtom,
  useSquireItemsAct,
  useSquireMarkOpened,
} from "./squireApprovalState";
import { squireRowMetaText, squireRowTargetName, squireWhyText } from "./squireEvidence.logic";
import { SquireQuestionAnswer } from "./SquireQuestionAnswer";

type ActExtra = { readonly answer?: SquireAnswer };

const ACT_FAILED = "The item could not be updated. Try again.";

function markRuleSaved(row: SquireCardRow) {
  appAtomRegistry.update(squireSavedRuleCardsAtom, (saved) => new Set(saved).add(row.id));
}

/**
 * An approval, question, or overlap in the Squire's chat, at the moment it was raised. Rows stay
 * after they close so the conversation keeps its history; the card body is read per row.
 */
export function SquireApprovalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireApprovalEntry<SquireCardRow>;
}) {
  const { environmentId, entry } = props;
  const { row, phase } = entry;
  // Seeing an open row is what opening a card used to be: it cancels the phone escalation.
  useSquireMarkOpened(environmentId, phase === "open" ? row.id : null, row.openedAt);
  const detail = useEnvironmentQuery(
    squireEnvironment.item({
      environmentId,
      input: { squireId: row.ownerSquireId, cardId: row.id },
    }),
  );
  const card = detail.data?.card ?? null;
  const target = useQuietThreadShell(
    row.targetThreadId === null ? null : scopeThreadRef(environmentId, row.targetThreadId),
  );
  const project = useProject(
    row.targetThreadId === null && row.projectId !== null
      ? scopeProjectRef(environmentId, row.projectId)
      : null,
  );
  const { canAct, run } = useSquireItemsAct(environmentId);
  const canSaveRule = useAtomValue(squireEnvironment.ruleCreate.permissionAtom(environmentId));
  const saved = useAtomValue(squireSavedRuleCardsAtom).has(row.id);
  const createRule = useAtomCommand(squireEnvironment.ruleCreate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  // Set once the server took the act, until the refetched row agrees.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const payload = card === null || card.payload instanceof UnknownUnionMember ? null : card.payload;
  const controls = squireChatControls({
    entry,
    payload,
    canAct,
    canSaveRule,
    ruleSaved: saved,
  });

  const act = async (action: "accept" | "dismiss", extra: ActExtra = {}) => {
    setBusy(true);
    setError(null);
    const outcome = await run([row.id], action, extra);
    setBusy(false);
    if (outcome === null) return false;
    if (!outcome.ok) {
      setError(outcome.error);
      return false;
    }
    setPending(action === "accept" ? "Sending…" : "Updating…");
    return true;
  };

  const accept = async (): Promise<SquireApprovalResult> => {
    const outcome = await run([row.id], "accept");
    if (outcome === null) return { ok: false, error: ACT_FAILED };
    return outcome.ok ? { ok: true } : { ok: false, error: outcome.error };
  };

  const saveRule = async (): Promise<SquireApprovalResult> => {
    const input = squireAllowRuleInput(row);
    if (input === null) return { ok: false, error: "This approval cannot become a rule." };
    const result = await createRule({
      environmentId,
      input: { requestId: uuidv4(), ...input },
    });
    if (result._tag === "Success") return { ok: true };
    if (isAtomCommandInterrupted(result)) return { ok: false, error: ACT_FAILED };
    const failure = squashAtomCommandFailure(result);
    return {
      ok: false,
      error:
        failure instanceof Error && failure.message.trim() !== ""
          ? failure.message
          : "The rule could not be saved. Try again.",
    };
  };

  const alwaysAllow = async () => {
    setBusy(true);
    setError(null);
    const result = await runSquireAlwaysAllow(row, { accept, saveRule });
    setBusy(false);
    if (result.ok) {
      markRuleSaved(row);
      setPending("Sending…");
    } else setError(result.error);
  };

  const allowNextTime = async () => {
    setBusy(true);
    setError(null);
    const result = await saveRule();
    setBusy(false);
    if (result.ok) markRuleSaved(row);
    else setError(result.error);
  };

  const threadName = target?.title ?? null;
  const meta = squireRowMetaText({
    kind: SQUIRE_KIND_LABEL[row.kind],
    title: row.title,
    raiser: null,
    name: squireRowTargetName(row, {
      threadTitle: threadName,
      projectTitle: project?.title ?? null,
    }),
    provider: null,
  });

  return (
    <View
      accessibilityLabel={`${SQUIRE_KIND_LABEL[row.kind]}: ${row.title}`}
      className="mb-3 gap-2 rounded-2xl border border-border bg-card px-3.5 py-3"
    >
      <Text className="font-sans text-xs text-foreground-muted" numberOfLines={1}>
        {meta}
      </Text>
      <Text className="font-lecturn-bold text-sm text-foreground">{row.title}</Text>
      {card === null ? (
        detail.error === null ? null : (
          <Text className="font-sans text-xs text-foreground-muted">{detail.error}</Text>
        )
      ) : (
        <SquireApprovalBody
          environmentId={environmentId}
          card={card}
          threadName={threadName}
          open={phase === "open"}
          answering={controls.kind === "answer" && pending === null}
          busy={busy}
          onAnswer={(answer) => act("accept", { answer })}
        />
      )}
      {error === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      )}
      <SquireApprovalFooter
        controls={controls}
        outcome={entry.outcome}
        pending={phase === "sending" ? "Sending…" : phase === "open" ? pending : null}
        saved={saved}
        busy={busy}
        onAllowOnce={() => void act("accept")}
        onAlwaysAllow={() => void alwaysAllow()}
        onDeny={() => void act("dismiss")}
        onAllowNextTime={() => void allowNextTime()}
      />
    </View>
  );
}

function SquireApprovalFooter(props: {
  readonly controls: SquireChatControls;
  readonly outcome: string | null;
  /** The in-flight line; while set, the row offers nothing. */
  readonly pending: string | null;
  readonly saved: boolean;
  readonly busy: boolean;
  readonly onAllowOnce: () => void;
  readonly onAlwaysAllow: () => void;
  readonly onDeny: () => void;
  readonly onAllowNextTime: () => void;
}) {
  const { controls, busy } = props;
  const status = props.pending ?? props.outcome;
  const offersButtons = props.pending === null;
  return (
    <>
      {status === null && !props.saved ? null : (
        <Text className="font-sans text-xs text-foreground-muted">
          {[status, props.saved ? "Saved to rules" : null].filter(Boolean).join(" · ")}
        </Text>
      )}
      {offersButtons && controls.kind === "approve" ? (
        <View className="flex-row flex-wrap gap-2">
          <RequestActionButton
            label={controls.allowLabel}
            disabled={busy}
            onPress={props.onAllowOnce}
          />
          {controls.alwaysAllow ? (
            <RequestActionButton
              label="Always allow"
              tone="secondary"
              disabled={busy}
              onPress={props.onAlwaysAllow}
            />
          ) : null}
          <RequestActionButton
            label="Deny"
            tone="secondary"
            disabled={busy}
            onPress={props.onDeny}
          />
        </View>
      ) : null}
      {offersButtons && (controls.kind === "dismiss" || controls.kind === "answer") ? (
        <View className="flex-row flex-wrap gap-2">
          <RequestActionButton
            label="Dismiss"
            tone="secondary"
            disabled={busy}
            onPress={props.onDeny}
          />
        </View>
      ) : null}
      {offersButtons && controls.kind === "inactivity" ? (
        <View className="flex-row flex-wrap gap-2">
          <RequestActionButton label="Keep" disabled={busy} onPress={props.onAllowOnce} />
          <RequestActionButton
            label="Pause"
            tone="secondary"
            disabled={busy}
            onPress={props.onDeny}
          />
        </View>
      ) : null}
      {controls.kind === "expired" && controls.allowNextTime ? (
        <View className="flex-row flex-wrap gap-2">
          <RequestActionButton
            label="Always allow next time"
            tone="secondary"
            disabled={busy}
            onPress={props.onAllowNextTime}
          />
        </View>
      ) : null}
    </>
  );
}

function SquireApprovalBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly threadName: string | null;
  readonly open: boolean;
  readonly answering: boolean;
  readonly busy: boolean;
  readonly onAnswer: (answer: SquireAnswer) => Promise<boolean>;
}) {
  const { environmentId, card } = props;
  const openThreadOverPage = useOpenThreadOverPage();
  const payload = card.payload instanceof UnknownUnionMember ? null : card.payload;
  const recommendation = payload === null ? null : squireCardRecommendation(payload);
  const question = payload === null ? null : squireQuestionMode(payload);
  const questionRecommendation =
    payload === null ? null : squireQuestionRecommendation(payload, card.title);
  const threadId: ThreadId | null =
    payload?.type === "question" ? payload.threadId : card.targetThreadId;
  const why = squireWhyText(card.why, { title: card.title, threadTitle: props.threadName });

  const openThread = () => {
    if (threadId === null) return;
    openThreadOverPage({ environmentId, threadId });
  };

  const followUp = () => {
    if (payload?.type !== "question") return;
    const key = scopedThreadKey(environmentId, payload.threadId);
    setComposerDraftText(
      key,
      squireFollowUpDraft(payload.question, getComposerDraftSnapshot(key).text),
    );
    openThreadOverPage({ environmentId, threadId: payload.threadId });
  };

  return (
    <View className="gap-2">
      <SquireEvidenceMeta environmentId={environmentId} card={card} />
      <SquireCiEvidence card={card} />
      {payload?.type === "question" ? (
        <View className="gap-2">
          {question?.type === "user-input" ||
          squireQuestionRepeatsTitle(payload.question, card.title) ? null : (
            <Text className="font-sans text-sm leading-5 text-foreground">{payload.question}</Text>
          )}
          {questionRecommendation === null ? null : (
            <View className="gap-1">
              <SquireSectionLabel label="Recommended" />
              <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
                {questionRecommendation}
              </Text>
            </View>
          )}
          {props.answering && (question?.type === "approval" || question?.type === "user-input") ? (
            <SquireQuestionAnswer
              environmentId={environmentId}
              payload={payload}
              title={card.title}
              disabled={props.busy}
              onAnswer={props.onAnswer}
            />
          ) : null}
          {props.open && question?.type === "secret" ? (
            <Text className="font-sans text-xs text-foreground-muted">
              Secrets are entered in the thread, never through a card.
            </Text>
          ) : null}
          {props.open && question?.type === "in-thread" ? (
            <Text className="font-sans text-xs text-foreground-muted">{question.reason}</Text>
          ) : null}
        </View>
      ) : payload?.type === "squire-proposal" ? (
        <SquireProposalEvidence environmentId={environmentId} proposal={payload} />
      ) : payload?.type === "overlap" ? (
        <SquireOverlapEvidence environmentId={environmentId} payload={payload} />
      ) : payload?.type === "control" ? (
        <SquireControlEvidence environmentId={environmentId} payload={payload} why={card.why} />
      ) : recommendation === null ? null : (
        <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
          {recommendation.text}
        </Text>
      )}
      {/* A control proposal's reason is already part of its one line. */}
      {payload?.type === "control" || why === "" ? null : (
        <Text className="font-sans text-xs leading-4 text-foreground-secondary">{why}</Text>
      )}
      {threadId === null ? null : (
        <View className="flex-row flex-wrap gap-x-4">
          <CardLink label="Open thread" onPress={openThread} />
          {payload !== null && props.open && squireOffersFollowUp(payload) ? (
            <CardLink label="Follow up in thread" onPress={followUp} />
          ) : null}
        </View>
      )}
    </View>
  );
}

type OverlapPayload = Extract<SquireCard["payload"], { readonly type: "overlap" }>;

/** The colliding threads with their providers, branches, and PRs, the shared files, and the order to land them. */
function SquireOverlapEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: OverlapPayload;
}) {
  const { environmentId, payload } = props;
  const [showAllPaths, setShowAllPaths] = useState(false);
  const view = squireOverlapView(payload, { showAllPaths });
  return (
    <View className="gap-2.5">
      <View className="gap-1.5" accessibilityLabel="Threads">
        {payload.threads.map((thread) => (
          <SquireOverlapThread
            key={thread.threadId}
            environmentId={environmentId}
            thread={thread}
          />
        ))}
      </View>
      <View className="gap-1">
        <SquireSectionLabel
          label={
            payload.paths.length === 1 ? "Shared file" : `${payload.paths.length} shared files`
          }
        />
        <View className="gap-0.5 rounded-xl bg-subtle px-3 py-2">
          {view.shownPaths.map((path) => (
            <Text key={path} className="font-mono text-xs text-foreground-secondary">
              {path}
            </Text>
          ))}
        </View>
        {view.moreLabel === null && !showAllPaths ? null : (
          <CardLink
            label={showAllPaths ? "Show fewer" : (view.moreLabel ?? "")}
            onPress={() => setShowAllPaths(!showAllPaths)}
          />
        )}
      </View>
      {view.recommendation === null ? null : (
        <View className="gap-1">
          <SquireSectionLabel label="Recommended order" />
          <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
            {view.recommendation}
          </Text>
        </View>
      )}
    </View>
  );
}

function SquireOverlapThread(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OverlapPayload["threads"][number];
}) {
  const { environmentId, thread } = props;
  const openThread = useOpenThreadOverPage();
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, thread.threadId));
  const config = useEnvironmentServerConfig(environmentId);
  const instance = config?.providers.find(
    (candidate) => candidate.instanceId === shell?.providerInstanceId,
  );
  // The payload's branch is the one seen at detection; the thread's own fills a gap.
  const line = squireOverlapThreadLine(
    { ...thread, branch: thread.branch ?? shell?.branch ?? null },
    {
      title: shell?.title ?? null,
      instanceName: instance === undefined ? null : resolveProviderInstanceDisplayName(instance),
      driverName: (driver) => PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES],
    },
  );
  const meta = [line.provider, line.branch, line.pullRequest].filter((part) => part !== null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${line.label}`}
      onPress={() => openThread({ environmentId, threadId: thread.threadId })}
      className="gap-0.5 active:opacity-60"
    >
      <Text className="font-lecturn-medium text-sm text-primary-text" numberOfLines={1}>
        {line.label}
      </Text>
      <Text className="font-sans text-xs text-foreground-muted" numberOfLines={1}>
        {meta.join(" · ")}
      </Text>
    </Pressable>
  );
}

function CardLink(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={props.onPress}
      className="min-h-9 justify-center active:opacity-60"
    >
      <Text className="font-lecturn-medium text-sm text-primary-text">{props.label}</Text>
    </Pressable>
  );
}
