import { ManagedRelay } from "@lecturn/client-runtime/relay";
import { settleAsyncResult } from "@lecturn/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";

/** Drops one account's cached relay tokens, or every account's without an ID. */
export function resetRelayTokenCache(accountId?: string) {
  return settleAsyncResult(() =>
    runtime.runPromiseExit(
      ManagedRelay.ManagedRelayClient.pipe(
        Effect.flatMap((client) => client.resetTokenCache(accountId)),
      ),
    ),
  );
}
