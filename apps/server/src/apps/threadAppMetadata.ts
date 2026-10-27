/**
 * The one owner of a thread's connected-app fields (`copiedFrom`, `appData`,
 * `appSubtitle`, `appOrigin`, `continuedIn`). Orchestration decides them,
 * events carry them inside the thread payload, the projection stores that
 * payload, and both shell builders copy them through this module, so a field
 * added here reaches every reader at once.
 *
 * A thread without app metadata has none of the keys, so non-app payloads and
 * shells stay byte-for-byte what they were.
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
  source.continuedIn !== undefined;

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
  };
}

/**
 * A fork child stays in the app's project but is a new conversation: the
 * app's data, subtitle and copy links describe the source thread, not it.
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
    return "Only a connected app can set app thread fields; create the thread without them.";
  }
}

/**
 * Lecturn's own clients never send app fields: the apps service sets
 * them on the server for the owning app. This runs on the client dispatch
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
