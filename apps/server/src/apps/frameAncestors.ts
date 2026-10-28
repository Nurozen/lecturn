/**
 * `frame-ancestors` for the static web app. Only the static HTML
 * handler sets it: asset and attachment routes serve the MCP App and document
 * frames Lecturn's own clients embed, so a policy there would break them.
 * Electron hosts load `/embed` top-level, where `frame-ancestors` never
 * applies, so they need no declared origin.
 */
import type { AppStatus } from "@lecturn/contracts";
import * as Effect from "effect/Effect";

import { AppRegistryService } from "./services.ts";

const SELF = "'self'";

export const isEmbedPath = (pathname: string) =>
  pathname === "/embed" || pathname.startsWith("/embed/");

/** A port-less host-source matches only the default port, so origins keep theirs as declared. */
export const embedFrameAncestorSources = (apps: ReadonlyArray<AppStatus>) => [
  ...new Set([
    SELF,
    ...apps.filter((app) => app.state === "granted").flatMap((app) => app.embedOrigins),
  ]),
];

const policy = (sources: ReadonlyArray<string>) => ({
  "Content-Security-Policy": `frame-ancestors ${sources.join(" ")}`,
});

export type FrameAncestorsHeaders = (
  pathname: string,
) => Effect.Effect<Readonly<Record<string, string>>>;

// Routes see only request services, so the registry is taken when the route layer is built.
export const make = Effect.map(
  Effect.service(AppRegistryService),
  (registry): FrameAncestorsHeaders =>
    (pathname) =>
      isEmbedPath(pathname)
        ? registry.list.pipe(
            Effect.map((apps) => policy(embedFrameAncestorSources(apps))),
            // Without the grants no app origin is known to be safe, so only Lecturn may frame.
            Effect.catch((failure) =>
              Effect.logWarning("Embed framing fell back to 'self'", { failure }).pipe(
                Effect.as(policy([SELF])),
              ),
            ),
          )
        : Effect.succeed(policy([SELF])),
);
