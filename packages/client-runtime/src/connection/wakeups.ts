import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed"
  | AccountCredentialsChanged;

/**
 * Connect accounts that signed in or out. Relay targets owned by another
 * account keep their connection; the bare "credentials-changed" reason stands
 * for every account.
 */
export interface AccountCredentialsChanged {
  readonly _tag: "AccountCredentialsChanged";
  readonly accountIds: ReadonlySet<string>;
}

export function accountCredentialsChanged(change: {
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
}): AccountCredentialsChanged {
  return {
    _tag: "AccountCredentialsChanged",
    accountIds: new Set([...change.added, ...change.removed]),
  };
}

/**
 * Whether a wakeup changes the credentials of a relay target owned by
 * `accountId`. An untagged target may belong to any account, so every
 * credentials change applies to it.
 */
export function isCredentialsChangeFor(
  reason: ConnectionWakeup,
  accountId: string | undefined,
): boolean {
  if (typeof reason === "string") {
    return reason === "credentials-changed";
  }
  return accountId === undefined || reason.accountIds.has(accountId);
}

export function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@lecturn/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
