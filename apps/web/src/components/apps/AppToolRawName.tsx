import type { OrchestrationV2TurnItem } from "@lecturn/contracts";
import { appToolRawName } from "@lecturn/shared/appToolPresentation";

/** A titled app tool row's detail still names the tool the agent called. */
export function AppToolRawName({ item }: { readonly item: OrchestrationV2TurnItem }) {
  const name = item.type === "dynamic_tool" ? appToolRawName(item) : undefined;
  return name === undefined ? null : (
    <div
      data-testid="app-tool-raw-name"
      className="font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed text-muted-foreground select-text"
    >
      {name}
    </div>
  );
}
