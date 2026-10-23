import type { EnvironmentId } from "@lecturn/contracts";

export function resolveAutoSettleReferenceEnvironmentId(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly canWriteSettings: boolean | null;
  }>,
): EnvironmentId | null {
  for (const environment of environments) {
    if (environment.canWriteSettings === null) return null;
    if (environment.canWriteSettings) return environment.environmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios" || platform === "android"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "Unavailable on this platform" };
}

/** First sign-in works on older relays; only adding another iOS account needs push fan-out. */
export function mobileAccountAdditionAllowed(input: {
  readonly loaded: boolean;
  readonly accountCount: number;
  readonly sharedGateAvailable: boolean;
  readonly catalogReady: boolean;
  readonly platform: string;
  readonly multiAccountPush: boolean;
}): boolean {
  return (
    input.loaded &&
    (input.accountCount === 0 ||
      (input.sharedGateAvailable &&
        input.catalogReady &&
        (input.platform !== "ios" || input.multiAccountPush)))
  );
}
