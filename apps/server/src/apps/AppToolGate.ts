/**
 * Whether an app tool call may go ahead, must ask the user, or is refused
 * (D1, D2). AppToolkit asks before forwarding a call (`static`) and again when
 * the app answers `lecturn/approval-required` (`app`).
 *
 * Stub until A20 fills the approval matrix: it forwards ungated calls
 * unapproved and asks for everything else, so nothing gated runs unseen.
 */
import type { AppRuntimeCeiling, ProviderInteractionMode, RuntimeMode } from "@lecturn/contracts";

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

export const decide = (input: AppToolGateInput): AppToolGateDecision =>
  input.stage === "static" && !input.gated ? { kind: "forward", approved: false } : { kind: "ask" };
