import { appOpenUrlAllowed } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const OpenAppUrlInput = Schema.Struct({
  url: Schema.String,
  openUrlTemplate: Schema.String,
});

/**
 * The URL to open for a connected app, or none. `openExternal` refuses custom schemes, so this
 * is the one path that opens them, and only in the scheme the app registered: a URL whose scheme
 * differs from its template's is refused, as is any scheme that is not an app's own.
 */
export function parseAppOpenUrl(input: {
  readonly url: string;
  readonly openUrlTemplate: string;
}): Option.Option<string> {
  if (!URL.canParse(input.url)) return Option.none();
  const url = new URL(input.url);
  if (
    !appOpenUrlAllowed(url.href, input.openUrlTemplate) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return Option.none();
  }
  return Option.some(url.href);
}

export const openAppUrl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_APP_URL_CHANNEL,
  payload: OpenAppUrlInput,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.apps.openAppUrl")(function* (input) {
    const url = parseAppOpenUrl(input);
    if (Option.isNone(url)) {
      yield* Effect.logWarning("Refused to open an app URL outside its registered scheme");
      return false;
    }
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openAppUrl(url.value);
  }),
});
