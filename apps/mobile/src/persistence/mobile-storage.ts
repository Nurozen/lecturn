import { EnvironmentId } from "@lecturn/contracts";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  isRelayManagedConnection,
  type SavedRemoteConnection,
  toStableSavedRemoteConnection,
} from "../lib/connection";
import * as MobileSecureStorage from "./mobile-secure-storage";

const CONNECTIONS_KEY = "lecturn.connections";
const AGENT_AWARENESS_DEVICE_ID_KEY = "lecturn.agent-awareness.device-id";
const AGENT_AWARENESS_REGISTRATION_KEY = "lecturn.agent-awareness.registration";
const RECENT_THREAD_SHORTCUTS_KEY = "lecturn.recent-thread-shortcuts";

export class MobileStorageDecodeError extends Schema.TaggedErrorClass<MobileStorageDecodeError>()(
  "MobileStorageDecodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode mobile storage value for key ${this.key}.`;
  }
}

export class MobileStorageEncodeError extends Schema.TaggedErrorClass<MobileStorageEncodeError>()(
  "MobileStorageEncodeError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode mobile storage value for key ${this.key}.`;
  }
}

export class MobileDeviceIdGenerationError extends Schema.TaggedErrorClass<MobileDeviceIdGenerationError>()(
  "MobileDeviceIdGenerationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to generate the mobile agent-awareness device id.";
  }
}

export interface AgentAwarenessRegistrationRecord {
  readonly identity: string;
  readonly signature: string;
  readonly pushToStartToken?: string;
}

export interface AgentAwarenessRegistrationDocument {
  readonly version: 2;
  readonly records: Readonly<Record<string, AgentAwarenessRegistrationRecord>>;
}
/** Migration preserves the legacy record under its own identity, never the active account. */
export function decodeAgentAwarenessRegistrationDocument(
  value: unknown,
): AgentAwarenessRegistrationDocument {
  const valid = (entry: unknown): entry is AgentAwarenessRegistrationRecord =>
    typeof entry === "object" &&
    entry !== null &&
    "identity" in entry &&
    typeof entry.identity === "string" &&
    "signature" in entry &&
    typeof entry.signature === "string";
  if (valid(value)) return { version: 2, records: { [value.identity]: value } };
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 2 &&
    "records" in value &&
    typeof value.records === "object" &&
    value.records !== null
  ) {
    return {
      version: 2,
      records: Object.fromEntries(
        Object.entries(value.records).filter(
          ([id, entry]) => valid(entry) && entry.identity === id,
        ),
      ),
    };
  }
  return { version: 2, records: {} };
}

export interface RecentThreadShortcut {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
}

