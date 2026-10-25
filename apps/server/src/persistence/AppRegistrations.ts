/**
 * Connected-app registrations and pairing requests. A plain store, not
 * event-sourced: grants and cached tool definitions are environment state,
 * and lease heartbeats would churn an event log (spec R1.2).
 */
import { AppGrantState, AppId, AppRegistration, AppRuntimeCeiling } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { McpSchema } from "effect/ai";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type AppRegistrationRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const ToolsJson = Schema.NullOr(Schema.fromJsonString(Schema.Array(McpSchema.Tool)));
const RegistrationJson = Schema.fromJsonString(AppRegistration);

export const AppRegistrationRecord = Schema.Struct({
  appId: AppId,
  registration: RegistrationJson,
  state: AppGrantState,
  grantedFingerprint: Schema.NullOr(Schema.String),
  runtimeCeiling: AppRuntimeCeiling,
  cachedHeadlessTools: ToolsJson,
  cachedLiveTools: ToolsJson,
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AppRegistrationRecord = typeof AppRegistrationRecord.Type;

/** `superseded`: a newer request for the same app replaced it before a decision. */
export const AppPairingRequestState = Schema.Literals([
  "pending",
  "granted",
  "denied",
  "superseded",
]);
export type AppPairingRequestState = typeof AppPairingRequestState.Type;

export const AppPairingRequestRecord = Schema.Struct({
  requestId: Schema.String,
  appId: AppId,
  registration: RegistrationJson,
  pollSecretHash: Schema.String,
  state: AppPairingRequestState,
  expiresAt: Schema.DateTimeUtcFromString,
  credentialDelivered: Schema.BooleanFromBit,
  createdAt: Schema.DateTimeUtcFromString,
});
export type AppPairingRequestRecord = typeof AppPairingRequestRecord.Type;

/** Every column but `created_at`, which an update keeps. */
export interface AppRegistrationWrite {
  readonly appId: AppId;
  readonly registration: AppRegistration;
  readonly state: AppGrantState;
  readonly grantedFingerprint: string | null;
  readonly runtimeCeiling: AppRuntimeCeiling;
  readonly cachedHeadlessTools: ReadonlyArray<McpSchema.Tool> | null;
  readonly cachedLiveTools: ReadonlyArray<McpSchema.Tool> | null;
  readonly lastSeenAt: DateTime.Utc | null;
  readonly now: DateTime.Utc;
}

export interface AppPairingRequestWrite {
  readonly requestId: string;
  readonly appId: AppId;
  readonly registration: AppRegistration;
  readonly pollSecretHash: string;
  readonly expiresAt: DateTime.Utc;
  readonly now: DateTime.Utc;
}

export class AppRegistrationRepository extends Context.Service<
  AppRegistrationRepository,
  {
    readonly get: (
      appId: AppId,
    ) => Effect.Effect<Option.Option<AppRegistrationRecord>, AppRegistrationRepositoryError>;
    readonly list: Effect.Effect<
      ReadonlyArray<AppRegistrationRecord>,
      AppRegistrationRepositoryError
    >;
    readonly upsert: (
      input: AppRegistrationWrite,
    ) => Effect.Effect<void, AppRegistrationRepositoryError>;
    /** `false` when the app has no registration. */
    readonly setCachedTools: (input: {
      readonly appId: AppId;
      readonly tier: "headless" | "live";
      readonly tools: ReadonlyArray<McpSchema.Tool>;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<boolean, AppRegistrationRepositoryError>;
    readonly touchLastSeen: (input: {
      readonly appId: AppId;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void, AppRegistrationRepositoryError>;
    /** Removes the registration and its pairing requests. */
    readonly delete: (appId: AppId) => Effect.Effect<void, AppRegistrationRepositoryError>;
    /** Supersedes the app's earlier pending requests in the same transaction. */
    readonly createPairingRequest: (
      input: AppPairingRequestWrite,
    ) => Effect.Effect<void, AppRegistrationRepositoryError>;
    readonly getPairingRequest: (
      requestId: string,
    ) => Effect.Effect<Option.Option<AppPairingRequestRecord>, AppRegistrationRepositoryError>;
    /** Undecided and unexpired; at most one per app because creation supersedes. */
    readonly listPendingPairingRequests: (
      now: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<AppPairingRequestRecord>, AppRegistrationRepositoryError>;
    /** Decides a pending request; `false` when it was not pending. */
    readonly decidePairingRequest: (input: {
      readonly requestId: string;
      readonly state: "granted" | "denied";
    }) => Effect.Effect<boolean, AppRegistrationRepositoryError>;
    /** `true` exactly once per granted request, so the credential is handed out once. */
    readonly claimCredentialDelivery: (
      requestId: string,
    ) => Effect.Effect<boolean, AppRegistrationRepositoryError>;
  }
>()("lecturn/persistence/AppRegistrations/AppRegistrationRepository") {}

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): AppRegistrationRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : new PersistenceSqlError({ operation, cause });

const RawRegistrationRow = Schema.Struct({
  appId: Schema.Unknown,
  registration: Schema.Unknown,
  state: Schema.Unknown,
  grantedFingerprint: Schema.Unknown,
  runtimeCeiling: Schema.Unknown,
  cachedHeadlessTools: Schema.Unknown,
  cachedLiveTools: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const RawPairingRequestRow = Schema.Struct({
  requestId: Schema.Unknown,
  appId: Schema.Unknown,
  registration: Schema.Unknown,
  pollSecretHash: Schema.Unknown,
  state: Schema.Unknown,
  expiresAt: Schema.Unknown,
  credentialDelivered: Schema.Unknown,
  createdAt: Schema.Unknown,
});

const decodeRegistrationRow = Schema.decodeUnknownEffect(AppRegistrationRecord);
const decodePairingRequestRow = Schema.decodeUnknownEffect(AppPairingRequestRecord);
const encodeRegistration = Schema.encodeEffect(RegistrationJson);

// Tool definitions are plain JSON; encoding through the class schema would
// require instances, and callers hand over decoded wire objects.
const toolsJson = (tools: ReadonlyArray<McpSchema.Tool> | null) =>
  tools === null ? null : JSON.stringify(tools);

const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findRegistration = SqlSchema.findOneOption({
    Request: AppId,
    Result: RawRegistrationRow,
    execute: (appId) => sql`
      SELECT
        app_id AS "appId",
        registration_json AS "registration",
        state AS "state",
        granted_fingerprint AS "grantedFingerprint",
        runtime_ceiling AS "runtimeCeiling",
        cached_headless_tools_json AS "cachedHeadlessTools",
        cached_live_tools_json AS "cachedLiveTools",
        last_seen_at AS "lastSeenAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM app_registrations
      WHERE app_id = ${appId}
    `,
  });

  const listRegistrations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RawRegistrationRow,
    execute: () => sql`
      SELECT
        app_id AS "appId",
        registration_json AS "registration",
        state AS "state",
        granted_fingerprint AS "grantedFingerprint",
        runtime_ceiling AS "runtimeCeiling",
        cached_headless_tools_json AS "cachedHeadlessTools",
        cached_live_tools_json AS "cachedLiveTools",
        last_seen_at AS "lastSeenAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM app_registrations
      ORDER BY created_at, app_id
    `,
  });

  const pairingRequestColumns = sql`
    request_id AS "requestId",
    app_id AS "appId",
    registration_json AS "registration",
    poll_secret_hash AS "pollSecretHash",
    state AS "state",
    expires_at AS "expiresAt",
    credential_delivered AS "credentialDelivered",
    created_at AS "createdAt"
  `;

  const findPairingRequest = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RawPairingRequestRow,
    execute: (requestId) => sql`
      SELECT ${pairingRequestColumns}
      FROM app_pairing_requests
      WHERE request_id = ${requestId}
    `,
  });

  const listPending = SqlSchema.findAll({
    Request: Schema.String,
    Result: RawPairingRequestRow,
    execute: (now) => sql`
      SELECT ${pairingRequestColumns}
      FROM app_pairing_requests
      WHERE state = 'pending' AND expires_at > ${now}
      ORDER BY created_at, request_id
    `,
  });

  const get: AppRegistrationRepository["Service"]["get"] = (appId) =>
    findRegistration(appId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => decodeRegistrationRow(row).pipe(Effect.asSome),
        }),
      ),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.get")),
    );

  const list: AppRegistrationRepository["Service"]["list"] = listRegistrations(undefined).pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRegistrationRow(row))),
    Effect.mapError(toRepositoryError("AppRegistrationRepository.list")),
  );

  const upsert: AppRegistrationRepository["Service"]["upsert"] = (input) =>
    encodeRegistration(input.registration).pipe(
      Effect.flatMap(
        (registrationJson) => sql`
          INSERT INTO app_registrations (
            app_id, registration_json, state, granted_fingerprint, runtime_ceiling,
            cached_headless_tools_json, cached_live_tools_json, last_seen_at,
            created_at, updated_at
          )
          VALUES (
            ${input.appId}, ${registrationJson}, ${input.state}, ${input.grantedFingerprint},
            ${input.runtimeCeiling}, ${toolsJson(input.cachedHeadlessTools)},
            ${toolsJson(input.cachedLiveTools)}, ${iso(input.lastSeenAt)},
            ${iso(input.now)}, ${iso(input.now)}
          )
          ON CONFLICT (app_id) DO UPDATE SET
            registration_json = excluded.registration_json,
            state = excluded.state,
            granted_fingerprint = excluded.granted_fingerprint,
            runtime_ceiling = excluded.runtime_ceiling,
            cached_headless_tools_json = excluded.cached_headless_tools_json,
            cached_live_tools_json = excluded.cached_live_tools_json,
            last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        `,
      ),
      Effect.asVoid,
      Effect.mapError(toRepositoryError("AppRegistrationRepository.upsert")),
    );

  const setCachedTools: AppRegistrationRepository["Service"]["setCachedTools"] = ({
    appId,
    tier,
    tools,
    now,
  }) => {
    const json = toolsJson(tools);
    const statement =
      tier === "headless"
        ? sql<{ readonly appId: string }>`
            UPDATE app_registrations
            SET cached_headless_tools_json = ${json}, updated_at = ${iso(now)}
            WHERE app_id = ${appId}
            RETURNING app_id AS "appId"
          `
        : sql<{ readonly appId: string }>`
            UPDATE app_registrations
            SET cached_live_tools_json = ${json}, updated_at = ${iso(now)}
            WHERE app_id = ${appId}
            RETURNING app_id AS "appId"
          `;
    return statement.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.setCachedTools")),
    );
  };

  const touchLastSeen: AppRegistrationRepository["Service"]["touchLastSeen"] = ({ appId, at }) =>
    sql`UPDATE app_registrations SET last_seen_at = ${iso(at)} WHERE app_id = ${appId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toRepositoryError("AppRegistrationRepository.touchLastSeen")),
    );

  const deleteApp: AppRegistrationRepository["Service"]["delete"] = (appId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM app_pairing_requests WHERE app_id = ${appId}`;
          yield* sql`DELETE FROM app_registrations WHERE app_id = ${appId}`;
        }),
      )
      .pipe(Effect.mapError(toRepositoryError("AppRegistrationRepository.delete")));

  const createPairingRequest: AppRegistrationRepository["Service"]["createPairingRequest"] = (
    input,
  ) =>
    encodeRegistration(input.registration).pipe(
      Effect.flatMap((registrationJson) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE app_pairing_requests SET state = 'superseded'
              WHERE app_id = ${input.appId} AND state = 'pending'
            `;
            yield* sql`
              INSERT INTO app_pairing_requests (
                request_id, app_id, registration_json, poll_secret_hash, state,
                expires_at, credential_delivered, created_at
              )
              VALUES (
                ${input.requestId}, ${input.appId}, ${registrationJson}, ${input.pollSecretHash},
                'pending', ${iso(input.expiresAt)}, 0, ${iso(input.now)}
              )
            `;
          }),
        ),
      ),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.createPairingRequest")),
    );

  const getPairingRequest: AppRegistrationRepository["Service"]["getPairingRequest"] = (
    requestId,
  ) =>
    findPairingRequest(requestId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => decodePairingRequestRow(row).pipe(Effect.asSome),
        }),
      ),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.getPairingRequest")),
    );

  const listPendingPairingRequests: AppRegistrationRepository["Service"]["listPendingPairingRequests"] =
    (now) =>
      listPending(DateTime.formatIso(now)).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodePairingRequestRow(row))),
        Effect.mapError(toRepositoryError("AppRegistrationRepository.listPendingPairingRequests")),
      );

  const decidePairingRequest: AppRegistrationRepository["Service"]["decidePairingRequest"] = ({
    requestId,
    state,
  }) =>
    sql<{ readonly requestId: string }>`
      UPDATE app_pairing_requests SET state = ${state}
      WHERE request_id = ${requestId} AND state = 'pending'
      RETURNING request_id AS "requestId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.decidePairingRequest")),
    );

  const claimCredentialDelivery: AppRegistrationRepository["Service"]["claimCredentialDelivery"] = (
    requestId,
  ) =>
    sql<{ readonly requestId: string }>`
      UPDATE app_pairing_requests SET credential_delivered = 1
      WHERE request_id = ${requestId} AND state = 'granted' AND credential_delivered = 0
      RETURNING request_id AS "requestId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toRepositoryError("AppRegistrationRepository.claimCredentialDelivery")),
    );

  return AppRegistrationRepository.of({
    get,
    list,
    upsert,
    setCachedTools,
    touchLastSeen,
    delete: deleteApp,
    createPairingRequest,
    getPairingRequest,
    listPendingPairingRequests,
    decidePairingRequest,
    claimCredentialDelivery,
  });
});

export const layer = Layer.effect(AppRegistrationRepository, make);
