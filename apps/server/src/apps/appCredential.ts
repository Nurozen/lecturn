/**
 * The long-lived bearer a paired app keeps. It has the MCP client
 * credential's shape: no refresh grant exists, so it lasts 30 days and the app
 * pairs again when it runs out.
 */
import { type AppId, type AppRuntimeCeiling, AuthAppHostScope } from "@lecturn/contracts";
import * as Duration from "effect/Duration";

import type * as SessionStore from "../auth/SessionStore.ts";
import { formatAppSubject } from "./subjects.ts";

const APP_CREDENTIAL_TTL = Duration.days(30);

export const issueAppCredential = (
  sessions: SessionStore.SessionStore["Service"],
  input: { readonly appId: AppId; readonly name: string; readonly ceiling: AppRuntimeCeiling },
) =>
  sessions.issue({
    subject: formatAppSubject(input.appId),
    method: "bearer-access-token",
    scopes: [AuthAppHostScope],
    ttl: APP_CREDENTIAL_TTL,
    // The claim only holds runtime modes; a read-only ceiling is enforced from
    // the registry by the tool gate.
    ...(input.ceiling === null || input.ceiling === "read-only"
      ? {}
      : { runtimeModeCeiling: input.ceiling }),
    client: { label: input.name, deviceType: "bot" },
  });
