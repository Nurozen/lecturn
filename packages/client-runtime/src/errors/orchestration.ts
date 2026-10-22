import {
  type ExternalSessionImportFailure,
  OrchestrationDispatchCommandError,
  OrchestrationV2DispatchCommandError,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isOrchestrationV2DispatchCommandError = Schema.is(OrchestrationV2DispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

/** Why a `thread.import` dispatch was refused, or null for any other failure. */
export function threadImportFailureReason(error: unknown): ExternalSessionImportFailure | null {
  return isOrchestrationV2DispatchCommandError(error) ? (error.threadImportFailure ?? null) : null;
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}
