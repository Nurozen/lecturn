import * as Schema from "effect/Schema";

import { AppSidecarBootstrap } from "./apps.ts";
import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// A supervisor must not restart a server refused by the state-directory owner.
export const SERVER_EXIT_CODE_STATE_DIR_OWNED = 78;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omit in WSL to use the Linux home instead of the mapped Windows directory.
  lecturnHome: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Derives rotating tokens instead of trusting desktopBootstrapToken indefinitely; see @lecturn/shared/desktopBootstrapToken.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Absent means the backend must hydrate PATH, as WSL and older desktops require.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
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

/** Every envelope `--bootstrap-fd` may carry; `mode` tells them apart. */
export const ServerBootstrapEnvelope = Schema.Union([DesktopBackendBootstrap, AppSidecarBootstrap]);
export type ServerBootstrapEnvelope = typeof ServerBootstrapEnvelope.Type;

/** Written to `<lecturnHome>/runtime` before update shutdown so the backend retains its managed tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
