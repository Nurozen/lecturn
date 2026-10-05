import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/**
 * Picks the agent's permission option for a decision by ACP option kind, not id.
 * "Always allow this session" falls back to allow-once when the agent offers no
 * allow-always option.
 */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kinds =
    decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of kinds) {
    const optionId = request.options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}
