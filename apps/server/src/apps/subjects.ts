/**
 * The one place that knows how connected-app session subjects are spelled.
 * Authorization, the session list filters and revoke all classify a session
 * through `parseAppSubject`, so they cannot disagree about what an app is.
 */
import { AppId, ProjectId } from "@lecturn/contracts";
import * as Schema from "effect/Schema";

export type AppSubject =
  | { readonly kind: "app"; readonly appId: AppId }
  | { readonly kind: "embed"; readonly appId: AppId; readonly projectId: ProjectId };

const APP_PREFIX = "app:";
const EMBED_PREFIX = "embed:";

const isAppId = Schema.is(AppId);
const isProjectId = Schema.is(ProjectId);

export const formatAppSubject = (appId: AppId): string => `${APP_PREFIX}${appId}`;

export const formatEmbedSubject = (appId: AppId, projectId: ProjectId): string =>
  `${EMBED_PREFIX}${appId}:${projectId}`;

/** `null` for every other session; a malformed app-looking subject is not an app either. */
export const parseAppSubject = (subject: string): AppSubject | null => {
  if (subject.startsWith(APP_PREFIX)) {
    const appId = subject.slice(APP_PREFIX.length);
    return isAppId(appId) ? { kind: "app", appId } : null;
  }
  if (subject.startsWith(EMBED_PREFIX)) {
    const rest = subject.slice(EMBED_PREFIX.length);
    // App ids cannot contain ":", so the first one ends the app id.
    const separator = rest.indexOf(":");
    if (separator < 0) return null;
    const appId = rest.slice(0, separator);
    const projectId = rest.slice(separator + 1);
    // ProjectId trims while decoding, so its type guard alone accepts padded ids.
    return isAppId(appId) && isProjectId(projectId) && projectId === projectId.trim()
      ? { kind: "embed", appId, projectId }
      : null;
  }
  return null;
};
