import { filterStaveRepoRows } from "@lecturn/client-runtime/stave-repo-filter";
import type { StaveRepoRow } from "@lecturn/contracts";
import { SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import type { StaveWizardRepoRow } from "@lecturn/client-runtime/state/stave-space-wizard";

/**
 * The registry repo list shared by the space and saga wizards: a filter box,
 * a selected count, and a bounded scroll area so a long registry never grows
 * the dialog. Filtering only hides rows; selections live in the caller's rows.
 */
export function StaveRepoPicker<Row extends StaveWizardRepoRow>(props: {
  readonly rows: ReadonlyArray<Row>;
  readonly registry: ReadonlyArray<StaveRepoRow>;
  /** Shown instead of the picker when there are no rows at all. */
  readonly empty: ReactNode;
  readonly renderRow: (row: Row) => ReactNode;
  readonly listClassName?: string;
}) {
  const { rows, registry, empty, renderRow, listClassName = "flex flex-col gap-2" } = props;
  const [query, setQuery] = useState("");

  if (rows.length === 0) return empty;

  const visible = filterStaveRepoRows(rows, query, registry);
  const selected = rows.filter((row) => row.mode !== "none").length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            size="sm"
            value={query}
            placeholder="Filter repos by name or branch"
            aria-label="Filter repos"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter filters; it never advances or submits the surrounding form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
        </InputGroup>
        <p className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {selected} of {rows.length} selected
        </p>
      </div>
      <ScrollArea scrollFade className="max-h-80">
        {visible.length === 0 ? (
          <p className="rounded-lg border border-border/70 bg-muted/35 p-3 text-sm text-muted-foreground">
            No repos match “{query.trim()}”.
          </p>
        ) : (
          <div className={listClassName}>{visible.map(renderRow)}</div>
        )}
      </ScrollArea>
    </div>
  );
}
