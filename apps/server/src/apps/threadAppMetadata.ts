/**
 * Sole owner of a thread's server-set metadata: the connected-app fields (`copiedFrom`, `appData`,
 * `appSubtitle`, `appOrigin`, `continuedIn`) and the Squire marker (`squire`). Both shell builders
 * copy them through here, so a new field reaches every reader. A thread without this metadata has
 * none of the keys, so non-app payloads and shells stay byte-for-byte unchanged.
 */
import {
  AppOrigin,
  CommandId,
  ConnectedAppThreadContinuedIn,
  ConnectedAppThreadCopyOrigin,
  ConnectedAppThreadData,
  ConnectedAppThreadSubtitle,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  SquireThreadMarker,
} from "@lecturn/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ThreadAppMetadata = Schema.Struct({
  copiedFrom: Schema.optionalKey(ConnectedAppThreadCopyOrigin),
  appData: Schema.optionalKey(ConnectedAppThreadData),
  appSubtitle: Schema.optionalKey(ConnectedAppThreadSubtitle),
  appOrigin: Schema.optionalKey(AppOrigin),
  continuedIn: Schema.optionalKey(ConnectedAppThreadContinuedIn),
  squire: Schema.optionalKey(SquireThreadMarker),
});
export type ThreadAppMetadata = typeof ThreadAppMetadata.Type;

export const THREAD_APP_METADATA_KEYS = Object.keys(ThreadAppMetadata.fields) as ReadonlyArray<
  keyof ThreadAppMetadata
>;

export type ThreadAppMetadataCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.app-data.set" | "thread.continued-in.set" }
>;

const NONE: ThreadAppMetadata = Object.freeze({});

const sameMetadata = Schema.toEquivalence(ThreadAppMetadata);

const hasAny = (source: ThreadAppMetadata) =>
  source.copiedFrom !== undefined ||
  source.appData !== undefined ||
  source.appSubtitle !== undefined ||
  source.appOrigin !== undefined ||
  source.continuedIn !== undefined ||
  source.squire !== undefined;

/**
 * The present fields only. Every shell build calls this, so the common
 * non-app case returns a shared empty object instead of allocating.
 */
export function threadAppMetadataOf(source: ThreadAppMetadata): ThreadAppMetadata {
  if (!hasAny(source)) return NONE;
  return {
    ...(source.copiedFrom === undefined ? {} : { copiedFrom: source.copiedFrom }),
    ...(source.appData === undefined ? {} : { appData: source.appData }),
    ...(source.appSubtitle === undefined ? {} : { appSubtitle: source.appSubtitle }),
    ...(source.appOrigin === undefined ? {} : { appOrigin: source.appOrigin }),
    ...(source.continuedIn === undefined ? {} : { continuedIn: source.continuedIn }),
    ...(source.squire === undefined ? {} : { squire: source.squire }),
  };
}

/**
 * A fork child stays in the app's project but is a new conversation: the
 * app's data, subtitle and copy links describe the source thread, not it.
 * The Squire marker goes too, so a fork of a home thread is an ordinary
 * thread unless the server marks it as a probe itself.
 */
export function withoutThreadAppMetadata<T extends ThreadAppMetadata>(
  thread: T,
): Omit<T, keyof ThreadAppMetadata> {
  const {
    copiedFrom: _copiedFrom,
    appData: _appData,
    appSubtitle: _appSubtitle,
    appOrigin: _appOrigin,
    continuedIn: _continuedIn,
    squire: _squire,
    ...rest
  } = thread;
  return rest;
}

/** `null` clears a field; an absent subtitle leaves it as it was. */
const appDataApplied = (
  current: ThreadAppMetadata,
  command: Extract<ThreadAppMetadataCommand, { readonly type: "thread.app-data.set" }>,
): ThreadAppMetadata => {
  const { appData: _appData, appSubtitle, ...rest } = current;
  const subtitle = command.subtitle === undefined ? appSubtitle : command.subtitle;
  return {
    ...rest,
    ...(command.appData === null ? {} : { appData: command.appData }),
    ...(subtitle == null ? {} : { appSubtitle: subtitle }),
  };
};

/** `updatedAt` moves only when a field changed; `historyRevision` never does. */
export function applyThreadAppMetadataCommand(
  thread: OrchestrationV2AppThread,
  command: ThreadAppMetadataCommand,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  const current = threadAppMetadataOf(thread);
  const next: ThreadAppMetadata =
    command.type === "thread.continued-in.set"
      ? { ...current, continuedIn: command.continuedIn }
      : appDataApplied(current, command);
  if (sameMetadata(current, next)) return thread;
  return { ...withoutThreadAppMetadata(thread), ...next, updatedAt: now };
}

export class ThreadAppMetadataRefusedError extends Schema.TaggedError<ThreadAppMetadataRefusedError>()(
  "ThreadAppMetadataRefusedError",
  { commandId: CommandId, commandType: Schema.String },
) {
  override get message(): string {
    return "Only the server can set app thread fields or the Squire marker; create the thread without them.";
  }
}

/**
 * Lecturn's own clients never send this metadata: the apps service sets the
 * app fields for the owning app and the Squire service sets the marker, both
 * on the server. This runs on the client dispatch
 * path only, so server-built commands are unaffected.
 */
export const refuseClientThreadAppMetadata = (command: OrchestrationV2Command) =>
  command.type === "thread.create" && hasAny(command)
    ? Effect.fail(
        new ThreadAppMetadataRefusedError({
          commandId: command.commandId,
          commandType: command.type,
        }),
      )
    : Effect.void;
