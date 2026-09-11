import type { StaveOperation } from "@lecturn/contracts";
import { normalizeStaveErrorCode } from "./StaveError.ts";

type StaveTelemetryEvent = {
  readonly event:
    | "stave.space.created"
    | "stave.space.archived"
    | "stave.space.destroyed"
    | "stave.space.failed";
  readonly properties: Readonly<Record<string, string | number>>;
};

const successEvents: Readonly<Record<StaveOperation["kind"], StaveTelemetryEvent["event"] | null>> =
  {
    createSpace: "stave.space.created",
    createSaga: "stave.space.created",
    archiveSpace: "stave.space.archived",
    sagaArchive: "stave.space.archived",
    destroySpace: "stave.space.destroyed",
    sagaDestroy: "stave.space.destroyed",
    removePartialSpace: "stave.space.destroyed",
    lifecycleAction: null,
    setup: null,
    registerRepo: null,
    addRepo: null,
    removeRepo: null,
    retarget: null,
    syncSpace: null,
    restoreSpace: null,
    memoryAttach: null,
    memoryDetach: null,
    sagaAdd: null,
    sagaRemove: null,
    sagaSync: null,
  };

/** Construct every analytics property here; operation payloads never reach the sink. */
export function staveTelemetryEvent(
  operation: StaveOperation,
  trigger: "interactive" | "automatic",
  outcome: { readonly state: "success" } | { readonly state: "failure"; readonly code: string },
): StaveTelemetryEvent | null {
  const operationKind = Object.hasOwn(successEvents, operation.kind) ? operation.kind : "unknown";
  const safeTrigger = trigger === "automatic" ? "automatic" : "interactive";
  if (outcome.state === "failure") {
    return {
      event: "stave.space.failed",
      properties: {
        operationKind,
        trigger: safeTrigger,
        count: 1,
        code: normalizeStaveErrorCode(outcome.code),
      },
    };
  }
  let event = operationKind === "unknown" ? null : successEvents[operationKind];
  if (operation.kind === "lifecycleAction") {
    if (
      operation.action === "archiveNow" ||
      (operation.action === "retry" && operation.target === "archive")
    ) {
      event = "stave.space.archived";
    } else if (operation.action === "retry" && operation.target === "destroy") {
      event = "stave.space.destroyed";
    }
  }
  return event === null
    ? null
    : {
        event,
        properties: { operationKind, trigger: safeTrigger, count: 1 },
      };
}
