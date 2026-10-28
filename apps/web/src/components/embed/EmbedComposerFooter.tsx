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
 * real rows, the controls ("model | effort | access") and then Contextual, while attach and send
 * sit at the end of the input line above it; ChatComposer pads the editor by the actions' width
 * so text never runs under them. The wrappers stay mounted while the composer rests, as
 * `contents`, so the controls and actions keep their state across a collapse.
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
  return (
    <div
      className={cn(className, stacked && "relative flex-col items-stretch gap-1 sm:gap-1")}
      data-testid="embed-composer-footer"
      data-embed-composer-footer-stacked={stacked ? "true" : undefined}
      {...props}
    >
      <div
        data-testid="embed-composer-footer-row"
        className={stacked ? "flex min-w-0 items-center" : "contents"}
      >
        {controls}
      </div>
      {stacked && contextual ? (
        <div
          data-testid="embed-composer-footer-row"
          data-embed-composer-contextual-row
          className="-ms-2.5 flex min-w-0 items-center"
        >
          {contextual}
        </div>
      ) : null}
      <div
        data-testid="embed-composer-inline-actions"
        // One prompt line tall above the editor body's bottom padding, so the actions center on
        // the input line whatever their height, and inset by the footer's padding.
        className={
          stacked
            ? "absolute end-3 bottom-full mb-2 flex h-[calc(var(--font-size-prompt,var(--text-sm))*1.625)] items-center sm:end-4"
            : "contents"
        }
      >
        {actions}
      </div>
    </div>
  );
}
