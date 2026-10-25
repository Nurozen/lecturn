/**
 * The connected-app sidecar (D9): an app starts its own Lecturn server and
 * hands it an `app-sidecar` envelope on `--bootstrap-fd`. The server stays in
 * web mode, grants the app without a prompt, and seeds an in-memory grant
 * that the helper exchanges at `/api/auth/token` for its `app:<appId>`
 * session.
 */
import {
  type AppSidecarBootstrap,
  AuthAppHostScope,
  type DesktopBackendBootstrap,
  type ServerBootstrapEnvelope,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerConfig from "../config.ts";
import { formatAppSubject } from "./subjects.ts";

/** Desktop fields keep driving config resolution; the sidecar envelope travels on to the registry. */
export const splitServerBootstrap = (
  envelope: Option.Option<ServerBootstrapEnvelope>,
): {
  readonly desktop: DesktopBackendBootstrap | undefined;
  readonly appSidecar: AppSidecarBootstrap | undefined;
} => {
  const value = Option.getOrUndefined(envelope);
  return value?.mode === "app-sidecar"
    ? { desktop: undefined, appSidecar: value }
    : { desktop: value, appSidecar: undefined };
};

// In memory, so it dies with the sidecar; until then it lasts as long as the
// session it is exchanged for.
const SEED_TTL_DAYS = 30;

/**
 * Seeded like the desktop's bootstrap token. `desktop-bootstrap` because it is
 * not a pairing code (it cannot approve MCP clients) and a re-exchange
 * replaces the helper's previous session instead of piling them up.
 */
export const appSidecarSeedGrants = (
  config: Pick<ServerConfig.ServerConfig["Service"], "appSidecar">,
) =>
  Effect.gen(function* () {
    const sidecar = config.appSidecar;
    if (sidecar === undefined) return [];
    const now = yield* DateTime.now;
    return [
      [
        sidecar.appSeedToken,
        {
          method: "desktop-bootstrap" as const,
          scopes: [AuthAppHostScope],
          subject: formatAppSubject(sidecar.registration.appId),
          label: sidecar.registration.name,
          expiresAt: DateTime.add(now, { days: SEED_TTL_DAYS }),
          remainingUses: "unbounded" as const,
        },
      ] as const,
    ];
  });
