import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  lecturnHome: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  // Bundled Stave CLI shipped with the desktop app; omitted when the app has
  // no binary for this platform so the server falls back to settings/PATH.
  stavePath: Schema.optionalKey(TrimmedNonEmptyString),
  // Only the desktop bootstrap may select proprietary executable resources.
  extensions: Schema.optionalKey(
    Schema.Struct({
      bundledRoot: TrimmedNonEmptyString,
      reviewBinary: Schema.optionalKey(
        Schema.Struct({
          path: TrimmedNonEmptyString,
          sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          fixtureRoot: Schema.optionalKey(TrimmedNonEmptyString),
        }),
      ),
    }),
  ),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
