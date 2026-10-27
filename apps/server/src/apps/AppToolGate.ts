/**
 * Whether an app tool call may go ahead, must ask the user, or is refused
 * (D1, D2). AppToolkit asks before forwarding a call (`static`) and again when
 * the app answers `lecturn/approval-required` (`app`).
 *
 * This is the only place app tools are gated: Claude pre-approves every
 * `mcp__lecturn__*` tool, so no provider ever asks on Lecturn's behalf. Any
 * mode this file does not know is treated as Read-only.
 */
import type {
  AppRuntimeCeiling,
  AuthMcpClientAccess,
  ProviderInteractionMode,
  RuntimeMode,
} from "@lecturn/contracts";

export interface AppToolGateInput {
  readonly stage: "static" | "app";
  /** The tool is in the registration's `gatedTools`. */
  readonly gated: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly ceiling: AppRuntimeCeiling;
}

export type AppToolGateDecision =
  | { readonly kind: "forward"; readonly approved: boolean }
  | { readonly kind: "ask" }
  | { readonly kind: "refuse"; readonly reason: string };

/** Least to most permissive; a ceiling caps the thread's mode at its own rank. */
const ACCESS_ORDER = [
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<AuthMcpClientAccess>;

const rankOf = (access: string) => Math.max(0, ACCESS_ORDER.indexOf(access as AuthMcpClientAccess));

// Plan mode changes what the agent sets out to do, not what it may run, so it
// gates like the runtime mode under it.
const KNOWN_INTERACTION_MODES: ReadonlySet<string> = new Set<ProviderInteractionMode>([
  "default",
  "plan",
]);

export const READ_ONLY_REFUSAL =
  "This app is limited to Read-only in Settings > Connected apps, so tools that need approval do not run.";

/** The mode the call runs under: the thread's mode capped by the app's ceiling. */
export const effectiveAccess = (
  input: Pick<AppToolGateInput, "runtimeMode" | "interactionMode" | "ceiling">,
): AuthMcpClientAccess => {
  if (!KNOWN_INTERACTION_MODES.has(input.interactionMode)) return "read-only";
  const mode = rankOf(input.runtimeMode);
  const rank = input.ceiling === null ? mode : Math.min(mode, rankOf(input.ceiling));
  return ACCESS_ORDER[rank] ?? "read-only";
};

export const decide = (input: AppToolGateInput): AppToolGateDecision => {
  const access = effectiveAccess(input);
  const needsApproval = input.stage === "app" || input.gated;
  switch (access) {
    // These modes already run tools without asking, so app tools do too, and
    // the app is told so in advance: it must not ask on its own either.
    case "auto":
    case "full-access":
      return { kind: "forward", approved: true };
    case "approval-required":
    case "auto-accept-edits":
      return needsApproval ? { kind: "ask" } : { kind: "forward", approved: false };
    case "read-only":
      return needsApproval
        ? { kind: "refuse", reason: READ_ONLY_REFUSAL }
        : { kind: "forward", approved: false };
  }
};

/** Under this ceiling every call that needs approval is refused, whatever the thread's mode. */
export const ceilingRefusesApprovals = (ceiling: AppRuntimeCeiling) =>
  decide({
    stage: "app",
    gated: true,
    runtimeMode: "full-access",
    interactionMode: "default",
    ceiling,
  }).kind === "refuse";

/**
 * The `rtc` claim for an app's credential. The claim only holds a
 * `RuntimeMode`, so Read-only stays in the registry, where `decide` reads it;
 * mapping it to the lowest mode would turn its refusals into prompts.
 */
export const credentialRuntimeModeCeiling = (
  ceiling: AppRuntimeCeiling,
): RuntimeMode | undefined => (ceiling === null || ceiling === "read-only" ? undefined : ceiling);
