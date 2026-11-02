import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@lecturn/client-runtime/environment";
import {
  squireEntryIndicator,
  type SquireEnvironmentState,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, SquireCardId, SquireCardRow, SquireId } from "@lecturn/contracts";
import { useMatch, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { memo, type ComponentProps } from "react";

import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import { cn } from "../../../lib/utils";
import { useQuietThreadShell } from "../../../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../../../state/environments";
import { squireEnvironment, useSquireEnvironments } from "../../../state/squires";
import { useUiStateStore } from "../../../uiStateStore";
import { SidebarHierarchyPanel } from "../../sidebar/SidebarHierarchyPanel";
import { SquireRoomRows } from "../rooms/SquireRoomRows";
import { openSquireRoomCreate } from "../rooms/squireRoomStore";
import { openSquireSetup } from "../setup/squireSetupStore";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../../ui/sidebar";
import { SquireHoverCard } from "../companion/SquireHoverCard";
import { squireLeadBadgeTooltip } from "../lead/squireLead.logic";
import { SquireIndicator } from "../SquireIndicator";
import { SQUIRE_PALETTE_TINT } from "../squirePaletteTint";
import type { SquireViewSearch } from "../squireView.logic";
import {
  isSquireFoldCollapsed,
  isSquireRowExpanded,
  isSquiresGroupVisible,
  parseSquireRouteKey,
  showSquireEnvironmentLabels,
  squireChildAgeText,
  squireChildRows,
  squireTeamRaisedCounts,
  squireFoldKey,
  squireKindDot,
  squireLeadBlock,
  squireLeadFold,
  squireLeadItemsLabel,
  squireLeadTrailing,
  squireRouteKey,
  squireRowLabel,
  squireRowSelection,
  squireRowStatusLine,
  squireRowTrailing,
  type SquireFoldTarget,
  type SquireKindDotTone,
  type SquireLeadBlock,
  type SquireRouteSelection,
} from "./squireSidebar.logic";

const INDICATOR_SIZE = 22;

const DOT_TONE_CLASS: Readonly<Record<SquireKindDotTone, string>> = {
  info: "bg-info",
  warning: "bg-warning",
  destructive: "bg-destructive",
  success: "bg-success",
};

/**
 * Nested lists indent from the left only. `SidebarMenuSub` insets both sides, which compounds
 * per level and stops nested rows short of the sidebar's right edge.
 */
function NestedList(props: ComponentProps<"ul">) {
  return <ul {...props} className={cn("flex min-w-0 flex-col gap-1 pl-5", props.className)} />;
}

export interface SquiresSidebarGroupProps {
  /** Thread search replaces the whole list, this group included (D37). */
  readonly isSearching: boolean;
}

type Navigate = (
  target: { readonly environmentId: EnvironmentId; readonly squireId: SquireId },
  search: SquireViewSearch,
) => void;

interface RowContext {
  readonly route: SquireRouteSelection | null;
  readonly collapsedByKey: Readonly<Record<string, boolean>>;
  readonly onToggle: (target: SquireFoldTarget) => void;
  readonly navigate: Navigate;
}

function useSquireRoute(): SquireRouteSelection | null {
  return parseSquireRouteKey(
    useMatch({
      from: "/_chat/squires/$environmentId/$squireId",
      shouldThrow: false,
      select: squireRouteKey,
    }) ?? "",
  );
}

/**
 * The Squires group at the top of the sidebar scroll list (D37). Its own memo component with its
 * own atom reads, so the sidebar's re-renders never reach it and its updates never reach them.
 */
export const SquiresSidebarGroup = memo(function SquiresSidebarGroup(
  props: SquiresSidebarGroupProps,
) {
  const environments = useSquireEnvironments();
  const identities = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const collapsedByKey = useUiStateStore((state) => state.sidebarSquireCollapsedByKey);
  const setCollapsed = useUiStateStore((state) => state.setSidebarSquireCollapsed);
  const route = useSquireRoute();
  const routerNavigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  if (
    !isSquiresGroupVisible({
      isSearching: props.isSearching,
      environmentCount: environments.length,
    })
  ) {
    return null;
  }

  const context: RowContext = {
    route,
    collapsedByKey,
    onToggle: (target) =>
      setCollapsed(squireFoldKey(target), !isSquireFoldCollapsed(collapsedByKey, target)),
    navigate: (target, search) => {
      if (isMobile) setOpenMobile(false);
      void routerNavigate({
        to: "/squires/$environmentId/$squireId",
        params: { environmentId: target.environmentId, squireId: target.squireId },
        search,
      });
    },
  };
  const groupCollapsed = isSquireFoldCollapsed(collapsedByKey, { kind: "group" });
  const labeled = showSquireEnvironmentLabels(environments.length);

  return (
    <div data-testid="squires-sidebar-group" className="flex flex-col pb-1">
      <div
        data-thread-selection-safe
        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
      >
        <button
          type="button"
          data-lecturn-hover
          aria-expanded={!groupCollapsed}
          onClick={() => context.onToggle({ kind: "group" })}
          className="mr-auto flex h-6 items-center gap-1 rounded px-1 font-medium"
        >
          Squires
          <ChevronDownIcon
            aria-hidden
            className={cn("lecturn-hierarchy-chevron size-3", groupCollapsed && "-rotate-90")}
          />
        </button>
        {/* One "+" for the group: environment blocks have no header of their own to hold one. */}
        <NewSquireMenu
          environmentId={
            environments.find((entry) => entry.environmentId === primaryEnvironmentId)
              ?.environmentId ?? environments[0]!.environmentId
          }
        />
      </div>
      <SidebarHierarchyPanel open={!groupCollapsed}>
        <div className="flex flex-col gap-1">
          {environments.map(({ environmentId, state }) => (
            <SquireEnvironmentBlock
              key={environmentId}
              environmentId={environmentId}
              state={state}
              label={
                labeled
                  ? (identities.find((identity) => identity.environmentId === environmentId)
                      ?.label ?? null)
                  : null
              }
              context={context}
            />
          ))}
        </div>
      </SidebarHierarchyPanel>
    </div>
  );
});

function NewSquireMenu(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const canCreate = useAtomValue(squireEnvironment.create.permissionAtom(environmentId));
  const canCreateRoom = useAtomValue(squireEnvironment.roomCreate.permissionAtom(environmentId));
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="New Squire or room"
            data-testid="squires-sidebar-new"
          />
        }
      >
        <PlusIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={!canCreate}
          onClick={() => openSquireSetup({ kind: "create", environmentId })}
        >
          New Squire
        </MenuItem>
        <MenuItem disabled={!canCreateRoom} onClick={() => openSquireRoomCreate({ environmentId })}>
          New room
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function SquireEnvironmentBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly state: SquireEnvironmentState;
  readonly label: string | null;
  readonly context: RowContext;
}) {
  const { environmentId, state, label, context } = props;
  const block = squireLeadBlock(state);
  const target = { kind: "environment", environmentId } as const;
  const collapsed = label !== null && isSquireFoldCollapsed(context.collapsedByKey, target);
  const rows = (
    <SidebarMenu data-testid="squire-sidebar-environment" data-environment-id={environmentId}>
      {block.lead === null ? (
        <>
          <SidebarMenuItem>
            <p
              role="status"
              data-testid="squire-sidebar-no-lead"
              className="flex h-8 items-center px-7 text-sm text-sidebar-muted-foreground"
            >
              No Lead yet
            </p>
          </SidebarMenuItem>
          {block.squires.length > 0 ? (
            <SidebarMenuItem>
              <SquireList
                environmentId={environmentId}
                squires={block.squires}
                leadId={state.lead}
                context={context}
              />
            </SidebarMenuItem>
          ) : null}
        </>
      ) : (
        <SquireRow
          environmentId={environmentId}
          entry={block.lead}
          leadId={state.lead}
          context={context}
          block={block}
        />
      )}
    </SidebarMenu>
  );
  if (label === null) return rows;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-thread-selection-safe
        data-lecturn-hover
        aria-expanded={!collapsed}
        onClick={() => context.onToggle(target)}
        className="flex h-6 items-center gap-1 rounded px-2 text-left text-2xs font-medium text-sidebar-muted-foreground"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn("lecturn-hierarchy-chevron size-3 shrink-0", collapsed && "-rotate-90")}
        />
      </button>
      <SidebarHierarchyPanel open={!collapsed}>{rows}</SidebarHierarchyPanel>
    </div>
  );
}

