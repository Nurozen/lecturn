import type { ServerProvider } from "@lecturn/contracts";
import { formatProviderDriverKindLabel } from "../providerModels";

export function providerDetectionLabel(provider: ServerProvider): string {
  const name = provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver);
  switch (provider.discovery?.status) {
    case "detecting":
      return provider.discovery.phase === "shell"
        ? "Loading shell environment…"
        : `Detecting ${name}…`;
    case "timed-out":
      return `${name} detection timed out`;
    case "ready":
      return `${name} detection is ready`;
    default:
      return `${name} could not be started`;
  }
}

export function providerDetectionSendBlock(
  provider: ServerProvider | null | undefined,
): string | null {
  // A cached installed flag does not prove the executable is on the current PATH.
  if (
    provider?.discovery?.status === "detecting" ||
    provider?.discovery?.status === "timed-out" ||
    provider?.discovery?.status === "error"
  ) {
    return providerDetectionLabel(provider);
  }
  return null;
}

export function isProviderExecutableError(error: string): boolean {
  // ENOENT by itself can describe a missing project directory or user file.
  return /Provider detection (?:is still running|did not finish successfully)|Failed to spawn (?:Codex App Server|.*provider|Claude)|spawn\s+(?:[^\n]*[/\\])?(?:codex|claude|cursor(?:-agent)?|agent|grok|opencode|antigravity)(?:\.(?:exe|cmd))?\s+ENOENT/i.test(
    error,
  );
}

/** Cached discovery snapshots do not describe work happening on an offline environment. */
export function shouldShowProviderDetection(provider: ServerProvider, connected: boolean): boolean {
  return (
    connected &&
    (provider.discovery?.status === "detecting" ||
      provider.discovery?.status === "timed-out" ||
      (provider.discovery?.status === "error" && provider.installed))
  );
}
