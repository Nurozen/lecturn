export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}

/** First sign-in works on older relays; only adding another iOS account needs push fan-out. */
export function mobileAccountAdditionAllowed(input: {
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly accountCount: number;
  readonly sharedGateAvailable: boolean;
  readonly catalogReady: boolean;
  readonly platform: string;
  readonly multiAccountPush: boolean;
}): boolean {
  return (
    input.enabled &&
    input.loaded &&
    (input.accountCount === 0 ||
      (input.sharedGateAvailable &&
        input.catalogReady &&
        (input.platform !== "ios" || input.multiAccountPush)))
  );
}
