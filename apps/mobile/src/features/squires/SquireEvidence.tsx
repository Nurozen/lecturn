import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import type { SquireKnownPayload } from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES } from "@lecturn/contracts";
import type { EnvironmentId, SquireCard, SquireId } from "@lecturn/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useProjects, useQuietThreadShell } from "../../state/entities";
import { squireEnvironment, useSquireEntry } from "../../state/squire";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";
import { SquireIndicator } from "./SquireIndicator";
import {
  squireCardCaption,
  squireCardTimeline,
  squireCiUnavailableText,
  squireControlText,
  squireDiffStatsLabel,
  squireProposalText,
  squirePullRequestChips,
  squireRaiserLabel,
  squireTimelineRows,
  type SquireChipTone,
  type SquireProviderNames,
} from "./squireEvidence.logic";
import { squireTint } from "./squirePalette";

/**
 * A clock for row ages ("5m", "waiting 2h"). Ages read in minutes, so it ticks twice a minute,
 * and only while the screen is focused and the app is active: retained routes stay mounted.
 */
export function useSquireAgeClock(): number {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const ticking = focused && appActive;
  useEffect(() => {
    if (!ticking) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Resuming reads the clock that stood still.
    setNowMs(Date.now());
    const intervalId = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(intervalId);
  }, [ticking]);
  return nowMs;
}

const driverName = (driver: string): string | undefined =>
  PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES];

/** Names providers as their threads do: the instance's name, else the driver's. */
export function useSquireProviderNames(environmentId: EnvironmentId): SquireProviderNames {
  const providers = useEnvironmentServerConfig(environmentId)?.providers;
  return {
    instanceName: (instanceId) => {
      const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
      return provider === undefined ? null : resolveProviderInstanceDisplayName(provider);
    },
    driverName,
  };
}

export const formatSquireTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function SquireSectionLabel(props: { readonly label: string }) {
  return (
    <Text className="font-lecturn-bold text-2xs uppercase tracking-[1px] text-foreground-muted">
      {props.label}
    </Text>
  );
}

const CHIP_TEXT: Readonly<Record<SquireChipTone, string>> = {
  failing: "text-danger-foreground",
  passing: "text-adaptive-emerald-600-400",
  pending: "text-warning-foreground",
  neutral: "text-foreground-secondary",
};

