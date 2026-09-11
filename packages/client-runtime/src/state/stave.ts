/**
 * Stave visibility gates shared by web and mobile.
 *
 * Three facts decide what a client may show: the server build ships the
 * integration (`capabilities.stave`, a static descriptor fact), the user
 * turned it on (`settings.stave.enabled`, pushed live), and a binary is
 * runnable (`stave.getStatus`, a live probe). Configuration rows render on
 * the first fact alone so a user can recover from "no binary"; feature UI
 * (wizard, space actions, badges) needs all three.
 */

// Structural shapes so callers can pass a full `ServerConfig`/`ServerSettings`/
// `StaveStatus` or just the slice they hold.
type ConfigLike =
  | { readonly environment: { readonly capabilities: { readonly stave?: unknown } } }
  | null
  | undefined;
type SettingsLike = { readonly stave: { readonly enabled: boolean } } | null | undefined;
type StatusLike = { readonly runnable: unknown } | null | undefined;

/** The environment's server build has the Stave integration at all. */
export function environmentSupportsStave(config: ConfigLike): boolean {
  return config?.environment.capabilities.stave !== undefined;
}

/** Stave feature UI may render: supported, enabled, and a binary is runnable. */
export function staveFeatureAvailable(input: {
  readonly config: ConfigLike;
  readonly settings: SettingsLike;
  readonly status: StatusLike;
}): boolean {
  return (
    environmentSupportsStave(input.config) &&
    input.settings?.stave.enabled === true &&
    input.status?.runnable != null
  );
}
