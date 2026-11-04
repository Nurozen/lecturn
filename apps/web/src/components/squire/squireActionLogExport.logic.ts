import { environmentEndpointUrl } from "@lecturn/client-runtime/environment";
import type { SquireId } from "@lecturn/contracts";

/** Mirrors the server's read-scoped NDJSON export route. */
export function squireActionLogPath(squireId: SquireId): string {
  return `/api/squire/${encodeURIComponent(squireId)}/action-log`;
}

/** Joined with the environment's own origin, so a remote or relayed environment is reached where it lives. */
export function squireActionLogUrl(httpBaseUrl: string, squireId: SquireId): string {
  return environmentEndpointUrl(httpBaseUrl, squireActionLogPath(squireId));
}

/** The name the server suggests in its content-disposition, with the Squire's name for the user. */
export function squireActionLogFileName(squire: { readonly id: SquireId; readonly name: string }) {
  const slug = squire.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `squire-${slug === "" ? squire.id : slug}-log.ndjson`;
}
