import { normalizeSecureRelayUrl } from "@lecturn/shared/relayUrl";

import {
  ConnectAccountStatus,
  ConnectAccountBeginResult,
  ConnectAccountTokenResult,
  ConnectAccountError,
} from "@lecturn/contracts";
import * as Schema from "effect/Schema";

export type PhoneConnectStatus = ConnectAccountStatus;
export type PhoneConnectAuthorization = ConnectAccountBeginResult;

export interface PhoneConnectSnapshot {
  readonly status: PhoneConnectStatus | null;
  readonly authorization: PhoneConnectAuthorization | null;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface PhoneConnectApi {
  status(): Promise<PhoneConnectStatus>;
  begin(): Promise<PhoneConnectAuthorization>;
  complete(input: { requestId: string; code: string }): Promise<PhoneConnectStatus>;
  cancel(input: { requestId: string }): Promise<PhoneConnectStatus>;
  token(input: { accountId: string }): Promise<{ token: string | null }>;
  logout(): Promise<PhoneConnectStatus>;
}

// Same-origin environment session only. Never send these requests to a relay or
// derive identity by decoding an access token (hosted OAuth tokens may be opaque).
class PhoneConnectRequestError extends Error {}

const isAccountError = Schema.is(ConnectAccountError);
const decodeStatus = Schema.decodeUnknownSync(ConnectAccountStatus);
const decodeBegin = Schema.decodeUnknownSync(ConnectAccountBeginResult);
const decodeToken = Schema.decodeUnknownSync(ConnectAccountTokenResult);

export function createPhoneConnectApi(fetcher: typeof fetch = globalThis.fetch): PhoneConnectApi {
  const request = async (action: string, body?: object): Promise<unknown> => {
    const response = await fetcher(`/api/connect/account/${action}`, {
      method: action === "status" ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json", "X-Lecturn-Connect-Account": "local-ui" },
      ...(action === "status" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const reason = isAccountError(failure) ? failure.reason : null;
      if (reason === "not_configured")
        throw new PhoneConnectRequestError("Connect is not configured on this phone.");
      if (reason === "authorization_failed" || reason === "invalid_request")
        throw new PhoneConnectRequestError(
          "This sign-in code is invalid or expired. Start sign-in again.",
        );
      if (reason === "login_in_progress")
        throw new PhoneConnectRequestError(
          "A sign-in is already pending. Cancel it before starting again.",
        );
      // Do not reflect provider bodies or authorization addresses into errors.
      throw new PhoneConnectRequestError(
        response.status === 401 || response.status === 403
          ? "This local session cannot manage the Connect account. Reconnect to this phone and try again."
          : "The Connect account request failed. Refresh status and try again.",
      );
    }
    return await response.json();
  };
  return {
    status: async () => decodeStatus(await request("status")),
    begin: async () => decodeBegin(await request("begin")),
    complete: async (input) => decodeStatus(await request("complete", input)),
    cancel: async (input) => decodeStatus(await request("cancel", input)),
    token: async (input) => decodeToken(await request("token", input)),
    logout: async () => decodeStatus(await request("logout")),
  };
}

export function createPhoneConnectAccount(api: PhoneConnectApi) {
  let snapshot: PhoneConnectSnapshot = {
    status: null,
    authorization: null,
    busy: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let revision = 0;
  let statusRead: Promise<void> | null = null;
  const update = (patch: Partial<PhoneConnectSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const applyStatus = (status: PhoneConnectStatus) => {
    const relayUrl = normalizeSecureRelayUrl(status.relayUrl ?? "");
    update({
      status: { ...status, configured: status.configured && relayUrl !== null, relayUrl },
      ...(status.state === "authorizing" ? {} : { authorization: null }),
    });
  };
  const fail = (error?: unknown) =>
    update({
      error:
        error instanceof PhoneConnectRequestError
          ? error.message
          : "Could not update the Connect account. Refresh status and try again.",
    });
  const refresh = () => {
    if (snapshot.busy) return Promise.resolve();
    if (statusRead) return statusRead;
    const version = revision;
    statusRead = api
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
        statusRead = null;
      });
    return statusRead;
  };
  const mutate = async (action: () => Promise<void>) => {
    if (snapshot.busy) return;
    revision += 1;
    update({ busy: true, error: null });
    try {
      await action();
    } catch (error) {
      // A failed completion consumes the server attempt. Reconcile before
      // offering another code entry or retry, including after lost responses.
      try {
        applyStatus(await api.status());
      } catch {
        /* Keep the last observed state. */
      }
      fail(error);
    } finally {
      update({ busy: false });
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
    begin: () =>
      mutate(async () => {
        if (!snapshot.status?.configured || snapshot.status.account) return;
        const authorization = await api.begin();
        const url = new URL(authorization.authorizationUrl);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Invalid authorization address");
        update({ authorization, status: { ...snapshot.status, state: "authorizing" } });
      }),
    complete: (code: string) =>
      mutate(async () => {
        const requestId = snapshot.authorization?.requestId;
        if (!requestId || !code.trim()) return;
        const status = await api.complete({ requestId, code: code.trim() });
        update({ authorization: null });
        applyStatus(status);
      }),
    cancel: () =>
      mutate(async () => {
        const requestId = snapshot.authorization?.requestId;
        const status = requestId ? await api.cancel({ requestId }) : await api.logout();
        update({ authorization: null });
        applyStatus(status);
      }),
    logout: () =>
      mutate(async () => {
        const status = await api.logout();
        update({ authorization: null });
        applyStatus(status);
      }),
    readToken: async (accountId: string) => {
      if (
        !snapshot.status?.configured ||
        snapshot.status.state !== "signed-in" ||
        snapshot.status.account?.id !== accountId
      )
        return null;
      const version = revision;
      const result = await api.token({ accountId });
      if (version !== revision || snapshot.status?.account?.id !== accountId) return null;
      if (result.token === null) await refresh();
      return result.token;
    },
  };
}

// Created lazily at the first request so tests and the native fetch adapter can
// install their transport before account operations begin.
export const phoneConnectAccount = createPhoneConnectAccount({
  status: () => createPhoneConnectApi().status(),
  begin: () => createPhoneConnectApi().begin(),
  complete: (input) => createPhoneConnectApi().complete(input),
  cancel: (input) => createPhoneConnectApi().cancel(input),
  token: (input) => createPhoneConnectApi().token(input),
  logout: () => createPhoneConnectApi().logout(),
});
