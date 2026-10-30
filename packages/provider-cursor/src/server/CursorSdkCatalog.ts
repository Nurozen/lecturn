import type { SDKModel, SDKUser } from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CursorSdk from "./CursorSdk.ts";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedError<CursorSdkCatalogError>()(
  "CursorSdkCatalogError",
  {
    authenticationFailure: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.authenticationFailure
      ? "Cursor SDK authentication failed."
      : "Cursor SDK catalog request failed.";
  }
}

export class CursorSdkCatalog extends Context.Service<
  CursorSdkCatalog,
  {
    readonly read: (
      apiKey: string,
    ) => Effect.Effect<CursorSdkCatalogSnapshot, CursorSdkCatalogError>;
  }
>()("@lecturn/provider-cursor/server/CursorSdkCatalog") {}

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const sdkRequest = <A>(
  cursorSdk: CursorSdk.CursorSdk["Service"],
  request: (sdk: CursorSdk.CursorSdkModule) => Promise<A>,
) =>
  cursorSdk.load.pipe(
    Effect.mapError((cause) => new CursorSdkCatalogError({ authenticationFailure: false, cause })),
    Effect.flatMap((sdk) =>
      Effect.tryPromise({
        try: () => request(sdk),
        catch: (cause) =>
          new CursorSdkCatalogError({
            authenticationFailure:
              cause instanceof sdk.AuthenticationError ||
              (cause instanceof sdk.CursorSdkError && cause.status === 401),
            cause,
          }),
      }),
    ),
  );

const makeLiveProbes = (cursorSdk: CursorSdk.CursorSdk["Service"]): CursorSdkCatalogProbes => ({
  readUser: (apiKey) => sdkRequest(cursorSdk, ({ Cursor }) => Cursor.me({ apiKey })),
  readModels: (apiKey) => sdkRequest(cursorSdk, ({ Cursor }) => Cursor.models.list({ apiKey })),
});

export const makeCursorSdkCatalog = Effect.fn("CursorSdkCatalog.make")(function* (
  probes: CursorSdkCatalogProbes,
) {
  const modelCache = yield* Cache.makeWith(probes.readModels, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
  });
  return CursorSdkCatalog.of({
    read: (apiKey) =>
      Effect.all(
        {
          user: probes.readUser(apiKey),
          models: Cache.get(modelCache, apiKey),
        },
        { concurrency: "unbounded" },
      ),
  });
});

export const layer = Layer.effect(
  CursorSdkCatalog,
  Effect.flatMap(CursorSdk.CursorSdk, (cursorSdk) =>
    makeCursorSdkCatalog(makeLiveProbes(cursorSdk)),
  ),
);

export function layerTest(
  read: CursorSdkCatalog["Service"]["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
