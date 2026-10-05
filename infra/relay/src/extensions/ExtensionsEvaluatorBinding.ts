import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Schema } from "effect";

export const EXTENSIONS_EVALUATOR_BINDING = "LECTURN_EXTENSIONS_EVALUATOR";
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/));
const decodeWorkerName = Schema.decodeUnknownSync(WorkerName);

/** Cross-repository deployment needs only a physical service name, never private source. */
export function extensionEvaluatorServiceBinding(workerName: string) {
  return {
    type: "service",
    name: EXTENSIONS_EVALUATOR_BINDING,
    service: decodeWorkerName(workerName),
  } satisfies Cloudflare.Workers.WorkerBinding;
}

/** Register native binding metadata during Alchemy's init phase; no public evaluator route. */
export const registerExtensionEvaluatorBinding = Effect.fn("Extensions.registerEvaluatorBinding")(
  function* (workerName: string) {
    const self = yield* Cloudflare.Worker;
    yield* self.bind("lecturn-extensions-evaluator", {
      bindings: [extensionEvaluatorServiceBinding(workerName)],
    });
  },
);
