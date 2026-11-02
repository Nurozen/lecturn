import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { derivePhysicalProjectKey } from "@lecturn/client-runtime/state/project-grouping";
import { resolveProviderInstanceDisplayName } from "@lecturn/client-runtime/state/provider-instance-display";
import type { SquireSnapshotEntry } from "@lecturn/client-runtime/state/squire";
import { PROVIDER_DISPLAY_NAMES } from "@lecturn/contracts";
import type {
  EnvironmentId,
  ProviderInstanceId,
  SquireCardRow,
  SquireId,
  ThreadId,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { cn } from "../../../lib/utils";
import { useProject, useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentProviders } from "../../../state/environments";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { squireChildAgeText, squireKindDot } from "../sidebar/squireSidebar.logic";
import { SquireIndicator } from "../SquireIndicator";
import {
  SQUIRE_KIND_LABEL,
  SQUIRE_MARKER_LABEL,
  squireCardMarkers,
  squireFyiNeedsText,
  squireFyiRowText,
  squireOverlapProviderNames,
  squireProposalProviderName,
  squireRowAction,
  squireRowMeta,
  squireRowProviderName,
  squireRowTargetName,
  squireSteerKindLabel,
  squireTitleBesideKind,
  squireWaitingSince,
} from "./squireQueue.logic";

const DOT_TONE_CLASS = {
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  success: "bg-success",
} as const;

export function SquireKindDot(props: { readonly kind: SquireCardRow["kind"] }) {
  const dot = squireKindDot(props.kind);
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        dot === null ? "bg-muted-foreground/40" : DOT_TONE_CLASS[dot.tone],
      )}
    />
  );
}

export function SquireAge(props: { readonly at: string; readonly prefix?: string }) {
  const text = squireChildAgeText(useRelativeTimeState(props.at));
  if (text === "") return null;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {props.prefix === undefined ? text : `${props.prefix} ${text}`}
    </span>
  );
}

export function useSquireThreadShell(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return useQuietThreadShell(threadId === null ? null : scopeThreadRef(environmentId, threadId));
}

/** Provider statuses change on every push, so only this leaf reads them. */
export function useSquireProvider(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | null | undefined,
) {
  const providers = useEnvironmentProviders().get(environmentId);
  const provider =
    instanceId == null ? undefined : providers?.find((p) => p.instanceId === instanceId);
  return provider === undefined
    ? null
    : {
        name: resolveProviderInstanceDisplayName(provider),
        conversationFork: provider.conversationFork,
      };
}

const driverName = (driver: string): string | undefined =>
  PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES];

/** An overlap's providers named as its card's thread lines name them, from the same instances. */
function useSquireOverlapProviderNames(environmentId: EnvironmentId, row: SquireCardRow) {
  const providers = useEnvironmentProviders().get(environmentId);
  return squireOverlapProviderNames(row, {
    instanceName: (instanceId) => {
      const provider = providers?.find((p) => p.instanceId === instanceId);
      return provider === undefined ? null : resolveProviderInstanceDisplayName(provider);
    },
    driverName,
  });
}

/**
 * What a row points at: its thread, or for a thread proposal the project it would start in and
 * the provider it would run on; an overlap names its thread count. `open` is the row's "↗".
 */
function useSquireRowTarget(environmentId: EnvironmentId, row: SquireCardRow) {
  const navigate = useNavigate();
  const shell = useSquireThreadShell(environmentId, row.targetThreadId);
  const project = useProject(
    row.targetThreadId === null && row.projectId !== null
      ? scopeProjectRef(environmentId, row.projectId)
      : null,
  );
  const threadProvider = useSquireProvider(environmentId, shell?.providerInstanceId);
  const proposalInstance = useSquireProvider(
    environmentId,
    row.proposalProvider?.providerInstanceId,
  );
  const overlapProviders = useSquireOverlapProviderNames(environmentId, row);
  const threadId = row.targetThreadId;
  const name = squireRowTargetName(row, {
    threadTitle: shell?.title ?? null,
    projectTitle: project?.title ?? null,
    overlapThreads: row.overlapProviders?.length ?? null,
  });
  if (threadId !== null) {
    return {
      name,
      provider: squireRowProviderName({
        threadProvider: threadProvider?.name ?? null,
        proposalProvider: null,
      }),
      openLabel: "Open in thread",
      open: () => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId },
        });
      },
    };
  }
  return {
    name,
    provider: squireRowProviderName({
      threadProvider: null,
      proposalProvider: squireProposalProviderName(
        row.proposalProvider,
        proposalInstance?.name ?? null,
        driverName,
      ),
      overlapProviders,
    }),
    openLabel: "Open project",
    open:
      project === null
        ? null
        : () => {
            void navigate({
              to: "/projects/$projectKey",
              params: { projectKey: derivePhysicalProjectKey(project) },
            });
          },
  };
}

