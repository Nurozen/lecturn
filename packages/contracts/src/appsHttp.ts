/**
 * Loopback-only pairing endpoints. They are plain routes rather than an
 * HttpApi group because the caller is an unauthenticated local app, not a
 * Lecturn client.
 */
import * as Schema from "effect/Schema";

import { AppPairingPoll, AppPairingRequestCreated, AppRegistration } from "./apps.ts";

export const APPS_PAIRING_REQUESTS_PATH = "/api/apps/pairing-requests";
export const APPS_POLL_SECRET_HEADER = "X-Lecturn-Poll-Secret";

export function appsPairingRequestPath(requestId: string): string {
  return `${APPS_PAIRING_REQUESTS_PATH}/${encodeURIComponent(requestId)}`;
}

export const AppsCreatePairingRequestBody = AppRegistration;
export type AppsCreatePairingRequestBody = typeof AppsCreatePairingRequestBody.Type;

export const AppsCreatePairingRequestResponse = AppPairingRequestCreated;
export type AppsCreatePairingRequestResponse = typeof AppsCreatePairingRequestResponse.Type;

export const AppsPollPairingRequestResponse = AppPairingPoll;
export type AppsPollPairingRequestResponse = typeof AppsPollPairingRequestResponse.Type;

export const AppsHttpErrorBody = Schema.Struct({
  error: Schema.Literals(["invalid", "forbidden", "not-found", "rate-limited", "unavailable"]),
  message: Schema.String,
});
export type AppsHttpErrorBody = typeof AppsHttpErrorBody.Type;
