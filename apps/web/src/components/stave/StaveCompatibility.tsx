import type { StaveStatus } from "@lecturn/contracts";
import { staveOperationLabel, staveProviderSupportText } from "./staveCompatibility.logic";

export function StaveCompatibilityNotice({ status }: { status: StaveStatus | null | undefined }) {
  const unavailable = status?.features?.unsupportedOperations ?? [];
  const diagnostics = status?.diagnostics ?? [];
  if (unavailable.length === 0 && diagnostics.length === 0) return null;
  return (
    <div className="space-y-2 text-xs text-muted-foreground" role="status">
      {unavailable.length > 0 ? (
        <p>
          Unavailable with this binary: {unavailable.map(staveOperationLabel).join(", ")}. Select a
          compatible binary to enable these actions.
        </p>
      ) : null}
      {diagnostics.map((diagnostic) => (
        <p key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</p>
      ))}
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};
export function StaveMemoryProviderSupport({
  providers,
}: {
  providers: StaveStatus["memoryWiringProviders"];
}) {
  if (providers === undefined)
    return (
      <p className="text-xs text-muted-foreground">
        This server has not reported provider memory support.
      </p>
    );
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        Adapter support for attached Stave memory. This does not confirm a live memory connection.
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        {providers.map((row) => (
          <div key={row.provider} className="contents">
            <dt>{PROVIDER_LABELS[row.provider] ?? row.provider}</dt>
            <dd className="text-muted-foreground">{staveProviderSupportText(row)}</dd>
          </div>
        ))}
      </dl>
      {providers.some((row) => row.limitation === "external_server_unsupported") ? (
        <p className="text-muted-foreground">
          External OpenCode servers do not receive this machine's memory configuration.
        </p>
      ) : null}
    </div>
  );
}