/**
 * Every row ends in the same three fixed columns (age, action, ↗), so actions line up down
 * the list whatever a row holds.
 */
function RowTrail(props: {
  readonly layout: "list" | "inbox";
  readonly at: string;
  /** "waiting", on an expanded card, reads with the age as one unit. */
  readonly agePrefix?: string;
  readonly action: ReactNode;
  readonly openLabel: string;
  readonly onOpen: (() => void) | null;
}) {
  return (
    <>
      <span className={cn("shrink-0 text-right", props.layout === "list" ? "w-20" : "w-10")}>
        <SquireAge
          at={props.at}
          {...(props.agePrefix === undefined ? {} : { prefix: props.agePrefix })}
        />
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center justify-end gap-1",
          props.layout === "list" ? "w-28" : "w-24",
        )}
      >
        {props.action}
      </span>
      <span className="flex w-6 shrink-0 justify-center">
        {props.onOpen === null ? null : (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.openLabel}
            title={props.openLabel}
            onClick={props.onOpen}
          >
            <ArrowUpRightIcon />
          </Button>
        )}
      </span>
    </>
  );
}

/** The row's provider; the Lead view and the inbox's narrow list leave it off every row. */
function RowProvider(props: { readonly provider: string | null; readonly capped: boolean }) {
  if (props.provider === null) return null;
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground",
        props.capped ? "min-w-0 max-w-32 shrink truncate" : "shrink-0",
      )}
    >
      {props.provider}
    </span>
  );
}

export function SquireMarkers(props: { readonly row: SquireCardRow }) {
  const markers = squireCardMarkers(props.row);
  return markers.map((marker) => (
    <Badge
      key={marker}
      size="sm"
      variant={marker === "outdated" ? "warning" : marker === "updated" ? "info" : "outline"}
    >
      {SQUIRE_MARKER_LABEL[marker]}
    </Badge>
  ));
}

function RaiserPortrait(props: { readonly raiser: SquireSnapshotEntry }) {
  const { squire } = props.raiser;
  // A row's portrait names the raiser, so it stays still and in full color with its palette
  // ring; the raiser's own state shows on its sidebar row and header.
  return (
    <SquireIndicator
      state="waiting"
      palette={squire.companion.palette}
      presence={squire.companion.presence}
      appearance={squire.companion.appearance}
      hood={squire.companion.hood}
      isLead={squire.role === "lead"}
      size={22}
      label={`Raised by ${squire.name}`}
    />
  );
}

/**
 * "<raiser> · <thread>". The raiser never shrinks, so a long title cannot clip it to a stray
 * glyph; the target gives way well before the title does, down to a readable floor. On an
 * expanded card the title comes first, so the meta is capped and truncates instead. In the
 * inbox's narrower list the meta takes its own line under the title, so the title keeps the
 * row's width.
 */
function RowMeta(props: {
  readonly meta: ReturnType<typeof squireRowMeta>;
  readonly placement: "inline" | "capped" | "below";
}) {
  const { meta, placement } = props;
  if (meta === null) return null;
  return (
    <span
      className={cn(
        "flex items-baseline gap-1 text-xs text-muted-foreground",
        placement === "below"
          ? "min-w-0"
          : placement === "capped"
            ? "min-w-0 max-w-[40%] shrink"
            : "max-w-64 shrink-[4]",
      )}
    >
      {meta.raiser === null ? null : <span className="shrink-0">{meta.raiser}</span>}
      {meta.raiser === null || meta.target === null ? null : <span aria-hidden>·</span>}
      {meta.target === null ? null : (
        <span className={cn("truncate", placement === "inline" ? "min-w-12" : "min-w-0")}>
          {meta.target}
        </span>
      )}
    </span>
  );
}

