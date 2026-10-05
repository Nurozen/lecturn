import {
  type ExternalSessionImportFailure,
  OrchestrationDispatchCommandError,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

/** Why a `thread.import` dispatch was refused, or null for any other failure. */
export function threadImportFailureReason(error: unknown): ExternalSessionImportFailure | null {
  return isOrchestrationDispatchCommandError(error) ? (error.threadImportFailure ?? null) : null;
}
