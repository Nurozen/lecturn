import { HStack, Image, Link, Rectangle, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import type { ComponentProps, ReactNode } from "react";
import type { RelayPullRequestActivity } from "@lecturn/contracts";
import {
  activityBackgroundTint,
  glassEffect,
  background,
  clipShape,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  padding,
  opacity,
  resizable,
  strokeBorder,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1];

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
  readonly pullRequest?: RelayPullRequestActivity;
}

export interface AgentActivityProps {
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly accountColor?: string;
  readonly iosMajorVersion?: number;
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// This function is serialized into the widget extension's JS bundle, so it
// must stay self-contained: no references to module-scope helpers, only the
// imported view/modifier factories.
export function AgentActivity(
  props: AgentActivityProps,
  environment: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";

  // Keep these literals inside the serialized widget function. Match Lecturn's
  // dark app chrome even when macOS mirrors the activity in a light appearance.
  const glass = (props.iosMajorVersion ?? 18) >= 26;
  const navy = "#061522";
  const primaryForeground = glass ? "primary" : "#dfc7a4";
  const secondaryForeground = glass ? "secondary" : "#a5957f";
  const gold = props.accountColor ?? "#e6bc63";
  const subdued = environment.isLuminanceReduced === true;
  // The compact/minimal host chrome remains system-owned (including on Mac).
  const systemGold = environment.colorScheme === "light" ? "#996918" : gold;

  const phaseTint = (phase: AgentActivityPhase | undefined, systemSurface = false): string => {
    if (subdued) return systemSurface ? "secondary" : secondaryForeground;
    const isLightScheme = systemSurface && environment.colorScheme === "light";
    switch (phase) {
      case "waiting_for_approval":
      case "waiting_for_input":
        return isLightScheme ? "#9a6700" : "#f0b34d";
      case "failed":
        return isLightScheme ? "#b42318" : "#f07868";
      case "completed":
        return isLightScheme ? "#087f5b" : "#56c5a1";
      case "stale":
        return isLightScheme ? "#626a73" : "#a6adb6";
      case "starting":
      case "running":
      default:
        return isLightScheme ? "#996918" : gold;
    }
  };

  // Order attention-first so whatever needs the user floats to the top of every
  // presentation, then failures, then in-flight work, then finished/stale.
  const phasePriority = (phase: AgentActivityPhase): number => {
    if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
    if (phase === "failed") return 1;
    if (phase === "running" || phase === "starting") return 2;
    return 3;
  };
  const ordered = [...props.activities].sort(
    (a, b) => phasePriority(a.phase) - phasePriority(b.phase),
  );
  const hasPullRequests = ordered.some((row) => row.pullRequest !== undefined);
  const row0 = ordered[0];
  const row1 = ordered[1];
  const row2 = ordered[2];
  const row3 = ordered[3];
  const row4 = ordered[4];

  const attentionRows = props.activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
  const attentionRow = attentionRows[0];
  const failedRow = props.activities.find((row) => row.phase === "failed");
  const heroRow = attentionRow ?? failedRow ?? row0;
  const tint = phaseTint(heroRow?.phase);
  // Headline count leans on the accent when a human is actually blocked.
  const headerTint = attentionRow
    ? phaseTint(attentionRow.phase)
    : failedRow
      ? phaseTint(failedRow.phase)
      : tint;

  // With nothing active the aggregate only carries recently finished work, so
  // "0 active agents" (and a lone "0" in the expanded island) read as broken.
  // Lead with the outcome instead. The outcome is derived here from the rows
  // rather than taken from the server subtitle (which keys off the newest
  // terminal row): every presentation — header text, tint, count slots,
  // minimal glyph — must agree, and a failure anywhere should dominate a
  // newer success.
  const allDone = props.activeCount === 0;
  const doneLabel = failedRow ? "Failed" : "Done";
  const outcomeLabel = hasPullRequests
    ? failedRow
      ? "Activity needs attention"
      : "Activity completed"
    : failedRow
      ? "Agent work failed"
      : "Agent work completed";

  // Header copy: "5 active agents" + (", 1 needs attention"). The banner renders
  // the two parts in-line so the attention half can carry the accent color;
  // `summary` is the short form for tight spots (expanded center, watch card).
  const agentWord = props.activeCount === 1 ? "agent" : "agents";
  const agentsLabel = allDone
    ? outcomeLabel
    : hasPullRequests
      ? `${props.activeCount} active ${props.activeCount === 1 ? "activity" : "activities"}`
      : `${props.activeCount} active ${agentWord}`;
  const attentionSuffix =
    attentionRows.length > 0
      ? `${attentionRows.length} need${attentionRows.length === 1 ? "s" : ""} attention`
      : "";
  const activeLabel = allDone ? doneLabel : `${props.activeCount} active`;
  const summary = attentionSuffix || activeLabel;

  // Any registered scheme variant routes back to this app; taps are delivered
  // to the widget's containing app, so the prod scheme is safe for all builds.
  const deepLinkRow = attentionRow ?? row0;
  const deepLink =
    deepLinkRow && deepLinkRow.deepLink.startsWith("/") && !deepLinkRow.deepLink.startsWith("//")
      ? `lecturn://${deepLinkRow.deepLink.slice(1)}${props.accountId ? `?accountId=${encodeURIComponent(props.accountId)}` : ""}`
      : null;

  // A scannable status glyph per phase — reads faster than colored words and
  // ties the compact / expanded / banner / watch presentations together.
  type SFName = NonNullable<ComponentProps<typeof Image>["systemName"]>;
  const phaseSymbol = (phase: AgentActivityPhase): SFName => {
    switch (phase) {
      case "waiting_for_approval":
        return "exclamationmark.circle.fill";
      case "waiting_for_input":
        return "questionmark.circle.fill";
      case "failed":
        return "xmark.octagon.fill";
      case "completed":
        return "checkmark.circle.fill";
      case "starting":
        return "circle.dotted";
      case "stale":
        return "clock.arrow.circlepath";
      case "running":
      default:
        return "arrow.triangle.2.circlepath";
    }
  };

  // SF Symbols, like the logo, ignore frame/foregroundStyle applied directly to
  // the image; size + tint them through a container the resizable symbol fills.
  const renderGlyph = (systemName: SFName, size: number, color: string) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={systemName} modifiers={[resizable()]} />
    </HStack>
  );

