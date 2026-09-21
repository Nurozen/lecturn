import { accountTintColor } from "@lecturn/shared/accountTint";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/models";
import { PlusIcon } from "lucide-react";
import {
  createContext,
  Fragment,
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

import { connectAccountProfilesAtom } from "../../cloud/connectAccounts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { cn } from "../../lib/utils";
import {
  layoutSegmentBars,
  NO_ACCOUNT_SEGMENT_ID,
  OWNS_EVERY_ENVIRONMENT,
  segmentLabelDomId,
  segmentListDomId,
} from "./sidebarSegments.logic";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import { SidebarAccountBar } from "./SidebarAccountBar";
import type {
  SidebarSegmentsView,
  SidebarShelfActions,
  SidebarThreadListScope,
  SidebarThreadSegmentView,
} from "./useSidebarSegments";

/** What the list body reads per list: the scope, its shelf actions, and the pinned rows in drag order. */
export interface SidebarListBodyScope<Node>
  extends SidebarThreadListScope<Node>, SidebarShelfActions {
  readonly orderedPinnedThreads: ReadonlyArray<EnvironmentThreadShell>;
}

interface SidebarSegmentsProps<Node> {
  readonly view: SidebarSegmentsView<Node>;
  readonly orderedThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly orderedPinnedThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Attaches auto-animate. Every segment's list gets its own. */
  readonly ref: Ref<HTMLUListElement>;
  readonly role: string;
  readonly className: string;
  /** The list body, then what the one-list sidebar renders after it. */
  readonly children: readonly [(scope: SidebarListBodyScope<Node>) => ReactNode, ReactNode];
}

/**
 * The sidebar's thread list. With one list it renders exactly the `<ul>` the
 * sidebar always had. With segments it renders one list per account, each
 * under its bar, and the body runs once per segment over that segment's scope.
 */
export function SidebarSegments<Node>(props: SidebarSegmentsProps<Node>) {
  const { view, children, ref, role, className } = props;
  const [renderBody, oneListTail] = children;
  if (view.segments === null) {
    return (
      <ul ref={ref} role={role} className={className}>
        {renderBody({
          ...view.unsegmented,
          orderedThreads: props.orderedThreads,
          orderedPinnedThreads: props.orderedPinnedThreads,
        })}
        {oneListTail}
      </ul>
    );
  }
  return <SegmentedLists {...props} segments={view.segments} />;
}

const SegmentOwnsEnvironment = createContext(OWNS_EVERY_ENVIRONMENT);

/**
 * Whether the list being rendered shows an environment's drafts. Always true
 * in the one list. The draft block reads it, since a draft's project can be
 * unloaded while its environment still says which segment it belongs to.
 */
export const useSegmentOwnsEnvironment = () => useContext(SegmentOwnsEnvironment);

function SegmentedLists<Node>(
  props: SidebarSegmentsProps<Node> & {
    readonly segments: ReadonlyArray<SidebarThreadSegmentView<Node>>;
  },
) {
  const { view, segments, ref, role, className } = props;
  const [renderBody] = props.children;
  const known = useAtomValue(knownConnectAccountsAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const layout = layoutSegmentBars(segments);

  // The bars are opaque and mark the viewport's edges themselves, and the
  // viewport's fade would fade them, so it is off while segments render.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = rootRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    viewport.dataset.scrollFade = "off";
    return () => {
      delete viewport.dataset.scrollFade;
    };
  }, []);

  return (
    <div ref={rootRef} data-sidebar-segments className="flex flex-col">
      {segments.map((segment, index) => {
        const pinned = new Set(segment.pinnedThreads);
        const { top, bottom, coveredTop, coveredBottom } = layout[index]!;
        const labelId = segmentLabelDomId(segment.id);
        const listId = segmentListDomId(segment.id);
        const actions = view.shelfActionsOf(segment.id);
        return (
          <Fragment key={segment.id}>
            {segment.accountId === null ? (
              // No account, no label: a rule that ends the last account's segment.
              <div
                role="separator"
                data-sidebar-account-bar={NO_ACCOUNT_SEGMENT_ID}
                className="sticky z-10 flex h-2 shrink-0 items-center bg-sidebar"
                style={{ top }}
              >
                <span className="h-px flex-1 bg-sidebar-border/60" />
              </div>
            ) : (
              <SidebarAccountBar
                accountId={segment.accountId}
                label={
                  profiles.get(segment.accountId)?.email ??
                  `Lecturn Connect account ${known.accountIds.indexOf(segment.accountId) + 1}`
                }
                labelId={labelId}
                listId={listId}
                collapsed={segment.collapsed}
                attention={segment.attention}
                needsSignIn={known.needsSignIn.includes(segment.accountId)}
                hasRows={segment.hasRows}
                stickyOffsets={{ top, bottom }}
                onToggle={view.toggleSegment}
              />
            )}
            <Collapsible open={!segment.collapsed} className="contents">
              <CollapsiblePanel
                inert={segment.collapsed || undefined}
                aria-hidden={segment.collapsed || undefined}
                className="lecturn-account-collapse motion-reduce:transition-none"
                style={(state) =>
                  ({
                    "--account-tint": accountTintColor(
                      profiles.get(segment.accountId ?? "")?.preset,
                    ),
                    // Preserve row focus rings and project glow when the fold is idle.
                    ...(state.open && state.transitionStatus === "idle"
                      ? { overflow: "visible" }
                      : {}),
                  }) as CSSProperties
                }
              >
                <ul
                  ref={ref}
                  role={role}
                  id={listId}
                  {...(segment.accountId === null
                    ? { "aria-label": "Threads outside Lecturn Connect accounts" }
                    : { "aria-labelledby": labelId })}
                  // A row scrolled to by focus stays clear of the bars stuck over its edges.
                  className={cn(
                    className,
                    "[&_:is(a,button,[tabindex])]:scroll-mt-(--covered-top) [&_:is(a,button,[tabindex])]:scroll-mb-(--covered-bottom)",
                    // The bar already says an account has no threads: drop the bare list heading.
                    segment.accountId !== null &&
                      !segment.hasRows &&
                      "[&>li[data-thread-selection-safe]]:hidden",
                  )}
                  style={
                    {
                      "--covered-top": coveredTop,
                      "--covered-bottom": coveredBottom,
                    } as CSSProperties
                  }
                >
                  <SegmentOwnsEnvironment value={segment.ownsEnvironment}>
                    {renderBody({
                      ...segment,
                      ...actions,
                      orderedPinnedThreads: props.orderedPinnedThreads.filter((thread) =>
                        pinned.has(thread),
                      ),
                    })}
                  </SegmentOwnsEnvironment>
                  {!view.nestSagaProjects &&
                  segment.settledShelfExpanded &&
                  segment.hiddenSettledCount > 0 ? (
                    <li className="list-none">
                      <button
                        type="button"
                        onClick={actions.showMoreSettled}
                        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        <PlusIcon aria-hidden className="size-4 shrink-0" />
                        Show {Math.min(segment.hiddenSettledCount, view.settledPageCount)} more
                      </button>
                    </li>
                  ) : null}
                </ul>
              </CollapsiblePanel>
            </Collapsible>
          </Fragment>
        );
      })}
    </div>
  );
}
