import { type ConnectionCatalogEntry, hasRelayRoute } from "@lecturn/client-runtime/connection";
import type { EnvironmentId } from "@lecturn/contracts";

interface OnboardingEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: string };
  readonly entry: Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">;
}

export function isOnboardingRelayEnvironment(
  environment: Pick<OnboardingEnvironment, "entry">,
): boolean {
  return hasRelayRoute(environment.entry);
}

/** Keep a directly paired machine pinned while its initial connection completes. */
export function resolveOnboardingTargetEnvironment<TEnvironment extends OnboardingEnvironment>({
  mode,
  environments,
  primaryEnvironment,
  pairedEnvironmentId,
  retainLocalTarget = false,
}: {
  readonly mode: "local" | "connect" | "direct";
  readonly environments: ReadonlyArray<TEnvironment>;
  readonly primaryEnvironment: TEnvironment | null;
  readonly pairedEnvironmentId: EnvironmentId | null;
  readonly retainLocalTarget?: boolean;
}): TEnvironment | null {
  // Agent setup owns a live PTY: reconnecting must not unmount its owner.
  if (mode === "local" && retainLocalTarget) return primaryEnvironment;

  if (mode === "direct" && pairedEnvironmentId !== null) {
    const pairedEnvironment = environments.find(
      (environment) => environment.environmentId === pairedEnvironmentId,
    );
    return pairedEnvironment?.connection.phase === "connected" ? pairedEnvironment : null;
  }

  const connectedRelayEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && isOnboardingRelayEnvironment(environment),
  );

  if (mode === "connect" && connectedRelayEnvironments.length > 0) {
    return connectedRelayEnvironments[connectedRelayEnvironments.length - 1] ?? null;
  }

  if (primaryEnvironment?.connection.phase === "connected") {
    return primaryEnvironment;
  }

  return mode === "local" ? null : (connectedRelayEnvironments[0] ?? null);
}