  // Single-line row used by every presentation: glyph, title, inline project,
  // status. The project and status carry layoutPriority(1) so when space runs
  // out it's the title that truncates, never the (short) project name or the
  // status label. Single-line keeps rows inside the expanded island's hard
  // height budget (~160pt) and lets the banner fit more agents.
  const renderAgentRow = (row: AgentActivityRowProps) => (
    <HStack
      spacing={7}
      alignment="center"
      modifiers={
        row.phase === "running"
          ? [
              padding({ horizontal: 4, vertical: 2 }),
              strokeBorder({
                color: subdued ? "#655032" : gold,
                style: { lineWidth: 0.7 },
                cornerRadius: 5,
                shape: "roundedRectangle",
              }),
            ]
          : []
      }
    >
      <Text
        modifiers={[
          font({ weight: "semibold", size: 13 }),
          foregroundStyle(primaryForeground),
          lineLimit(1),
        ]}
      >
        {row.threadTitle}
      </Text>
      {/* No layoutPriority and no frame on the project: two bare texts take
          their ideal width when it fits and shrink proportionally only when it
          doesn't — so short rows never truncate, and long title + long project
          truncate together. (A maxWidth frame is greedy and reserved its full
          width even for short names; layoutPriority let the project starve the
          title.) */}
      {row.projectTitle !== row.threadTitle ? (
        <Text modifiers={[font({ size: 11 }), foregroundStyle(secondaryForeground), lineLimit(1)]}>
          {row.projectTitle}
        </Text>
      ) : null}
      <Spacer minLength={8} />
      {row.phase !== "running" ? (
        <Text
          modifiers={[
            font({ weight: "semibold", size: 11 }),
            foregroundStyle(phaseTint(row.phase)),
            layoutPriority(1),
          ]}
        >
          {row.status}
        </Text>
      ) : null}
    </HStack>
  );