function SquireList(props: {
  readonly environmentId: EnvironmentId;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly leadId: SquireId | null;
  readonly context: RowContext;
}) {
  const { environmentId, squires, leadId, context } = props;
  return (
    <NestedList>
      {squires.map((entry) => (
        <SquireRow
          key={entry.squire.id}
          environmentId={environmentId}
          entry={entry}
          leadId={leadId}
          context={context}
          nested
        />
      ))}
    </NestedList>
  );
}

function SquireCountBadge(props: {
  readonly count: number;
  readonly palette: keyof typeof SQUIRE_PALETTE_TINT;
  readonly tooltip: string | null;
}) {
  const badge = (
    <span
      data-testid="squire-sidebar-badge"
      className={cn(
        // Strand is the palette's text tone (pale on dark, deep on light): at least 5.2:1
        // over this fill on every row surface, where thread drops near 3:1 in light.
        "flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-(--squire-ring)/22 px-1.5 text-2xs leading-none font-semibold text-(--squire-strand) tabular-nums ring-1 ring-(--squire-ring)/55 ring-inset",
        SQUIRE_PALETTE_TINT[props.palette],
      )}
    >
      {props.count}
    </span>
  );
  if (props.tooltip === null) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="right">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function SquireRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: SquireSnapshotEntry;
  readonly leadId: SquireId | null;
  readonly context: RowContext;
  readonly nested?: boolean;
  /** Set on the Lead's row, which folds its Squires as well as its own items. */
  readonly block?: SquireLeadBlock;
}) {
  const { environmentId, entry, leadId, context, nested = false, block } = props;
  const squire = entry.squire;
  const homeShell = useQuietThreadShell(
    squire.homeThreadId === null ? null : scopeThreadRef(environmentId, squire.homeThreadId),
  );
  const indicator = squireEntryIndicator(entry, homeShell);
  const statusLine = squireRowStatusLine(entry, indicator);
  const isLead = squire.id === leadId;
  const palette = isLead ? "gold" : squire.companion.palette;
  const label = squireRowLabel(squire.name, indicator);
  const selection = squireRowSelection(context.route, environmentId, squire.id);
  const foldTarget: SquireFoldTarget =
    block === undefined
      ? { kind: "squire", environmentId, squireId: squire.id }
      : { kind: "lead", environmentId };
  const fold =
    block === undefined
      ? {
          expandable: entry.openDecisionCount > 0,
          expanded: isSquireRowExpanded(
            context.collapsedByKey,
            { kind: "squire", environmentId, squireId: squire.id },
            entry.openDecisionCount,
          ),
        }
      : squireLeadFold(context.collapsedByKey, environmentId, block);
  const trailing =
    block === undefined
      ? squireRowTrailing(indicator)
      : squireLeadTrailing(indicator, block, fold.expandable && !fold.expanded);
  const open = (search: SquireViewSearch) =>
    context.navigate({ environmentId, squireId: squire.id }, search);
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;

  return (
    <Item>
      <div className="flex min-w-0 items-center gap-0.5">
        {fold.expandable ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`${fold.expanded ? "Collapse" : "Expand"} ${squire.name}`}
            aria-expanded={fold.expanded}
            data-testid="squire-sidebar-expand"
            onClick={() => context.onToggle(foldTarget)}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("lecturn-hierarchy-chevron", !fold.expanded && "-rotate-90")}
            />
          </Button>
        ) : (
          <span aria-hidden className="size-5 shrink-0" />
        )}
        <SidebarMenuButton
          isActive={selection.active}
          aria-label={label}
          aria-current={selection.active ? "page" : undefined}
          data-testid="squire-sidebar-row"
          data-squire-id={squire.id}
          data-squire-role={isLead ? "lead" : "squire"}
          className="min-w-0 flex-1"
          onClick={() => open({})}
        >
          <SquireHoverCard
            cardKey={`${environmentId}:${squire.id}`}
            entry={entry}
            indicator={indicator}
            isLead={isLead}
          >
            <SquireIndicator
              state={indicator.state}
              palette={squire.companion.palette}
              presence={squire.companion.presence}
              appearance={squire.companion.appearance}
              hood={squire.companion.hood}
              isLead={isLead}
              size={INDICATOR_SIZE}
              label={label}
            />
          </SquireHoverCard>
          <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{squire.name}</span>
          {trailing.kind === "working" ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">working</span>
          ) : trailing.kind === "badge" ? (
            <SquireCountBadge
              count={trailing.count}
              palette={palette}
              tooltip={
                block === undefined
                  ? null
                  : squireLeadBadgeTooltip({
                      lead: block.lead,
                      squires: squireTeamRaisedCounts(block.squires),
                    })
              }
            />
          ) : null}
        </SidebarMenuButton>
      </div>
      {statusLine === null ? null : (
        <NestedList>
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              size="sm"
              render={<button type="button" />}
              className="w-full"
              onClick={() => open({})}
            >
              <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
                {statusLine}
              </span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        </NestedList>
      )}
      {fold.expandable ? (
        <SidebarHierarchyPanel open={fold.expanded}>
          {entry.openDecisionCount > 0 ? (
            <SquireDecisionRows
              environmentId={environmentId}
              squireId={squire.id}
              leadId={leadId}
              openDecisionCount={entry.openDecisionCount}
              leadRaisedDecisionCount={entry.leadRaisedDecisionCount ?? 0}
              label={block === undefined ? null : squireLeadItemsLabel(block)}
              selectedItem={selection.selectedItem}
              onOpen={open}
            />
          ) : null}
          {block !== undefined && block.squires.length > 0 ? (
            <SquireList
              environmentId={environmentId}
              squires={block.squires}
              leadId={leadId}
              context={context}
            />
          ) : null}
          {block !== undefined && block.rooms.length > 0 ? (
            <SquireRoomRows
              environmentId={environmentId}
              rooms={block.rooms}
              squires={block.lead === null ? block.squires : [block.lead, ...block.squires]}
            />
          ) : null}
        </SidebarHierarchyPanel>
      ) : null}
    </Item>
  );
}

