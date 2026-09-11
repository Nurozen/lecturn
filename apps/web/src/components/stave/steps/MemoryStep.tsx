import { XIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { memorySuggestions, type StaveWizardContext } from "../staveSpaceWizard.logic";

/**
 * Memory specs to attach: free text plus the dens the listed spaces already
 * use. Shared by the space wizard and the saga form, so it works on the bare
 * list and the owner folds the toggle into its own state.
 */
export function MemoryStep(props: {
  readonly memory: ReadonlyArray<string>;
  readonly context: StaveWizardContext;
  readonly onToggle: (spec: string) => void;
}) {
  const { memory, context, onToggle } = props;
  const [draft, setDraft] = useState("");
  const suggestions = memorySuggestions(context.spaces).filter(
    (suggestion) => !memory.includes(suggestion.value),
  );

  const add = () => {
    const spec = draft.trim();
    if (spec.length === 0) return;
    onToggle(spec);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="stave-wizard-memory-spec">Memory spec</Label>
        <div className="flex items-center gap-2">
          <Input
            id="stave-wizard-memory-spec"
            size="sm"
            className="font-mono"
            value={draft}
            placeholder="[provider:]<id> or . for a fresh task store"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter adds the spec; it never advances the wizard from here.
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              add();
            }}
          />
          <Button size="sm" variant="outline" disabled={draft.trim().length === 0} onClick={add}>
            Add
          </Button>
        </div>
      </div>

      {memory.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Chosen memory specs">
          {memory.map((spec) => (
            <Badge
              data-lecturn-hover
              key={spec}
              variant="outline"
              size="control"
              className="font-mono"
              render={<button type="button" aria-label={`Remove ${spec}`} />}
              onClick={() => onToggle(spec)}
            >
              {spec}
              <XIcon />
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No memory attached; the space starts without one.
        </p>
      )}

      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Suggestions</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion.value}
                size="xs"
                variant="outline"
                className="font-mono"
                onClick={() => onToggle(suggestion.value)}
              >
                {suggestion.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