/** Branch and diff stats, then the PR's number and check, review, and merge chips. */
export function SquireEvidenceMeta(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
}) {
  const { environmentId, card } = props;
  const shell = useQuietThreadShell(
    card.targetThreadId === null ? null : scopeThreadRef(environmentId, card.targetThreadId),
  );
  const branch = card.evidence.headBranch ?? shell?.branch ?? null;
  const stats = card.evidence.diffStats;
  const pr = card.evidence.pullRequest;
  const chips = pr === undefined ? [] : squirePullRequestChips(pr);
  if (branch === null && stats === undefined && pr === undefined) return null;
  return (
    <View className="gap-1.5">
      {branch === null && stats === undefined ? null : (
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          {branch === null ? null : (
            // Wraps rather than truncates: a phone-width card would otherwise hide the branch.
            <Text className="shrink font-mono text-xs text-foreground-muted">{branch}</Text>
          )}
          {stats === undefined ? null : (
            <View
              className="flex-row items-center gap-2"
              accessible
              accessibilityLabel={`${stats.insertions} additions, ${stats.deletions} deletions, ${squireDiffStatsLabel(stats)}`}
            >
              <PullRequestDiffStats additions={stats.insertions} deletions={stats.deletions} />
              <Text className="font-sans text-xs text-foreground-muted">
                {squireDiffStatsLabel(stats)}
              </Text>
            </View>
          )}
        </View>
      )}
      {pr === undefined ? null : (
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text className="font-lecturn-medium text-xs text-foreground-muted">#{pr.number}</Text>
          {chips.map((chip) => (
            <Text
              key={chip.key}
              className={cn(
                "rounded-full bg-subtle px-2.5 py-1 font-lecturn-medium text-xs",
                CHIP_TEXT[chip.tone],
              )}
            >
              {chip.label}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** The failing job's first log lines, or where to look when they could not be read. */
export function SquireCiEvidence(props: { readonly card: SquireCard }) {
  const { evidence } = props.card;
  const errorLines = evidence.errorLines ?? [];
  const unavailable = evidence.ciLog === undefined ? null : squireCiUnavailableText(evidence.ciLog);
  if (errorLines.length === 0 && unavailable === null) return null;
  return (
    <View className="gap-1">
      {errorLines.length === 0 ? null : (
        <Text
          accessibilityLabel="Failing job log"
          className="rounded-xl bg-subtle px-3 py-2 font-mono text-xs leading-4 text-foreground-secondary"
        >
          {errorLines.join("\n")}
        </Text>
      )}
      {unavailable === null ? null : (
        <Text className="font-sans text-xs text-foreground-muted">{unavailable}</Text>
      )}
    </View>
  );
}

/** The budget line from the raiser's snapshot entry, then the card's timeline. */
export function SquireCaptionAndTimeline(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SquireCard;
}) {
  const { environmentId, card } = props;
  const raiser = useSquireEntry(environmentId, card.squireId);
  const caption = squireCardCaption(card, raiser, formatSquireTime);
  const timeline = squireTimelineRows(
    squireCardTimeline(card),
    formatSquireTime,
    raiser === null ? "A Squire" : squireRaiserLabel(raiser.squire),
  );
  return (
    <>
      {caption === null ? null : (
        <Text className="font-sans text-xs text-foreground-muted">{caption}</Text>
      )}
      {timeline.length === 0 ? null : (
        <View className="gap-1 border-t border-border pt-2.5" accessibilityLabel="Timeline">
          <SquireSectionLabel label="Timeline" />
          {timeline.map((row) => (
            <View key={row.key} className="flex-row gap-1.5">
              <Text className="font-sans text-xs tabular-nums text-foreground-muted">
                {row.time}
              </Text>
              <Text className="font-sans text-xs text-foreground-muted">·</Text>
              <Text className="flex-1 font-sans text-xs text-foreground-secondary">{row.text}</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

type ProposalPayload = Extract<SquireKnownPayload, { readonly type: "squire-proposal" }>;

/** A proposed Squire as it would be created: portrait, name, scope, palette, brief. */
export function SquireProposalEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly proposal: ProposalPayload;
}) {
  const { environmentId, proposal } = props;
  const projects = useProjects();
  const text = squireProposalText(
    proposal,
    (projectId) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
  );
  // The ring color is the same in both themes.
  const ring = squireTint(proposal.companion.palette, false, "dark").ring;
  return (
    <View className="gap-2.5">
      <View className="flex-row items-start gap-3">
        <SquireIndicator
          state="waiting"
          companion={proposal.companion}
          size={48}
          label={`${text.name}'s ${proposal.companion.presence === "emblem" ? "emblem" : "portrait"}`}
        />
        <View className="flex-1 gap-0.5">
          <Text className="font-lecturn-bold text-sm text-foreground">{text.name}</Text>
          <Text className="font-sans text-xs leading-4 text-foreground-secondary">
            {text.scope}
          </Text>
          <View className="flex-row items-center gap-1.5 pt-0.5">
            <View
              className="size-2 rounded-full"
              style={{ backgroundColor: ring }}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
            <Text className="font-sans text-xs text-foreground-muted">{text.palette}</Text>
            <Text className="font-sans text-xs text-foreground-muted">· {text.permissions}</Text>
          </View>
        </View>
      </View>
      {text.brief === null ? null : (
        <Text className="font-sans text-sm leading-5 text-foreground">{text.brief}</Text>
      )}
    </View>
  );
}

type ControlPayload = Extract<SquireKnownPayload, { readonly type: "control" }>;

/** What the Lead would do and to whom, with its reason, as one line. */
export function SquireControlEvidence(props: {
  readonly environmentId: EnvironmentId;
  readonly payload: ControlPayload;
  readonly why: string;
}) {
  const state = useAtomValue(squireEnvironment.state(props.environmentId));
  const nameOf = (squireId: SquireId) =>
    state?.squires.find((entry) => entry.squire.id === squireId)?.squire.name ?? "a Squire";
  return (
    <Text className="rounded-xl bg-subtle px-3 py-2.5 font-sans text-sm leading-5 text-foreground">
      {squireControlText(props.payload, nameOf, props.why)}
    </Text>
  );
}
