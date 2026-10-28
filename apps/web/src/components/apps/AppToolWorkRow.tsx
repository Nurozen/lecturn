import { ChevronRightIcon, CircleCheckIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { WorkLogRow } from "../chat/WorkLog";
import type { AppToolRowOutcome } from "./AppToolWorkRow.logic";

type AppToolWorkRowProps = ComponentProps<typeof WorkLogRow> & {
  readonly "data-app-tool-outcome"?: AppToolRowOutcome | undefined;
  /** The app's summary of this call, read after the tool's title. */
  readonly "data-app-tool-summary"?: string | undefined;
};

/**
 * Takes the standard row's props so the timeline swaps it in for app tools without restating the
 * row: the disclosure state is read back from the row's own `aria-expanded`, and `trailing` is left
 * out because this row draws its chevron first and ends on the outcome mark.
 */
export function AppToolWorkRow({
  icon,
  label,
  trailing: _trailing,
  ...rowProps
}: AppToolWorkRowProps) {
  const ariaExpanded = rowProps["aria-expanded"];
  const expanded = ariaExpanded === true || ariaExpanded === "true";
  const outcome = rowProps["data-app-tool-outcome"];
  const summary = rowProps["data-app-tool-summary"];
  const ariaLabel = rowProps["aria-label"];
  return (
    <WorkLogRow
      {...rowProps}
      {...(summary && ariaLabel ? { "aria-label": `${ariaLabel}, ${summary}` } : {})}
      data-testid="app-tool-row"
      icon={
        <ChevronRightIcon
          aria-hidden
          data-testid="app-tool-row-chevron"
          className={cn(
            "size-3.5 shrink-0 text-icon-muted transition-transform duration-200",
            expanded && "rotate-90",
            ariaExpanded === undefined && "invisible",
          )}
        />
      }
      label={
        // max-content keeps the mark beside the label, minmax(0) still lets a long label truncate.
        <span
          className={cn(
            "grid min-w-0 items-center justify-start gap-1.5",
            summary
              ? "grid-cols-[auto_minmax(0,max-content)_minmax(0,max-content)_auto]"
              : "grid-cols-[auto_minmax(0,max-content)_auto]",
          )}
        >
          {/* `contents` keeps the grid's cells as they were; the wrappers only carry the hooks. */}
          <span data-testid="app-tool-row-icon" className="contents">
            {icon}
          </span>
          {/* Only the label takes part in baseline alignment, so the grid hands the row the
              label's text baseline, which the leading chevron is set against, rather than the
              icon's bottom edge. */}
          <span data-testid="app-tool-row-label" className="contents *:self-baseline">
            {label}
          </span>
          {summary ? (
            <span
              data-testid="app-tool-row-summary"
              className="min-w-0 self-baseline truncate text-sm leading-relaxed text-muted-foreground"
            >
              <span aria-hidden>· </span>
              {summary}
            </span>
          ) : null}
          {outcome === "succeeded" ? (
            <CircleCheckIcon
              role="img"
              aria-label="Tool call succeeded"
              data-testid="app-tool-row-status"
              data-status="success"
              className="size-4 shrink-0 text-success-foreground"
            />
          ) : outcome === "failed" ? (
            <XIcon
              aria-hidden
              data-testid="app-tool-row-status"
              data-status="failed"
              className="size-3 shrink-0 text-tool-error-icon/40"
            />
          ) : null}
        </span>
      }
    />
  );
}
