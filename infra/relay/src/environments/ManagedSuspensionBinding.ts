import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Redacted } from "effect";
import {
  cloudflareSuspensionProvider,
  type SuspensionProvider,
} from "../billing/ManagedSuspensions.ts";

/** Reuses the exact scoped token already created by ReadWriteTunnel; no deployment token enters the Worker. */
export const bindManagedSuspensionProvider = Effect.gen(function* () {
  const Token = yield* Cloudflare.ApiToken.AccountApiToken;
  const worker = yield* Cloudflare.Worker;
  const token = yield* Token(`${worker.LogicalId}Token`);
  const bound = yield* Cloudflare.Tunnel.bindTunnelToken(token);
  return (runtime: Alchemy.BaseRuntimeContext): SuspensionProvider => {
    const call = (operation: keyof SuspensionProvider, tunnelId: string) =>
      Effect.gen(function* () {
        const accountId = yield* bound.accountId;
        const apiToken = Redacted.value(yield* bound.value);
        yield* cloudflareSuspensionProvider({ accountId, apiToken })[operation](tunnelId);
      }).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime));
    return {
      rotate: (id) => call("rotate", id),
      disconnect: (id) => call("disconnect", id),
      remove: (id) => call("remove", id),
    };
  };
});
