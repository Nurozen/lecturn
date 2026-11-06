import {
  DEFAULT_SERVER_SETTINGS,
  ServerConfigStreamEvent,
  type ServerSettings as ServerSettingsValue,
  UsageLimitSourceId,
  type UsageLimitSourceConfig,
} from "@lecturn/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { BackgroundPolicy } from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { make } from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("hub");
const config = (name: string): UsageLimitSourceConfig => ({
  kind: "cliproxy",
  url: `http://${name}.test:8317`,
  managementKey: `${name}-key`,
  enabled: true,
});
const Body = Schema.Struct({
  auth_index: Schema.String,
  url: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture() {
  const requests: Array<{ host: string; path: string; body?: typeof Body.Type }> = [];
  const redeemed = new Set<string>();
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const name = url.hostname.split(".")[0]!;
      expect(request.headers.authorization).toBe(`Bearer ${name}-key`);
      const body =
        request.body._tag === "Uint8Array"
          ? decodeBody(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ host: name, path: url.pathname, ...(body ? { body } : {}) });
      if (url.pathname.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [
              {
                id: "seat.json",
                auth_index: `${name}-auth`,
                provider: "codex",
                id_token: { chatgpt_account_id: `${name}-account` },
              },
            ],
          }),
        );
      }
      expect(body?.auth_index).toBe(`${name}-auth`);
      if (url.pathname.endsWith("/reset-quota")) {
        return HttpClientResponse.fromWeb(request, Response.json({}));
      }
      expect(url.pathname).toBe("/v0/management/api-call");
      const consuming = body?.url?.endsWith("/consume");
      if (consuming) redeemed.add(name);
      const response = consuming
        ? { code: "reset" }
        : body?.url?.endsWith("/rate-limit-reset-credits")
          ? {
              credits: redeemed.has(name)
                ? []
                : [
                    {
                      id: `${name}-credit`,
                      status: "available",
                      reset_type: "codex_rate_limits",
                      expires_at: "2099-01-01T00:00:00Z",
                    },
                  ],
            }
          : { rate_limit: { primary_window: { used_percent: redeemed.has(name) ? 0 : 90 } } };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: 200, body: encodeJson(response) }),
      );
    }),
  );
  const service = (sources: Record<UsageLimitSourceId, UsageLimitSourceConfig>) =>
    make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, usageLimitSources: sources }),
            streamChanges: Stream.empty,
          }),
          Layer.mock(BackgroundPolicy)({ shouldRunScopeWork: () => Effect.succeed(false) }),
          Layer.succeed(HttpClient.HttpClient, http),
          NodeCrypto.layer,
        ),
      ),
    );
  return { requests, service };
}

describe("usage source reset credits", () => {
  it.effect("isolates identical source and account ids in separate environments", () =>
    Effect.gen(function* () {
      const test = fixture();
      const first = yield* test.service({ [sourceId]: config("first") });
      const second = yield* test.service({ [sourceId]: config("second") });
      yield* first.refresh;
      yield* second.refresh;
      expect((yield* first.current)[0]?.accounts[0]?.usageLimits.resetCredits?.nextCreditId).toBe(
        "first-credit",
      );
      expect((yield* second.current)[0]?.accounts[0]?.usageLimits.resetCredits?.nextCreditId).toBe(
        "second-credit",
      );
      expect(
        yield* second.consumeResetCredit({
          sourceId,
          accountId: "seat.json",
          creditId: "second-credit",
        }),
      ).toEqual({ outcome: "reset" });
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toEqual([
        { host: "second", path: "/v0/management/reset-quota", body: { auth_index: "second-auth" } },
      ]);
      const firstAccount = (yield* first.current)[0]?.accounts[0];
      const secondAccount = (yield* second.current)[0]?.accounts[0];
      expect(firstAccount?.usageLimits.resetCredits?.availableCount).toBe(1);
      expect(firstAccount?.usageLimits.windows[0]?.usedPercent).toBe(90);
      expect(secondAccount?.usageLimits.resetCredits?.availableCount).toBe(0);
      expect(secondAccount?.usageLimits.windows[0]?.usedPercent).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["missing", "disabled", "no-key"] as const)(
    "rejects a %s source without forwarding a redemption",
    (state) =>
      Effect.gen(function* () {
        const test = fixture();
        const sources =
          state === "missing"
            ? {}
            : {
                [sourceId]: {
                  ...config("first"),
                  enabled: state !== "disabled",
                  managementKey: state === "no-key" ? "" : "first-key",
                },
              };
        const service = yield* test.service(sources);
        const result = yield* service
          .consumeResetCredit({ sourceId, accountId: "seat.json", creditId: "credit" })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(test.requests).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect.each([
  { interval: Duration.seconds(0), expectedReads: 1, mode: "disabled" },
  { interval: Duration.minutes(1), expectedReads: 2, mode: "enabled" },
])(
  "honors $mode polling while preserving explicit and settings refreshes",
  ({ interval, expectedReads }) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const settingsChanges = yield* PubSub.unbounded<ServerSettingsValue>();
      const reads = yield* Ref.make(0);
      const allowBackgroundWork = yield* Ref.make(true);
      const sources = yield* make.pipe(
        Effect.provide([
          Layer.succeed(ServerSettings.ServerSettingsService, {
            ...settings,
            streamChanges: Stream.fromPubSub(settingsChanges),
          }),
          Layer.mock(BackgroundPolicy)({
            shouldRunScopeWork: (scope) =>
              scope.type === "provider-status"
                ? Ref.get(allowBackgroundWork)
                : Effect.succeed(false),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Ref.update(reads, (count) => count + 1).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json({ files: [] }))),
              ),
            ),
          ),
          NodeCrypto.layer,
        ]),
      );
      yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots.length === 1),
        Stream.runHead,
      );
      expect((yield* sources.current)[0]?.error).toBeUndefined();
      expect(yield* Ref.get(reads)).toBe(1);

      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(reads)).toBe(expectedReads);

      yield* sources.refresh;
      expect(yield* Ref.get(reads)).toBe(expectedReads + 1);

      const current = yield* settings.getSettings;
      const updated = yield* settings.updateSettings({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            ...current.usageLimitSources[UsageLimitSourceId.make("hub")]!,
            label: "Renamed hub",
          },
        },
      });
      yield* PubSub.publish(settingsChanges, updated);
      yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots[0]?.label === "Renamed hub"),
        Stream.runHead,
      );
      expect(yield* Ref.get(reads)).toBe(expectedReads + 2);

      yield* Ref.set(allowBackgroundWork, false);
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(reads)).toBe(expectedReads + 2);

      const beforeResuming = (yield* sources.current)[0]?.checkedAt;
      yield* Ref.set(allowBackgroundWork, true);
      yield* settings.updateSettings({ providerHealthRefreshInterval: Duration.minutes(1) });
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(reads)).toBeGreaterThan(expectedReads + 2);
      yield* sources.streamChanges.pipe(
        Stream.filter((snapshots) => snapshots[0]?.checkedAt !== beforeResuming),
        Stream.runHead,
      );
      yield* TestClock.adjust("30 seconds");
      const readsBeforeDisabling = yield* Ref.get(reads);
      yield* settings.updateSettings({ providerHealthRefreshInterval: Duration.seconds(0) });
      yield* TestClock.adjust("30 seconds");
      expect(yield* Ref.get(reads)).toBe(readsBeforeDisabling);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerHealthRefreshInterval: interval,
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "test-key",
              enabled: true,
            },
          },
        }),
      ),
      Effect.scoped,
    ),
);
