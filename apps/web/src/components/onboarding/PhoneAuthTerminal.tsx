import { useId, useState, type ReactNode } from "react";
import { Button } from "../ui/button";

/** Keep the PTY/output subscription mounted while its optional UI is collapsed. */
export function PhoneAuthTerminal({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: (visible: boolean) => ReactNode;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const visible = !enabled || expanded;
  return (
    <>
      {enabled ? (
        <div className="space-y-2 p-3">
          <Button
            className="min-h-12 w-full"
            variant="outline"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => {
              setExpanded(!expanded);
              setInteractive(false);
            }}
          >
            {expanded ? "Hide terminal details" : "Show terminal details"}
          </Button>
          {expanded ? (
            <>
              <p className="text-xs text-muted-foreground">
                {interactive
                  ? "Terminal input enabled. Tap the terminal to type."
                  : "Read-only terminal. Use the sign-in controls above, or enable advanced input if needed."}
              </p>
              <Button
                className="min-h-12 w-full"
                variant="outline"
                aria-pressed={interactive}
                onClick={() => setInteractive(!interactive)}
              >
                {interactive ? "Disable terminal input" : "Enable advanced terminal input"}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div id={id} hidden={!visible} className="h-64" inert={enabled && !interactive}>
        {children(visible)}
      </div>
    </>
  );
}
