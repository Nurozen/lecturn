/** A configured link alone is not evidence that the relay can reach the host. */
export function relayHealthStatus(input: {
  readonly deviceRelayConflict?: string | null | undefined;
  readonly linked: boolean;
  readonly managedTunnel: boolean;
  readonly checking: boolean;
  readonly error?: string | null | undefined;
  readonly availability?: "checking" | "online" | "offline" | "error" | undefined;
  readonly offline: boolean;
}): { label: string; tone: "online" | "checking" | "offline" | "error" | "inactive" } {
  if (input.deviceRelayConflict)
    return { label: "Relay in use by another installation", tone: "error" };
  if (input.error) return { label: input.error, tone: "error" };
  if (input.checking) return { label: "Checking relay status…", tone: "checking" };
  if (!input.linked) return { label: "Not linked", tone: "inactive" };
  if (!input.managedTunnel)
    return { label: "Activity publishing only · managed relay disabled", tone: "inactive" };
  if (input.offline)
    return { label: "This client is offline. Relay health cannot be checked.", tone: "offline" };
  switch (input.availability) {
    case "online":
      return { label: "Online · relay can reach this environment", tone: "online" };
    case "offline":
      return { label: "Offline · relay cannot reach this environment", tone: "offline" };
    case "error":
      return { label: "Relay health check failed", tone: "error" };
    case "checking":
      return { label: "Checking relay status…", tone: "checking" };
    default:
      return {
        label: "Linked · sign in to the associated account to check relay health",
        tone: "inactive",
      };
  }
}

export function relayHealthLabel(input: Parameters<typeof relayHealthStatus>[0]): string {
  return relayHealthStatus(input).label;
}
