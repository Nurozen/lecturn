import type { AppHeadlessTools, AppRuntimeCeiling } from "@lecturn/contracts";

import { cn } from "~/lib/utils";
import {
  appEnvEntries,
  formatAppCommandLine,
  RUNTIME_CEILING_OPTIONS,
  runtimeCeilingFromKey,
  runtimeCeilingKey,
  runtimeCeilingLabel,
} from "../settings/ConnectedAppsSettings.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ConnectedAppIcon({
  iconDataUrl,
  size = "sm",
}: {
  readonly iconDataUrl: string;
  readonly size?: "sm" | "lg";
}) {
  return (
    <img
      src={iconDataUrl}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("shrink-0 rounded-md object-cover", size === "lg" ? "size-10" : "size-5")}
    />
  );
}

/** The exact process Lecturn will spawn for the app, as approved. */
export function ConnectedAppCommand({ tools }: { readonly tools: AppHeadlessTools | null }) {
  if (tools === null) {
    return (
      <p className="text-xs text-muted-foreground">
        No headless command. The app's tools work only while it is open.
      </p>
    );
  }
  const env = appEnvEntries(tools);
  return (
    <div className="space-y-1.5" data-testid="connected-app-command">
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all text-foreground/90">
        {formatAppCommandLine(tools)}
      </pre>
      {env.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
          {env.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="break-all text-foreground/90">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">No extra environment variables.</p>
      )}
      <p className="text-xs text-muted-foreground">
        Runs in the workspace folder; <code className="font-mono">{"{workspaceRoot}"}</code> is
        replaced with it.
      </p>
    </div>
  );
}

export function ConnectedAppGatedTools({
  toolPrefix,
  gatedTools,
}: {
  readonly toolPrefix: string;
  readonly gatedTools: ReadonlyArray<string>;
}) {
  if (gatedTools.length === 0) {
    return <p className="text-xs text-muted-foreground">None. The app may still ask per call.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5">
      {gatedTools.map((tool) => (
        <li key={tool}>
          <code className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-foreground/90">
            {`${toolPrefix}_${tool}`}
          </code>
        </li>
      ))}
    </ul>
  );
}

export function RuntimeCeilingSelect({
  value,
  disabled = false,
  onChange,
}: {
  readonly value: AppRuntimeCeiling;
  readonly disabled?: boolean;
  readonly onChange: (next: AppRuntimeCeiling) => void;
}) {
  return (
    <Select
      value={runtimeCeilingKey(value)}
      disabled={disabled}
      onValueChange={(next) => {
        const option = RUNTIME_CEILING_OPTIONS.find((candidate) => candidate.key === next);
        if (option !== undefined) onChange(runtimeCeilingFromKey(option.key));
      }}
    >
      <SelectTrigger size="sm" aria-label="Runtime ceiling">
        <SelectValue>{runtimeCeilingLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {RUNTIME_CEILING_OPTIONS.map((option) => (
          <SelectItem key={option.key} value={option.key}>
            <div className="flex flex-col">
              <span>{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </div>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
