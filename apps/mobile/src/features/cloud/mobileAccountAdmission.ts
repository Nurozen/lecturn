import { decideAddAccountGate } from "@lecturn/client-runtime/relay";

type GateInput = Parameters<typeof decideAddAccountGate>[0];
/** Existing accounts remain admitted during expiry, relay outages, and policy changes. */
export function rejectedMobileAccountIds(input: {
  readonly knownAccountIds: readonly string[];
  readonly observedAccountIds: readonly string[];
  readonly platform: string;
  readonly multiAccountPush: boolean;
  readonly clerkSingleSessionMode: GateInput["clerkSingleSessionMode"];
  readonly targets: GateInput["targets"];
  readonly unlistedRelayEnvironmentIds: GateInput["unlistedRelayEnvironmentIds"];
}): ReadonlySet<string> {
  const admitted = new Set(input.knownAccountIds);
  const rejected = new Set<string>();
  for (const id of input.observedAccountIds) {
    if (admitted.has(id)) continue;
    const gate = decideAddAccountGate({
      clerkSingleSessionMode: input.clerkSingleSessionMode,
      targets: input.targets,
      unlistedRelayEnvironmentIds: input.unlistedRelayEnvironmentIds,
      knownAccountCount: admitted.size,
    });
    if (
      admitted.size === 0 ||
      (gate.available && (input.platform !== "ios" || input.multiAccountPush))
    )
      admitted.add(id);
    else rejected.add(id);
  }
  return rejected;
}
