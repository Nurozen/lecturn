import { normalizeSecureRelayUrl } from "@lecturn/shared/relayUrl";
import {
  ConnectAccountStatus,
  ConnectAccountTokenResult,
  ConnectAccountTokenRequest,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { hasNativeConnect, type NativeConnectHost } from "../lib/androidHostAccess";

export type PhoneConnectStatus = ConnectAccountStatus;

export interface PhoneConnectSnapshot {
  readonly status: PhoneConnectStatus | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface PhoneConnectApi {
  status(): Promise<PhoneConnectStatus>;
  begin(): Promise<PhoneConnectStatus>;
  token(input: { accountId: string }): Promise<{ token: string | null }>;
  logout(): Promise<PhoneConnectStatus>;
}

const UPDATE_REQUIRED = "Update Lecturn on this phone to use native Connect sign-in.";
const REQUEST_FAILED = "Could not update the Connect account. Refresh status and try again.";
class PhoneConnectRequestError extends Error {}
const decodeStatus = Schema.decodeUnknownSync(ConnectAccountStatus);
const decodeToken = Schema.decodeUnknownSync(ConnectAccountTokenResult);
const decodeTokenRequest = Schema.decodeUnknownSync(ConnectAccountTokenRequest);

export function createPhoneConnectApi(
  host = typeof window === "undefined" ? undefined : window.symbaHost,
): PhoneConnectApi {
  const request = async <T>(
    action: (native: NativeConnectHost) => Promise<unknown>,
    decode: (value: unknown) => T,
  ): Promise<T> => {
    if (!hasNativeConnect(host)) throw new PhoneConnectRequestError(UPDATE_REQUIRED);
    try {
      return decode(await action(host));
    } catch {
      // Schema errors and native failures may contain private provider details.
      throw new PhoneConnectRequestError(REQUEST_FAILED);
    }
  };
  return {
    status: () => request((native) => native.getConnectState(), decodeStatus),
    begin: () => request((native) => native.openConnectSignIn(), decodeStatus),
    token: (input) =>
      request((native) => native.getConnectToken(decodeTokenRequest(input).accountId), decodeToken),
    logout: () => request((native) => native.signOutConnect(), decodeStatus),
  };
}

export function createPhoneConnectAccount(api: PhoneConnectApi) {
  let snapshot: PhoneConnectSnapshot = { status: null, busy: false, error: null };
  const listeners = new Set<() => void>();
  let revision = 0;
  let statusRead: Promise<void> | null = null;
  let refreshAfterMutation = false;
  let refreshAfterRead = false;
  const update = (patch: Partial<PhoneConnectSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const applyStatus = (status: PhoneConnectStatus) => {
    const relayUrl = normalizeSecureRelayUrl(status.relayUrl ?? "");
    const previous = snapshot.status;
    // A -> B -> A and error/recovery transitions must invalidate pending tokens.
    if (
      previous?.account?.id !== status.account?.id ||
      previous?.state !== status.state ||
      previous?.relayUrl !== relayUrl ||
      previous?.configured !== status.configured
    )
      revision += 1;
    update({ status: { ...status, configured: status.configured && relayUrl !== null, relayUrl } });
  };
  const fail = (error?: unknown) => {
    if (snapshot.status) applyStatus({ ...snapshot.status, state: "error" });
    update({ error: error instanceof PhoneConnectRequestError ? error.message : REQUEST_FAILED });
  };
  const refresh = (): Promise<void> => {
    if (snapshot.busy) {
      // Native UI can close before the immediate authorizing receipt arrives.
      refreshAfterMutation = true;
      return Promise.resolve();
    }
    if (statusRead) {
      // A return event must observe native state after an earlier read settles.
      refreshAfterRead = true;
      return statusRead;
    }
    const version = revision;
    const read = api
      .status()
      .then((status) => {
        if (version === revision) {
          applyStatus(status);
          update({ error: null });
        }
      })
      .catch((error) => {
        if (version === revision) fail(error);
      })
      .finally(() => {
        if (statusRead === read) {
          statusRead = null;
          if (refreshAfterRead) {
            refreshAfterRead = false;
            return refresh();
          }
        }
      });
    statusRead = read;
    return read;
  };
  const mutate = async (action: () => Promise<PhoneConnectStatus>) => {
    if (snapshot.busy) return;
    revision += 1;
    // Allow a fresh return/focus read while a superseded status request drains.
    statusRead = null;
    refreshAfterRead = false;
    update({ busy: true, error: null });
    try {
      applyStatus(await action());
    } catch (error) {
      fail(error);
    } finally {
      update({ busy: false });
      if (refreshAfterMutation) {
        refreshAfterMutation = false;
        await refresh();
      }
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setRuntimeError: (error: string | null) => update({ error }),
    begin: () => {
      if (
        !snapshot.status?.configured ||
        snapshot.status.account ||
        snapshot.status.state === "loading" ||
        snapshot.status.state === "authorizing"
      )
        return Promise.resolve();
      return mutate(() => api.begin());
    },
    logout: () => mutate(() => api.logout()),
    readToken: async (accountId: string) => {
      const canRead = () =>
        !snapshot.busy &&
        snapshot.status?.configured &&
        snapshot.status.state === "signed-in" &&
        snapshot.status.account?.id === accountId;
      if (!canRead()) return null;
      const version = revision;
      try {
        const result = await api.token({ accountId });
        if (version !== revision || !canRead()) return null;
        if (result.token === null) await refresh();
        return result.token;
      } catch (error) {
        if (version === revision) fail(error);
        return null;
      }
    },
  };
}

// Resolve the injected host only when used; credentials remain owned by the SDK.
export const phoneConnectAccount = createPhoneConnectAccount({
  status: () => createPhoneConnectApi().status(),
  begin: () => createPhoneConnectApi().begin(),
  token: (input) => createPhoneConnectApi().token(input),
  logout: () => createPhoneConnectApi().logout(),
});