export class MobileStorage extends Context.Service<
  MobileStorage,
  {
    readonly loadSavedConnections: Effect.Effect<
      ReadonlyArray<SavedRemoteConnection>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveConnection: (
      connection: SavedRemoteConnection,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly clearSavedConnection: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly loadOrCreateAgentAwarenessDeviceId: Effect.Effect<
      string,
      MobileSecureStorage.MobileSecureStorageError | MobileDeviceIdGenerationError
    >;
    readonly loadAgentAwarenessDeviceId: Effect.Effect<
      string | null,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly loadAgentAwarenessRegistrationRecord: (
      accountId?: string,
    ) => Effect.Effect<
      AgentAwarenessRegistrationRecord | null,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveAgentAwarenessRegistrationRecord: (
      record: AgentAwarenessRegistrationRecord,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly clearAgentAwarenessRegistrationRecord: (
      accountId?: string,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
    readonly loadRecentThreadShortcuts: Effect.Effect<
      ReadonlyArray<RecentThreadShortcut>,
      MobileSecureStorage.MobileSecureStorageError
    >;
    readonly saveRecentThreadShortcuts: (
      threads: ReadonlyArray<RecentThreadShortcut>,
    ) => Effect.Effect<
      void,
      MobileSecureStorage.MobileSecureStorageError | MobileStorageEncodeError
    >;
  }
>()("@lecturn/mobile/persistence/MobileStorage") {}

export const make = Effect.fn("MobileStorage.make")(function* () {
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;

  const parseJson = <A>(key: string, raw: string): A | null => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as A;
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key, cause }),
      );
      return null;
    }
  };

  const readJson = Effect.fn("MobileStorage.readJson")(function* <A>(key: string) {
    const raw = (yield* secureStorage.getItem(key)) ?? "";
    return parseJson<A>(key, raw);
  });

  const writeJson = Effect.fn("MobileStorage.writeJson")(function* (key: string, value: unknown) {
    const encoded = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
    yield* secureStorage.setItem(key, encoded);
  });

  const loadSavedConnections = readJson<{
    readonly connections?: ReadonlyArray<SavedRemoteConnection>;
  }>(CONNECTIONS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.connections ?? [],
        Arr.filter(
          (connection) =>
            !!connection.environmentId &&
            (!!connection.bearerToken?.trim() || isRelayManagedConnection(connection)),
        ),
      ),
    ),
  );

  const saveConnection = Effect.fn("MobileStorage.saveConnection")(function* (
    connection: SavedRemoteConnection,
  ) {
    const current = yield* loadSavedConnections;
    const stableConnection = toStableSavedRemoteConnection(connection);
    const next = current.some((entry) => entry.environmentId === connection.environmentId)
      ? pipe(
          current,
          Arr.map((entry) =>
            entry.environmentId === connection.environmentId ? stableConnection : entry,
          ),
        )
      : pipe(current, Arr.append(stableConnection));
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const clearSavedConnection = Effect.fn("MobileStorage.clearSavedConnection")(function* (
    environmentId: EnvironmentId,
  ) {
    const current = yield* loadSavedConnections;
    const next = pipe(
      current,
      Arr.filter((entry) => entry.environmentId !== environmentId),
    );
    yield* writeJson(CONNECTIONS_KEY, { connections: next });
  });

  const loadOrCreateAgentAwarenessDeviceId = Effect.gen(function* () {
    const existing = yield* secureStorage.getItem(AGENT_AWARENESS_DEVICE_ID_KEY);
    if (existing?.trim()) return existing;
    const deviceId = yield* Effect.tryPromise({
      try: () => import("../lib/uuid").then(({ uuidv4 }) => uuidv4()),
      catch: (cause) => new MobileDeviceIdGenerationError({ cause }),
    });
    yield* secureStorage.setItem(AGENT_AWARENESS_DEVICE_ID_KEY, deviceId);
    return deviceId;
  });

  const loadAgentAwarenessDeviceId = secureStorage
    .getItem(AGENT_AWARENESS_DEVICE_ID_KEY)
    .pipe(Effect.map((existing) => (existing?.trim() ? existing : null)));

  const registrationLock = yield* Semaphore.make(1);
  const loadRegistrationDocument = readJson<unknown>(AGENT_AWARENESS_REGISTRATION_KEY).pipe(
    Effect.map(decodeAgentAwarenessRegistrationDocument),
  );
  const loadAgentAwarenessRegistrationRecord = (accountId?: string) =>
    loadRegistrationDocument.pipe(
      Effect.map((document) =>
        accountId === undefined
          ? (Object.values(document.records)[0] ?? null)
          : (document.records[accountId] ?? null),
      ),
    );
  const saveAgentAwarenessRegistrationRecord = (record: AgentAwarenessRegistrationRecord) =>
    registrationLock.withPermits(1)(
      Effect.gen(function* () {
        const document = yield* loadRegistrationDocument;
        yield* writeJson(AGENT_AWARENESS_REGISTRATION_KEY, {
          version: 2,
          records: { ...document.records, [record.identity]: record },
        });
      }),
    );
  const clearAgentAwarenessRegistrationRecord = (accountId?: string) =>
    registrationLock.withPermits(1)(
      Effect.gen(function* () {
        const document = yield* loadRegistrationDocument;
        const records = Object.fromEntries(
          Object.entries(document.records).filter(
            ([id]) => accountId !== undefined && id !== accountId,
          ),
        );
        yield* writeJson(AGENT_AWARENESS_REGISTRATION_KEY, { version: 2, records });
      }),
    );

  // Threads most recently opened on this device, newest first — the source
  // for the launcher's dynamic "recent thread" app shortcuts.
  const loadRecentThreadShortcuts = readJson<{
    readonly threads?: ReadonlyArray<RecentThreadShortcut>;
  }>(RECENT_THREAD_SHORTCUTS_KEY).pipe(
    Effect.map((parsed) =>
      pipe(
        parsed?.threads ?? [],
        Arr.filter(
          (thread) =>
            typeof thread?.environmentId === "string" &&
            thread.environmentId.length > 0 &&
            typeof thread.threadId === "string" &&
            thread.threadId.length > 0 &&
            typeof thread.title === "string",
        ),
      ),
    ),
  );

  return MobileStorage.of({
    loadSavedConnections,
    saveConnection,
    clearSavedConnection,
    loadOrCreateAgentAwarenessDeviceId,
    loadAgentAwarenessDeviceId,
    loadAgentAwarenessRegistrationRecord,
    saveAgentAwarenessRegistrationRecord,
    clearAgentAwarenessRegistrationRecord,
    loadRecentThreadShortcuts,
    saveRecentThreadShortcuts: (threads) => writeJson(RECENT_THREAD_SHORTCUTS_KEY, { threads }),
  });
});

export const layer = Layer.effect(MobileStorage, make());
