import { Children, type ComponentProps, type ReactNode } from "react";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { cn } from "../../lib/utils";

/**
 * The embed stacks the expanded footer only; the resting and provider-setup footers keep their
 * single row. ChatComposer leaves Contextual out of the controls row while this holds, since this
 * footer renders it on the second row.
 */
export function useEmbedComposerFooterStacked(expanded: boolean): boolean {
  return useEmbedPresentation() !== null && expanded;
}

/**
 * The composer footer. Outside the embed it is the footer div itself. In the embed pane it has two
 * real rows: the controls ("model | effort | access") on the first, then Contextual with the
 * attach and send actions on the second. The row wrappers stay mounted while the composer rests,
 * as `contents`, so the controls and actions keep their state across a collapse.
 */
export function EmbedComposerFooter({
  stacked,
  contextual,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  stacked: boolean;
  contextual: ReactNode;
}) {
  const embedded = useEmbedPresentation() !== null;
  if (!embedded) {
    return (
      <div {...props} className={className}>
        {children}
      </div>
    );
  }
  // ChatComposer passes exactly two children: the controls, then the actions.
  const [controls, actions] = Children.toArray(children);
  const row = cn("flex min-w-0 items-center", !stacked && "contents");
  return (
    <div
      className={cn(className, stacked && "flex-col items-stretch gap-1 sm:gap-1")}
      data-testid="embed-composer-footer"
      data-embed-composer-footer-stacked={stacked ? "true" : undefined}
      {...props}
    >
      <div data-testid="embed-composer-footer-row" className={row}>
        {controls}
      </div>
      <div data-testid="embed-composer-footer-row" className={cn(row, "justify-end gap-2")}>
        {stacked && contextual ? <div className="-ms-2.5 me-auto min-w-0">{contextual}</div> : null}
        {actions}
      </div>
    </div>
  );
}