  // PR rows use two bounded lines and a smaller row budget. The widget is a
  // glanceable snapshot; taps open authenticated controls, never a mutation URL.
  const renderCompactRow = (row: AgentActivityRowProps) => {
    const pr = row.pullRequest;
    if (!pr) return renderAgentRow(row);
    const content = (
      <VStack alignment="leading" spacing={2}>
        <Text
          modifiers={[
            font({ weight: "semibold", size: 12 }),
            foregroundStyle(primaryForeground),
            lineLimit(1),
          ]}
        >
          {`#${pr.number} ${pr.repository.slice(0, 64)} · CI ${pr.checks} · Required ${pr.requiredChecks}`}
        </Text>
        <Text
          modifiers={[
            font({ size: 10 }),
            foregroundStyle(pr.stale ? secondaryForeground : phaseTint(row.phase)),
            lineLimit(1),
          ]}
        >
          {`${pr.stale ? "Stale · " : ""}${pr.watching ? "Watching" : "Paused"} · ${pr.manager} · Merge ${pr.authorization}`}
        </Text>
      </VStack>
    );
    const destination =
      row.deepLink.startsWith("/pr-watches/") && !/[?#]/.test(row.deepLink)
        ? `lecturn://${row.deepLink.slice(1)}${props.accountId ? `?accountId=${encodeURIComponent(props.accountId)}` : ""}`
        : null;
    return destination ? <Link destination={destination}>{content}</Link> : content;
  };

  // The Lecturn mark. `assetName` resolves the template image set bundled in
  // the widget extension's asset catalog. Image views only honor `resizable`
  // directly (frame/foregroundStyle are dropped), so we size it via a container
  // frame the resizable image fills and tint it through the container's
  // foreground style, which the template image inherits. The square frame matches
  // the glyph's aspect ratio so it never distorts.
  const renderLogo = (height: number, color: string) => (
    <HStack modifiers={[frame({ width: height, height }), foregroundStyle(color)]}>
      <Image assetName="LecturnMark" modifiers={[resizable()]} />
    </HStack>
  );

  // WidgetKit snapshots do not support an ongoing animation loop. A broad
  // highlight gives the thread its sheen without timers or extra activity pushes.
  const renderThread = () => (
    <Rectangle
      modifiers={[
        frame({ height: 1 }),
        foregroundStyle({
          type: "linearGradient",
          colors: subdued
            ? ["#263746", "#6c583a", "#263746"]
            : ["#263746", "#9c7133", "#f4deb0", "#d9a34e", "#263746"],
          startPoint: { x: 0, y: 0 },
          endPoint: { x: 1, y: 0 },
        }),
      ]}
    />
  );
  // The image has lower layout priority so the content decides the widget's
  // height. It is a bundled original-color asset, never a remote image fetch.
  const brandedSurface = (content: ReactNode, radius = 20) => (
    <ZStack
      modifiers={[...(glass ? [] : [background(navy)]), clipShape("roundedRectangle", radius)]}
    >
      <HStack modifiers={[layoutPriority(-1), opacity(subdued ? 0.16 : 0.6)]}>
        <Image assetName="LecturnNightSky" modifiers={[resizable()]} />
      </HStack>
      {content}
    </ZStack>
  );
  const surface = [
    clipShape("roundedRectangle", 20),
    strokeBorder({
      color: subdued ? "#263746" : "#655032",
      style: { lineWidth: 0.5 },
      cornerRadius: 20,
      shape: "roundedRectangle",
    }),
    ...(glass
      ? [
          glassEffect({
            glass: { variant: "regular", tint: props.accountColor ?? gold },
            shape: "roundedRectangle",
            cornerRadius: 20,
          }),
          activityBackgroundTint("#00000000"),
        ]
      : [activityBackgroundTint(navy)]),
  ];

  return {
    banner: brandedSurface(
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={[
          padding({ horizontal: 14, vertical: 12 }),
          ...surface,
          ...(deepLink ? [widgetURL(deepLink)] : []),
        ]}
      >
        <HStack spacing={10} alignment="center">
          {renderLogo(24, subdued ? secondaryForeground : gold)}
          <VStack alignment="leading" spacing={2}>
            <Text
              modifiers={[
                font({ weight: "semibold", size: 13 }),
                foregroundStyle(subdued ? secondaryForeground : gold),
                lineLimit(1),
              ]}
            >
              {props.accountLabel ? `${props.accountLabel} · ${agentsLabel}` : agentsLabel}
            </Text>
            {attentionSuffix ? (
              <Text
                modifiers={[
                  font({ weight: "semibold", size: 11 }),
                  foregroundStyle(headerTint),
                  lineLimit(1),
                ]}
              >
                {attentionSuffix}
              </Text>
            ) : null}
          </VStack>
          <Spacer minLength={0} />
        </HStack>
        {renderThread()}
        {row0 ? renderCompactRow(row0) : null}
        {row1 ? renderCompactRow(row1) : null}
        {row2 ? renderCompactRow(row2) : null}
        {!hasPullRequests && row3 ? renderCompactRow(row3) : null}
        {!hasPullRequests && row4 ? renderCompactRow(row4) : null}
      </VStack>,
    ),
    // Compact card for the watchOS Smart Stack + CarPlay (the `.small` family):
    // brand + count, then the single most important agent with its status glyph.
    bannerSmall: brandedSurface(
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={[padding({ all: 10 }), ...surface, ...(deepLink ? [widgetURL(deepLink)] : [])]}
      >
        <HStack spacing={7} alignment="center">
          {renderLogo(18, subdued ? secondaryForeground : gold)}
          <Text
            modifiers={[
              font({ weight: "bold", size: 13 }),
              foregroundStyle(headerTint),
              lineLimit(1),
            ]}
          >
            {attentionRows.length > 0 ? summary : activeLabel}
          </Text>
          <Spacer minLength={6} />
        </HStack>
        {renderThread()}
        {row0 ? (
          <HStack spacing={7} alignment="center">
            <Text
              modifiers={[
                font({ weight: "semibold", size: 12 }),
                foregroundStyle(primaryForeground),
                lineLimit(1),
              ]}
            >
              {row0.pullRequest
                ? `#${row0.pullRequest.number} ${row0.pullRequest.repository.slice(0, 32)}`
                : row0.threadTitle}
            </Text>
            <Spacer minLength={6} />
            <Text modifiers={[font({ size: 11 }), foregroundStyle(phaseTint(row0.phase))]}>
              {row0.pullRequest ? `CI ${row0.pullRequest.checks}` : row0.status}
            </Text>
          </HStack>
        ) : null}
      </VStack>,
    ),
    compactLeading: renderLogo(16, subdued ? "secondary" : systemGold),
    compactTrailing: (
      <Text
        modifiers={[
          font({ weight: "semibold", size: 11 }),
          foregroundStyle(phaseTint(heroRow?.phase, true)),
        ]}
      >
        {attentionRow
          ? attentionRow.phase === "waiting_for_approval"
            ? "Approval"
            : "Input"
          : activeLabel}
      </Text>
    ),
    // The shared/minimal form is a ~22pt circle — a single signal reads there,
    // the wordmark does not. Show the blocking/outcome phase glyph, else the
    // mark (all-done shows the hero row's checkmark/cross).
    minimal:
      (attentionRow || failedRow || allDone) && heroRow
        ? renderGlyph(phaseSymbol(heroRow.phase), 15, phaseTint(heroRow.phase, true))
        : renderLogo(14, subdued ? "secondary" : systemGold),
    expandedLeading: (
      <HStack
        spacing={5}
        alignment="center"
        modifiers={[
          padding({ horizontal: 8, vertical: 4 }),
          background(navy),
          clipShape("roundedRectangle", 10),
        ]}
      >
        {renderLogo(18, subdued ? secondaryForeground : gold)}
        <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(tint)]}>
          {allDone ? doneLabel : `${props.activeCount}`}
        </Text>
      </HStack>
    ),
    // No center content: the phase glyphs + statuses in expandedBottom already
    // carry the attention signal, and the expanded island's height budget is
    // tight enough that a summary line there pushed the third row off.
    expandedCenter: null,
    // No trailing content: a timestamp is glanceable-lock-screen info, not
    // useful in a view the user is actively holding open — and the trailing
    // region hugs the island's corner radius, which clipped it anyway.
    expandedTrailing: null,
    expandedBottom: brandedSurface(
      // Vertical padding only: the expanded region provides its own horizontal
      // content margins, so `all` padding double-indented the rows.
      // Horizontal padding keeps both edges clear of the island's corner
      // curvature (right edge clipped status labels; titles hugged the left).
      <VStack
        alignment="leading"
        spacing={5}
        modifiers={
          deepLink
            ? [
                padding({ vertical: 4, horizontal: 8 }),
                clipShape("roundedRectangle", 10),
                widgetURL(deepLink),
              ]
            : [padding({ vertical: 4, horizontal: 8 }), clipShape("roundedRectangle", 10)]
        }
      >
        {renderThread()}
        {row0 ? renderCompactRow(row0) : null}
        {row1 ? renderCompactRow(row1) : null}
        {!hasPullRequests && row2 ? renderCompactRow(row2) : null}
      </VStack>,
      10,
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
