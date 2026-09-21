/** A configured link alone is not evidence that the relay can reach the host. */
export function relayHealthLabel(input: {
  readonly deviceRelayConflict?: string | null | undefined;
  readonly linked: boolean;
  readonly managedTunnel: boolean;
  readonly checking: boolean;
  readonly error?: string | null | undefined;
  readonly availability?: "checking" | "online" | "offline" | "error" | undefined;
  readonly offline: boolean;
}): string {
  if (input.deviceRelayConflict) return "Relay in use by another installation";
  if (input.error) return input.error;
  if (input.checking) return "Checking relay status…";
  if (!input.linked) return "Not linked";
  if (!input.managedTunnel) return "Activity publishing only · managed relay disabled";
  if (input.offline) return "This client is offline. Relay health cannot be checked.";
  switch (input.availability) {
    case "online":
      return "Online · relay can reach this environment";
    case "offline":
      return "Offline · relay cannot reach this environment";
    case "error":
      return "Relay health check failed";
    case "checking":
      return "Checking relay status…";
    default:
      return "Linked · sign in to the associated account to check relay health";
  }
}
