import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import {
  squireOverlapThreadLine,
  squireOverlapView,
  squireQuestionRecommendation,
} from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES, UnknownUnionMember } from "@lecturn/contracts";
import type {
  EnvironmentId,
  SquireCard,
  SquireCardRow,
  SquireRuleOffer,
  ThreadId,
} from "@lecturn/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { squireEnvironment, useSquireEntry } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { RequestActionButton } from "../threads/RequestActionButton";
import {
  SquireCaptionAndTimeline,
  SquireCiEvidence,
  SquireControlEvidence,
  SquireEvidenceMeta,
  SquireProposalEvidence,
  SquireSectionLabel,
} from "./SquireEvidence";
import {
  squireAgeText,
  squireQuestionWhyFallback,
  squireWaitingSince,
  squireWhyText,
} from "./squireEvidence.logic";
import { SquireQuestionAnswer } from "./SquireQuestionAnswer";
import {
  squireAskCopy,
  squireCardActionable,
  squireCardOrigins,
  squireCardPrimaryLabel,
  squireCardRecommendation,
  squireEditedText,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireQuestionMode,
  squireQuestionRepeatsTitle,
  type SquireAnswer,
} from "./squireQueue.logic";
import { useSquireItemsAct, useSquireMarkOpened } from "./squireQueueState";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

// Android shows one page at a time; iOS opens the thread over this page, so Back returns.
function useOpenThreadOverPage() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (params: { readonly environmentId: string; readonly threadId: string }) => {
    if (Platform.OS === "android") selectDetail({ name: "Thread", params });
    else navigation.dispatch(StackActions.push("Thread", params));
  };
}

export type SquireActedHandler = (
  row: SquireCardRow,
  action: "accept" | "dismiss",
  ruleOffer: SquireRuleOffer | undefined,
) => void;

/** Evidence under the row it expands from; the detail loads only while expanded. */
export function SquireItemCard(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireCardRow;
  readonly onActed: SquireActedHandler;
  /** The queue's age clock, for a question's "waiting" fallback. */
  readonly now: number;
}) {
  const { environmentId, row } = props;
  useSquireMarkOpened(environmentId, row.id, row.openedAt);
  const detail = useEnvironmentQuery(
    squireEnvironment.item({
      environmentId,
      input: { squireId: row.ownerSquireId, cardId: row.id },
    }),
  );
  const card = detail.data?.card ?? null;
  if (card === null) {
    return (
      <Text className="font-sans text-sm text-foreground-muted">{detail.error ?? "Loading…"}</Text>
    );
  }
  return (
    <SquireCardBody
      environmentId={environmentId}
      card={card}
      onActed={props.onActed}
      now={props.now}
    />
  );
}

