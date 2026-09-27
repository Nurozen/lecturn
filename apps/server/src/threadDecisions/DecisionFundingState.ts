import { Effect, Option, Semaphore } from "effect";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export const DECISION_FUNDING_STATUS = "decisions-funding-status";
export const DECISION_FUNDING_REVOKED = "decisions-funding-revoked";
const previousExtensionStop = "extensions-decisions-revoked";
const locks = new WeakMap<ServerSecretStore["Service"], Semaphore.Semaphore>();

/** Both funding surfaces serialize against the same durable Decisions consent. */
export function decisionFundingState(secrets: ServerSecretStore["Service"]) {
  let mutex = locks.get(secrets);
  if (!mutex) {
    mutex = Semaphore.makeUnsafe(1);
    locks.set(secrets, mutex);
  }
  const read = (key: string) =>
    secrets
      .get(key)
      .pipe(
        Effect.map((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
        ),
      );
  return {
    mutex,
    status: read(DECISION_FUNDING_STATUS).pipe(
      Effect.flatMap((value) =>
        value === null ? read("extensions-decisions-status") : Effect.succeed(value),
      ),
    ),
    revoked: Effect.all([read(DECISION_FUNDING_REVOKED), read(previousExtensionStop)]).pipe(
      Effect.map((values) => values.includes("true")),
    ),
    clearRevoked: secrets
      .remove(previousExtensionStop)
      .pipe(Effect.andThen(secrets.remove(DECISION_FUNDING_REVOKED))),
  };
}
