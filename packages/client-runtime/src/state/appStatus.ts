/**
 * How a connected app's status reads in Settings, the Apps sidebar and the mobile Apps tab.
 * `pairing-requested` holds only while a request waits: one that lapses unanswered returns the
 * app to the user's last decision, or removes an app never granted, over the status stream.
 */

import { appGrantFingerprintSource, type AppStatus, type EnvironmentId } from "@lecturn/contracts";

export type AppStatusPhase = "running" | "closed" | "pairing-requested" | "denied" | "revoked";

/** Running means a live lease: the server drops an unrenewed one at its expiry and streams it. */
export function appStatusPhase(app: Pick<AppStatus, "state" | "live">): AppStatusPhase {
  if (app.state !== "granted") return app.state;
  return app.live !== null ? "running" : "closed";
}

export const APP_STATUS_LABEL: Readonly<Record<AppStatusPhase, string>> = {
  running: "Running",
  closed: "Closed",
  "pairing-requested": "Pairing requested",
  denied: "Denied",
  revoked: "Revoked",
};

/**
 * Why a pending request waits. `changed` asks to run a different command or frame from other
 * origins than approved, `repair` asks again after a revoke or denial (which a request never
 * lifts), and `renew` is a granted app asking for a new credential.
 */
export type AppPairingKind = "new" | "changed" | "renew" | "repair";

export function appPairingKind(
  app: Pick<AppStatus, "state" | "headlessTools" | "embedOrigins" | "pendingRequest">,
): AppPairingKind | null {
  const request = app.pendingRequest;
  if (request === null) return null;
  if (app.state === "revoked" || app.state === "denied") return "repair";
  // While a changed request waits the status keeps the registration the user approved.
  const approved = appGrantFingerprintSource({
    ...(app.headlessTools === null ? {} : { headlessTools: app.headlessTools }),
    embedOrigins: app.embedOrigins,
  });
  if (approved !== appGrantFingerprintSource(request.registration)) return "changed";
  return app.state === "granted" ? "renew" : "new";
}

export const APP_PAIRING_APPROVE_LABEL: Readonly<Record<AppPairingKind, string>> = {
  new: "Approve",
  changed: "Approve changes",
  renew: "Approve",
  repair: "Re-pair",
};

export interface AppEnvironmentStatus {
  readonly environmentId: EnvironmentId;
  readonly app: AppStatus;
}

function statusRank(app: AppStatus): number {
  if (app.state === "granted" && app.live !== null) return 0;
  if (app.pendingRequest !== null) return 1;
  if (app.state === "granted") return 2;
  return app.state === "revoked" ? 3 : 4;
}

/**
 * An app on several machines shows one status: the one that can do the most. Running beats a
 * request waiting on the user, which beats a closed grant; the first of equals wins.
 */
export function primaryAppStatus<Status extends { readonly app: AppStatus }>(
  statuses: ReadonlyArray<Status>,
): Status | null {
  if (statuses.length === 0) return null;
  return statuses.reduce((best, next) =>
    statusRank(next.app) < statusRank(best.app) ? next : best,
  );
}