/** The inbox list's two lines: the title on the row's full width, the meta muted under it. */
function StackedText(props: { readonly title: ReactNode; readonly below: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      {props.title}
      {props.below}
    </span>
  );
}

export interface SquireRowCallbacks {
  readonly onToggle: (row: SquireCardRow) => void;
  readonly onAccept: (row: SquireCardRow) => void;
  readonly onDismiss: (row: SquireCardRow) => void;
  readonly onInactivity: (row: SquireCardRow, keep: boolean) => void;
}

/**
 * P7.2 compact decision row. Expanded, it becomes the evidence card's header (P7.3): the row
 * stays the one place the title, thread, provider, and age show, and the card body follows.
 */
export const SquireDecisionRow = memo(function SquireDecisionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly viewSquireId: SquireId;
  readonly row: SquireCardRow;
  readonly raiser: SquireSnapshotEntry | null;
  readonly layout: "list" | "inbox";
  readonly expanded: boolean;
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly callbacks: SquireRowCallbacks;
  /** The evidence card body, shown in place while expanded in the list layout. */
  readonly body: ReactNode;
  /** A held row's countdown and Undo, right under the row. */
  readonly holdLine?: ReactNode;
  /** P7.6: a newer hold of this kind sits under the row and replaces it when it runs. */
  readonly supersededNote?: string;
}) {
  const { environmentId, row, callbacks } = props;
  const target = useSquireRowTarget(environmentId, row);
  const action = squireRowAction(row);
  const compact = props.layout === "inbox";
  const steerKind = compact ? null : squireSteerKindLabel(row.steerKind);
  const meta = squireRowMeta({
    title: row.title,
    raiser: props.raiser?.squire ?? null,
    targetName: target.name,
  });
  const open = props.body !== null;
  const actionNode = open ? (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label="Collapse"
      title="Collapse"
      onClick={() => callbacks.onToggle(row)}
    >
      <ChevronUpIcon />
    </Button>
  ) : props.canAct && action !== null && action.type !== "inactivity" ? (
    <Button
      size="xs"
      // One filled primary per row; Answer and Review open the card to decide there.
      variant={action.type === "dismiss" ? "outline" : "default"}
      disabled={props.busy}
      onClick={() => {
        if (action.type === "accept") callbacks.onAccept(row);
        else if (action.type === "dismiss") callbacks.onDismiss(row);
        else callbacks.onToggle(row);
      }}
    >
      {action.label}
    </Button>
  ) : null;
  const title = (
    <span
      className={cn(
        "min-w-0 text-sm text-foreground",
        open ? "flex-1 font-medium" : "truncate",
        compact && props.expanded && "font-medium",
      )}
    >
      {open ? squireTitleBesideKind(row.title, row.kind) : row.title}
    </span>
  );
  return (
    <div
      role="listitem"
      data-squire-card={row.id}
      data-selected={props.expanded || undefined}
      className={cn(
        open
          ? "rounded-lg border border-border bg-card"
          : props.expanded
            ? // The inbox's selected row: a filled row with a left bar, so it reads at a glance
              // beside the detail pane in both themes.
              "relative rounded-md bg-accent ring-1 ring-primary/25 ring-inset before:absolute before:inset-y-1.5 before:left-0 before:w-0.75 before:rounded-full before:bg-primary"
            : "rounded-md hover:bg-accent/30",
      )}
    >
      <div className="flex min-h-9 items-center gap-2 px-2">
        <button
          type="button"
          aria-expanded={props.expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => callbacks.onToggle(row)}
        >
          <SquireKindDot kind={row.kind} />
          <span className={open ? "shrink-0 text-xs text-muted-foreground" : "sr-only"}>
            {SQUIRE_KIND_LABEL[row.kind]}
          </span>
          {props.raiser === null ? null : <RaiserPortrait raiser={props.raiser} />}
          {compact ? (
            <StackedText title={title} below={<RowMeta meta={meta} placement="below" />} />
          ) : (
            title
          )}
          {steerKind === null ? null : (
            <Badge size="sm" variant="outline">
              {steerKind}
            </Badge>
          )}
          <SquireMarkers row={row} />
          {props.supersededNote === undefined ? null : (
            <Badge size="sm" variant="warning">
              {props.supersededNote}
            </Badge>
          )}
          {compact ? null : <RowMeta meta={meta} placement={open ? "capped" : "inline"} />}
          {/* The Lead view's meta names the raiser and thread only, so rows read alike. */}
          {compact || props.raiser !== null ? null : (
            <RowProvider provider={target.provider} capped={open} />
          )}
        </button>
        <RowTrail
          layout={props.layout}
          at={squireWaitingSince(row)}
          {...(open ? { agePrefix: "waiting" } : {})}
          action={actionNode}
          openLabel={target.openLabel}
          onOpen={target.open}
        />
      </div>
      {props.holdLine}
      {open ? <div className="px-3 pb-2.5">{props.body}</div> : null}
    </div>
  );
});