/** Mounted only while the row is open, so a folded Squire runs no items query (R37). */
function SquireDecisionRows(props: {
  readonly environmentId: EnvironmentId;
  readonly squireId: SquireId;
  readonly leadId: SquireId | null;
  readonly openDecisionCount: number;
  readonly leadRaisedDecisionCount: number;
  readonly label: string | null;
  readonly selectedItem: SquireCardId | null;
  readonly onOpen: (search: SquireViewSearch) => void;
}) {
  const { environmentId, squireId, leadId, openDecisionCount, selectedItem, onOpen } = props;
  const result = useAtomValue(squireEnvironment.decisionItems({ environmentId, squireId }));
  const items = Option.getOrNull(AsyncResult.value(result))?.items ?? [];
  const { rows, moreCount } = squireChildRows(items, {
    squireId,
    leadId,
    openDecisionCount,
    leadRaisedDecisionCount: props.leadRaisedDecisionCount,
  });
  if (rows.length === 0 && moreCount === 0) return null;
  return (
    <NestedList data-testid="squire-sidebar-decisions">
      {props.label === null ? null : (
        <li className="flex h-5 items-center px-2 text-2xs font-medium text-sidebar-muted-foreground">
          {props.label}
        </li>
      )}
      {rows.map((item) => (
        <SquireDecisionRow
          key={item.id}
          item={item}
          selected={item.id === selectedItem}
          onSelect={() => onOpen({ item: item.id })}
        />
      ))}
      {moreCount > 0 ? (
        <SidebarMenuSubItem>
          <SidebarMenuSubButton
            size="sm"
            render={<button type="button" />}
            className="w-full"
            onClick={() => onOpen({})}
          >
            <span className="text-muted-foreground">+{moreCount} more</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </NestedList>
  );
}

function SquireDecisionRow(props: {
  readonly item: SquireCardRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { item, selected, onSelect } = props;
  const dot = squireKindDot(item.kind);
  const age = squireChildAgeText(useRelativeTimeState(item.createdAt));
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        size="sm"
        isActive={selected}
        aria-current={selected ? "true" : undefined}
        data-testid="squire-sidebar-decision"
        data-squire-item-id={item.id}
        render={<button type="button" />}
        className="w-full"
        onClick={onSelect}
      >
        {dot === null ? null : (
          <span
            role="img"
            aria-label={dot.label}
            className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE_CLASS[dot.tone])}
          />
        )}
        {/* A <button> centres its text, so a short title would start right of a long one. */}
        <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{age}</span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