function SquireCardBody(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly onActed: SquireActedHandler;
  readonly now: number;
}) {
  const { environmentId, card } = props;
  const openThreadOverPage = useOpenThreadOverPage();
  const { canAct, run } = useSquireItemsAct(environmentId);
  const payload = card.payload instanceof UnknownUnionMember ? null : card.payload;
  const recommendation = payload === null ? null : squireCardRecommendation(payload);
  const primary = payload === null ? null : squireCardPrimaryLabel(payload);
  const question = payload === null ? null : squireQuestionMode(payload);
  const questionRecommendation =
    payload === null ? null : squireQuestionRecommendation(payload, card.title);
  // Kept across server updates, so a newer recommendation never overwrites an edit.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionable = squireCardActionable(card) && canAct;
  const inactivity = card.kind === "fyi" && card.fyiSource === "inactivity";
  const threadId: ThreadId | null =
    payload?.type === "question" ? payload.threadId : card.targetThreadId;

  const act = async (
    action: "accept" | "dismiss",
    extra: { readonly text?: string | undefined; readonly answer?: SquireAnswer } = {},
  ) => {
    setBusy(true);
    setError(null);
    const outcome = await run([card.id], action, extra);
    setBusy(false);
    if (outcome === null) return false;
    if (!outcome.ok) {
      setError(outcome.error);
      return false;
    }
    setDraft(null);
    props.onActed(card, action, outcome.ruleOffer);
    return true;
  };

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
    <View className="gap-3">
      <SquireEvidenceMeta environmentId={environmentId} card={card} />
      <SquireOrigins environmentId={environmentId} card={card} />
      <SquireCiEvidence card={card} />
      {/* A question's Why comes before its options, so it informs the answer. */}
      {payload?.type === "question" ? (
        <SquireWhy environmentId={environmentId} card={card} fallbackNow={props.now} />
      ) : null}
      {payload?.type === "question" ? (
        <View className="gap-2.5">
          {question?.type === "user-input" ||
          squireQuestionRepeatsTitle(payload.question, card.title) ? null : (
            <Text className="font-sans text-sm leading-5 text-foreground">{payload.question}</Text>
          )}
          {/* Above the options, so the suggestion informs the answer. */}
          {questionRecommendation === null ? null : (
            <View className="gap-1">
              <SquireSectionLabel label="Recommended" />
              <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
                {questionRecommendation}
              </Text>
            </View>
          )}
          {question?.type === "approval" || question?.type === "user-input" ? (
            actionable ? (
              <SquireQuestionAnswer
                payload={payload}
                title={card.title}
                disabled={busy}
                onAnswer={(answer) => act("accept", { answer })}
              />
            ) : null
          ) : question?.type === "secret" ? (
            <Text className="font-sans text-xs text-foreground-muted">
              Secrets are entered in the thread, never through a card.
            </Text>
          ) : question?.type === "in-thread" ? (
            <Text className="font-sans text-xs text-foreground-muted">{question.reason}</Text>
          ) : null}
        </View>
      ) : payload?.type === "squire-proposal" ? (
        <SquireProposalEvidence environmentId={environmentId} proposal={payload} />
      ) : payload?.type === "overlap" ? (
        <SquireOverlapEvidence environmentId={environmentId} payload={payload} />
      ) : payload?.type === "control" ? (
        <SquireControlEvidence environmentId={environmentId} payload={payload} why={card.why} />
      ) : recommendation === null ? null : draft !== null && recommendation.editable ? (
        <TextInput
          accessibilityLabel="Recommendation"
          value={draft}
          multiline
          autoFocus
          onChangeText={setDraft}
          className="text-sm"
        />
      ) : (
        <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
          {recommendation.text}
        </Text>
      )}
      {/* A control proposal's reason is already part of its one line. */}
      {payload?.type === "question" || payload?.type === "control" ? null : (
        <SquireWhy environmentId={environmentId} card={card} fallbackNow={null} />
      )}
      <SquireCaptionAndTimeline environmentId={environmentId} card={card} />
      {error === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        {actionable && inactivity ? (
          <>
            <RequestActionButton label="Keep" disabled={busy} onPress={() => void act("accept")} />
            <RequestActionButton
              label="Pause"
              tone="secondary"
              disabled={busy}
              onPress={() => void act("dismiss")}
            />
          </>
        ) : null}
        {actionable && primary !== null ? (
          <RequestActionButton
            label={primary}
            disabled={busy}
            onPress={() =>
              void act("accept", {
                text:
                  recommendation === null
                    ? undefined
                    : squireEditedText(recommendation.text, draft),
              })
            }
          />
        ) : null}
        {actionable && recommendation?.editable ? (
          <RequestActionButton
            label={draft === null ? "Edit" : "Cancel edit"}
            tone="secondary"
            accessibilityState={{ selected: draft !== null }}
            onPress={() => setDraft(draft === null ? recommendation.text : null)}
          />
        ) : null}
        {canAct && !inactivity && (squireCardActionable(card) || card.status === "outdated") ? (
          <RequestActionButton
            label="Dismiss"
            tone="secondary"
            disabled={busy}
            onPress={() => void act("dismiss")}
          />
        ) : null}
      </View>
      {threadId === null ? null : (
        <View className="flex-row flex-wrap gap-x-4 gap-y-1">
          <CardLink label="Open thread" onPress={openThread} />
          {payload !== null && squireOffersFollowUp(payload) ? (
            <CardLink label="Follow up in thread" onPress={followUp} />
          ) : null}
        </View>
      )}
      {card.targetThreadId === null ? null : (
        <SquireAsk environmentId={environmentId} card={card} threadId={card.targetThreadId} />
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

/** Origin labels; the raiser's rules are read only for a card a rule changed. */
function SquireOrigins(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
}) {
  const { environmentId, card } = props;
  const rules = useEnvironmentQuery(
    card.ruleId === null
      ? null
      : squireEnvironment.rules({ environmentId, input: { squireId: card.squireId } }),
  );
  const raiser = useSquireEntry(environmentId, card.squireId);
  const target = useQuietThreadShell(
    card.targetThreadId === null ? null : scopeThreadRef(environmentId, card.targetThreadId),
  );
  const labels = squireCardOrigins(card, rules.data?.rules ?? [], {
    squireName: (squireId) =>
      squireId === card.squireId ? (raiser?.squire.name ?? "A Squire") : "A Squire",
    targetName: (rule) =>
      rule.targetKind === "thread" && rule.targetId === card.targetThreadId && target != null
        ? target.title
        : rule.targetId,
  });
  if (labels.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {labels.map((label) => (
        <Text
          key={label}
          className="rounded-full bg-subtle px-2.5 py-1 font-lecturn-medium text-xs text-foreground-secondary"
        >
          {label}
        </Text>
      ))}
    </View>
  );
}

function SquireWhy(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  /** A question always says why it is here, at least how long it has waited. */
  readonly fallbackNow: number | null;
}) {
  const { environmentId, card } = props;
  const shell = useQuietThreadShell(
    card.targetThreadId === null ? null : scopeThreadRef(environmentId, card.targetThreadId),
  );
  const threadTitle = shell?.title ?? null;
  const quote = card.evidence.triggerText ?? card.trigger.quote ?? null;
  const why = squireWhyText(card.why, { title: card.title, threadTitle });
  if (why === "" && quote === null) {
    return props.fallbackNow === null ? null : (
      <Text className="font-sans text-xs text-foreground-muted">
        {squireQuestionWhyFallback(
          threadTitle,
          squireAgeText(squireWaitingSince(card), props.fallbackNow),
        )}
      </Text>
    );
  }
  return (
    <View className="gap-1">
      <SquireSectionLabel label="Why" />
      {why === "" ? null : (
        <Text className="font-sans text-sm leading-5 text-foreground-secondary">{why}</Text>
      )}
      {quote === null ? null : (
        <Text className="border-l-2 border-border pl-2.5 font-sans text-xs leading-4 text-foreground-muted">
          {quote}
        </Text>
      )}
    </View>
  );
}

function SquireAsk(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
  readonly threadId: ThreadId;
}) {
  const { environmentId, card } = props;
  const canAsk = useAtomValue(squireEnvironment.itemAsk.permissionAtom(environmentId));
  const ask = useAtomCommand(squireEnvironment.itemAsk, { reportFailure: false });
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, props.threadId));
  const config = useEnvironmentServerConfig(environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === shell?.providerInstanceId,
  );
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canAsk) return null;
  const current = card.ask;
  const running = current?.status === "running";

  const send = async () => {
    const question = text.trim();
    if (question === "") return;
    setSending(true);
    setError(null);
    const result = await ask({
      environmentId,
      input: { requestId: uuidv4(), cardId: card.id, question },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
      setOpen(false);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    // The server decides whether the provider may probe, so its refusal is what the user sees.
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error && failure.message.trim() !== ""
        ? failure.message
        : "The question could not be sent. Try again.",
    );
  };

  return (
    <View className="gap-2 border-t border-border pt-3">
      {current === null ? null : (
        <View className="gap-1">
          <Text className="font-lecturn-medium text-xs text-foreground-muted">
            {current.question}
          </Text>
          <Text
            className={
              current.status === "failed"
                ? "font-sans text-sm text-danger-foreground"
                : "font-sans text-sm leading-5 text-foreground"
            }
          >
            {current.status === "running"
              ? "Asking…"
              : current.status === "failed"
                ? (current.error ?? "The question could not be answered.")
                : (current.answer ?? "")}
          </Text>
        </View>
      )}
      {open ? (
        <View className="gap-2">
          <Text className="font-sans text-xs leading-4 text-foreground-muted">
            {squireAskCopy(
              provider === undefined
                ? null
                : {
                    name: resolveProviderInstanceDisplayName(provider),
                    conversationFork: provider.conversationFork,
                  },
            )}
          </Text>
          <TextInput
            accessibilityLabel="Ask about this"
            value={text}
            multiline
            autoFocus
            onChangeText={setText}
            className="text-sm"
          />
          {error === null ? null : (
            <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
              {error}
            </Text>
          )}
          <View className="flex-row gap-2">
            <RequestActionButton
              label="Ask"
              disabled={sending || running || text.trim() === ""}
              onPress={() => void send()}
            />
            <RequestActionButton label="Cancel" tone="secondary" onPress={() => setOpen(false)} />
          </View>
        </View>
      ) : (
        <CardLink
          label={running ? "Asking…" : "Ask about this"}
          onPress={() => setOpen(!running)}
        />
      )}
    </View>
  );
}