/** P7.2 FYI row, never expanded: one line, or title over meta in the inbox's list. */
export const SquireFyiRow = memo(function SquireFyiRow(props: {
  readonly environmentId: EnvironmentId;
  readonly viewSquireId: SquireId;
  readonly row: SquireCardRow;
  readonly raiser: SquireSnapshotEntry | null;
  readonly layout: "list" | "inbox";
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly callbacks: SquireRowCallbacks;
}) {
  const { environmentId, row, callbacks } = props;
  const target = useSquireRowTarget(environmentId, row);
  const action = squireRowAction(row);
  const meta = squireRowMeta({
    title: row.title,
    raiser: props.raiser?.squire ?? null,
    targetName: target.name,
  });
  const text = squireFyiText(row);
  const actionNode =
    props.canAct && action?.type === "inactivity" ? (
      <>
        <Button
          size="xs"
          variant="default"
          disabled={props.busy}
          onClick={() => callbacks.onInactivity(row, true)}
        >
          Keep
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.busy}
          onClick={() => callbacks.onInactivity(row, false)}
        >
          Pause
        </Button>
      </>
    ) : props.canAct && action?.type === "dismiss" ? (
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss"
        title="Dismiss"
        disabled={props.busy}
        onClick={() => callbacks.onDismiss(row)}
      >
        <XIcon />
      </Button>
    ) : null;
  const textNode = <span className="min-w-0 truncate text-sm text-muted-foreground">{text}</span>;
  return (
    <div
      role="listitem"
      data-squire-card={row.id}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 hover:bg-accent/30",
        props.layout === "inbox" ? "min-h-8 py-1" : "h-8",
      )}
    >
      <SquireKindDot kind={row.kind} />
      {props.raiser === null ? null : <RaiserPortrait raiser={props.raiser} />}
      {props.layout === "inbox" ? (
        <StackedText title={textNode} below={<RowMeta meta={meta} placement="below" />} />
      ) : (
        <>
          {textNode}
          <RowMeta meta={meta} placement="inline" />
          {props.raiser === null ? <RowProvider provider={target.provider} capped={false} /> : null}
          <span className="flex-1" />
        </>
      )}
      <RowTrail
        layout={props.layout}
        at={row.createdAt}
        action={actionNode}
        openLabel={target.openLabel}
        onOpen={target.open}
      />
    </div>
  );
});

/** A turn summary FYI's row carries only its thread's name; the read model adds what happened. */
function squireFyiText(row: SquireCardRow): string {
  return squireFyiRowText(row.title, squireFyiNeedsText(row) ? (row.outcome ?? null) : null);
}

/** A card the user just settled, or that settled while open: one line where it was. */
export function SquireSettledRow(props: {
  readonly environmentId: EnvironmentId;
  readonly viewSquireId: SquireId;
  readonly row: SquireCardRow;
  readonly label: string;
  readonly layout: "list" | "inbox";
  readonly onClose: () => void;
}) {
  const target = useSquireRowTarget(props.environmentId, props.row);
  return (
    <div
      role="status"
      data-squire-settled={props.row.id}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground"
    >
      <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
      <span className="shrink-0 font-medium text-foreground/80">{props.label}</span>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate">{props.row.title}</span>
      <span className="flex-1" />
      <RowTrail
        layout={props.layout}
        at={props.row.createdAt}
        action={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Close"
            title="Close"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        }
        openLabel={target.openLabel}
        onOpen={target.open}
      />
    </div>
  );
}
