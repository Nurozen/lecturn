/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { Cookies, FetchHttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ManagedRelay } from "@lecturn/client-runtime/relay";

import { verifyDpopProof } from "@lecturn/shared/dpop";
import * as Dpop from "../cloud/dpop";
import * as ManagedRelayLayer from "../cloud/managedRelayLayer";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import { makeRelayDeviceRegistrationRequest } from "./registrationPayload";
import {
  syncAgentAwarenessAccounts,
  unregisterAgentAwarenessAccount,
  __resetAgentAwarenessRemoteRegistrationForTest,
  getAgentAwarenessRegistrationStatus,
  getAgentNotificationRegistrationEnabled,
  refreshAgentAwarenessRegistration,
  registerLiveActivityPushToken,
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { configureAndroidAgentNotifications } from "./androidNotifications";

vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: vi.fn(() => true),
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
}));

const secureStore = vi.hoisted(() => new Map<string, string>());
const widgetMocks = vi.hoisted(() => ({
  dismissEnded: vi.fn(),
  getInstances: vi.fn(() => []),
  start: vi.fn(() => ({})),
}));
const environmentConfigsMock = vi.hoisted(() => ({
  configs: new Map<
    string,
    { environment: { capabilities: { agentActivityPublishing?: boolean } } }
  >(),
}));
const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
}));
const appStateMock = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
}));
const registrationRecordStore = vi.hoisted(() => ({
  current: null as {
    readonly identity: string;
    readonly signature: string;
    readonly pushToStartToken?: string;
  } | null,
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "1.0.0",
      extra: {},
    },
  },
}));

vi.mock("expo-widgets", () => ({
  addPushToStartTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("./agentLiveActivity", () => ({
  dismissEndedAgentLiveActivities: widgetMocks.dismissEnded,
  getAgentLiveActivities: widgetMocks.getInstances,
  startAgentLiveActivity: widgetMocks.start,
}));

// Avoid importing the native connection stack; this gate only needs configs.
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => environmentConfigsMock.configs,
  },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environmentServerConfigsAtom"),
}));

vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: {
    SHA1: "SHA-1",
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
  },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError("expo-crypto digest data must be a typed array."));
    }
    return Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
    );
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return "ios";
    },
    get Version() {
      return "18.0";
    },
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMock.listeners.push(listener);
      return {
        remove: () => {
          const index = appStateMock.listeners.indexOf(listener);
          if (index >= 0) {
            appStateMock.listeners.splice(index, 1);
          }
        },
      };
    },
  },
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: unknown) =>
      new Promise((resolve) => {
        backgroundRuntime.pending.push({ operation, resolve });
      }),
  },
}));

vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({ liveActivitiesEnabled: false })),
  loadAgentAwarenessRegistrationRecord: vi.fn(() =>
    Promise.resolve(registrationRecordStore.current),
  ),
  saveAgentAwarenessRegistrationRecord: vi.fn((record: { identity: string; signature: string }) => {
    registrationRecordStore.current = record;
    return Promise.resolve();
  }),
  clearAgentAwarenessRegistrationRecord: vi.fn(() => {
    registrationRecordStore.current = null;
    return Promise.resolve();
  }),
}));

function proofIat(proof: string): number {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iat: number;
  };
  return decoded.iat;
}

const layerRelayTest = ManagedRelayLayer.layer("https://relay.example.test").pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Dpop.layer)),
);

const runBackgroundOperations = Effect.fn("TestRemoteRegistration.runBackgroundOperations")(
  function* () {
    let idlePasses = 0;
    // oxlint-disable-next-line lecturn/no-polling-loop-in-tests -- This harness drains mocked runtime jobs and their promise continuations, not external I/O or elapsed time.
    for (;;) {
      yield* Effect.promise(() => Promise.resolve());
      const pending = backgroundRuntime.pending.shift();
      if (!pending) {
        idlePasses++;
        if (idlePasses >= 3) {
          return;
        }
        continue;
      }
      idlePasses = 0;
      const exit = yield* Effect.exit(
        pending.operation as Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
      );
      yield* Effect.sync(() => {
        pending.resolve(exit);
      });
    }
  },
);

describe("makeRelayDeviceRegistrationRequest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "ios",
      data: "apns-token",
    });
    vi.unstubAllGlobals();
    vi.stubGlobal("__DEV__", false);
    secureStore.clear();

    vi.mocked(Notifications.getDevicePushTokenAsync)
      .mockReset()
      .mockResolvedValue({ type: "ios", data: "apns-token" });
    vi.mocked(Notifications.getPermissionsAsync)
      .mockReset()
      .mockResolvedValue({ granted: true } as never);
    backgroundRuntime.pending.length = 0;
    Constants.expoConfig!.extra = {};
    __resetAgentAwarenessRemoteRegistrationForTest();
    appStateMock.listeners.length = 0;
    registrationRecordStore.current = null;
    vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(clearAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockResolvedValue("device-1");
    widgetMocks.getInstances.mockReset();
    widgetMocks.getInstances.mockReturnValue([]);
    widgetMocks.start.mockClear();
    widgetMocks.dismissEnded.mockReset();
    environmentConfigsMock.configs.clear();
  });

  it("disables push features in Personal Team relay registrations", () => {
    Constants.expoConfig!.extra = { iosPersonalTeamBuild: true };

    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToken: "apns-token",
        pushToStartToken: "push-to-start-token",
        notificationsEnabled: true,
        preferences: {},
      }).preferences,
    ).toMatchObject({
      liveActivitiesEnabled: false,
      notificationsEnabled: false,
    });
  });

  it.effect("registers one push-token listener per Live Activity across wrappers", () => {
    const addPushTokenListener = vi.fn();
    // getInstances() returns a new wrapper for the same native activity each call.
    const wrapper = () => ({
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve(null)),
      addPushTokenListener,
    });

    return Effect.gen(function* () {
      setAgentAwarenessRelayTokenProvider(async () => "token", "account-a");
      expect(yield* registerLiveActivityPushToken({ activity: wrapper() as never })).toBe(false);
      expect(yield* registerLiveActivityPushToken({ activity: wrapper() as never })).toBe(false);

      expect(addPushTokenListener).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("registers a Live Activity push token that rotates after registration", () => {
    const registeredTokens: Array<string> = [];
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.endsWith("/v1/client/dpop-token")) {
        return Response.json({
          access_token: "relay-dpop-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 300,
          scope: "mobile:registration",
        });
      }
      if (url.endsWith("/v1/mobile/live-activities")) {
        const body = request instanceof Request ? await request.text() : String(init?.body);
        registeredTokens.push(
          (JSON.parse(body) as { readonly activityPushToken: string }).activityPushToken,
        );
      }
      return Response.json({ ok: true });
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test/" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    let tokenListener: ((event: { readonly pushToken: string }) => void) | undefined;
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn((listener: typeof tokenListener) => {
        tokenListener = listener;
        return { remove: vi.fn() };
      }),
    };

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(true);

      tokenListener?.({ pushToken: "rotated-activity-token" });
      yield* runBackgroundOperations();

      expect(registeredTokens).toEqual(["activity-token", "rotated-activity-token"]);
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provide(layerRelayTest),
    );
  });

  it.effect("registers a rotated Live Activity token only after an older registration", () => {
    const arrivals: Array<string> = [];
    let openOldRequest: (() => void) | undefined;
    const oldRequestGate = new Promise<void>((resolve) => {
      openOldRequest = resolve;
    });
    let markOldRequestArrived: (() => void) | undefined;
    const oldRequestArrived = new Promise<void>((resolve) => {
      markOldRequestArrived = resolve;
    });
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.endsWith("/v1/client/dpop-token")) {
        return Response.json({
          access_token: "relay-dpop-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 300,
          scope: "mobile:registration",
        });
      }
      if (url.endsWith("/v1/mobile/live-activities")) {
        const body = request instanceof Request ? await request.text() : String(init?.body);
        const token = (JSON.parse(body) as { readonly activityPushToken: string })
          .activityPushToken;
        arrivals.push(token);
        if (token === "activity-token") {
          markOldRequestArrived?.();
          await oldRequestGate;
        }
      }
      return Response.json({ ok: true });
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test/" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    let tokenListener: ((event: { readonly pushToken: string }) => void) | undefined;
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn((listener: typeof tokenListener) => {
        tokenListener = listener;
        return { remove: vi.fn() };
      }),
    };

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      const lookup = yield* Effect.forkChild(
        registerLiveActivityPushToken({ activity: activity as never }),
      );
      yield* Effect.promise(() => oldRequestArrived);

      tokenListener?.({ pushToken: "rotated-activity-token" });
      const deviceIdLookups = vi.mocked(loadOrCreateAgentAwarenessDeviceId).mock.calls.length;
      const rotated = backgroundRuntime.pending.shift()!;
      // Starting immediately runs the listener's registration until it suspends: on the
      // activity lock, or, without one, at its device-id lookup.
      const rotatedRegistration = yield* Effect.forkChild(
        Effect.exit(
          rotated.operation as Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
        ),
        { startImmediately: true },
      );
      expect(vi.mocked(loadOrCreateAgentAwarenessDeviceId).mock.calls).toHaveLength(
        deviceIdLookups,
      );
      expect(arrivals).toEqual(["activity-token"]);

      openOldRequest?.();
      yield* Fiber.join(lookup);
      rotated.resolve(yield* Fiber.join(rotatedRegistration));
      expect(arrivals).toEqual(["activity-token", "rotated-activity-token"]);
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provide(layerRelayTest),
    );
  });

  it.effect("still registers the active card when ended-card cleanup throws", () => {
    const registrations: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/v1/client/dpop-token")) {
        return Response.json({
          access_token: "relay-dpop-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "DPoP",
          expires_in: 300,
          scope: "mobile:registration",
        });
      }
      if (request.url.endsWith("/v1/mobile/live-activities")) {
        registrations.push(await request.json());
      }
      return Response.json({ ok: true });
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test/" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
      end: vi.fn(),
    };

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      widgetMocks.dismissEnded.mockReset();
      widgetMocks.dismissEnded.mockImplementation(() => {
        throw new Error("Cannot find function dismissEnded");
      });
      widgetMocks.getInstances.mockReturnValue([activity] as never);

      for (const listener of appStateMock.listeners) listener("active");
      yield* runBackgroundOperations();

      expect(widgetMocks.dismissEnded).toHaveBeenCalledOnce();
      expect(registrations).toEqual([
        { deviceId: "device-1", activityPushToken: "activity-token" },
      ]);
      expect(activity.end).not.toHaveBeenCalled();
      expect(widgetMocks.start).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.provide(layerRelayTest),
    );
  });

  it("ends local Live Activities and stops foreground reconciliation on cloud sign-out", () => {
    const end = vi.fn(() => Promise.resolve());
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
      end,
    };
    widgetMocks.getInstances.mockReturnValue([activity] as never);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    expect(appStateMock.listeners).toHaveLength(1);

    setAgentAwarenessRelayTokenProvider(null);

    expect(end).toHaveBeenCalledWith("immediate");
    expect(widgetMocks.dismissEnded).toHaveBeenCalled();
    expect(appStateMock.listeners).toHaveLength(0);
  });

  it.effect("registers the APNs device when cloud auth becomes available", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [request, init] = fetchMock.mock.calls[1] as unknown as [
        unknown,
        RequestInit | undefined,
      ];
      const url = request instanceof Request ? request.url : String(request);
      const method = request instanceof Request ? request.method : init?.method;
      const headers = request instanceof Request ? request.headers : new Headers(init?.headers);
      const dpop = headers.get("dpop");
      expect(url).toBe("https://relay.example.test/v1/mobile/devices");
      expect(method).toBe("POST");
      expect(headers.get("authorization")).toBe("DPoP relay-dpop-token");
      expect(dpop).toEqual(expect.any(String));
      if (!dpop) {
        throw new Error("Missing DPoP header.");
      }
      expect(
        verifyDpopProof({
          proof: dpop,
          method: "POST",
          url: "https://relay.example.test/v1/mobile/devices",
          expectedAccessToken: "relay-dpop-token",
          nowEpochSeconds: proofIat(dpop),
        }),
      ).toMatchObject({ ok: true });
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect(
    "does not enable notifications for an accepted registration without an APNs token",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);
      vi.stubGlobal(
        "fetch",
        vi.fn((request: RequestInfo | URL) =>
          Promise.resolve(
            Response.json(
              (request instanceof Request ? request.url : String(request)).endsWith("/dpop-token")
                ? {
                    access_token: "relay-dpop-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "DPoP",
                    expires_in: 300,
                    scope: "mobile:registration",
                  }
                : { ok: true },
            ),
          ),
        ),
      );
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      return Effect.gen(function* () {
        yield* refreshAgentAwarenessRegistration();
        expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
        expect(getAgentNotificationRegistrationEnabled()).toBe(false);
      }).pipe(
        Effect.provide(layerRelayTest),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
    },
  );

  it.effect(
    "finishes a stalled APNs lookup and enables notifications when the token arrives later",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      const requests: Array<{
        pushToken?: string;
        preferences: { notificationsEnabled: boolean };
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith("/dpop-token")) {
            return Response.json({
              access_token: "relay-dpop-token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 300,
              scope: "mobile:registration",
            });
          }
          requests.push(await request.json());
          return Response.json({ ok: true });
        }),
      );
      vi.mocked(Notifications.getDevicePushTokenAsync).mockImplementation(
        () => new Promise(() => {}),
      );
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      return Effect.gen(function* () {
        const refresh = yield* refreshAgentAwarenessRegistration().pipe(Effect.forkChild);
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(refresh);
        expect(getAgentNotificationRegistrationEnabled()).toBe(false);
        expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
        expect(requests).toHaveLength(0);

        vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
          type: "ios",
          data: "late-apns-token",
        });
        yield* refreshAgentAwarenessRegistration();
        expect(getAgentNotificationRegistrationEnabled()).toBe(true);
        expect(requests.at(-1)).toMatchObject({
          pushToken: "late-apns-token",
          preferences: { notificationsEnabled: true },
        });
        setAgentAwarenessRelayTokenProvider(null);
        expect(getAgentNotificationRegistrationEnabled()).toBe(false);
      }).pipe(
        Effect.provide(layerRelayTest),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
    },
  );

  it.effect(
    "keeps the token delivered by the native listener when an older lookup times out",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      const nativeStarted = Promise.withResolvers<void>();
      vi.mocked(Notifications.getDevicePushTokenAsync).mockImplementation(() => {
        nativeStarted.resolve();
        return new Promise(() => {});
      });
      const requests: Array<{
        pushToken?: string;
        preferences: { notificationsEnabled: boolean };
      }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith("/dpop-token")) {
            return Response.json({
              access_token: "relay-dpop-token",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "DPoP",
              expires_in: 300,
              scope: "mobile:registration",
            });
          }
          requests.push(await request.json());
          return Response.json({ ok: true });
        }),
      );
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      return Effect.gen(function* () {
        const refresh = yield* refreshAgentAwarenessRegistration().pipe(Effect.forkChild);
        yield* Effect.promise(() => nativeStarted.promise);
        const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
        expect(listener).toBeDefined();
        listener!({ type: "ios", data: "new-native-token" });
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(refresh);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          pushToken: "new-native-token",
          preferences: { notificationsEnabled: true },
        });
        expect(getAgentNotificationRegistrationEnabled()).toBe(true);
      }).pipe(
        Effect.provide(layerRelayTest),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
    },
  );

  it.effect(
    "does not overwrite a saved push registration when APNs lookup fails after a restart",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      const accepted = { identity: "user-a", signature: "previously-accepted-push-registration" };
      registrationRecordStore.current = accepted;
      vi.mocked(Notifications.getDevicePushTokenAsync).mockRejectedValue(
        new Error("APNs temporarily unavailable"),
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");
      return Effect.gen(function* () {
        yield* refreshAgentAwarenessRegistration();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(registrationRecordStore.current).toEqual(accepted);
        expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(layerRelayTest),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
    },
  );

  it.effect("keeps a registered status when a later refresh fails", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");

      vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
        new Error("transient failure"),
      );
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("does not re-register the same account when nothing has changed", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).toHaveBeenCalledTimes(1);
      expect(registrationRecordStore.current).not.toBeNull();

      vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect("continues queued device registration after a failed auth lookup", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    const tokenProvider = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("auth unavailable"))
      .mockResolvedValue("clerk-token-user-a");
    setAgentAwarenessRelayTokenProvider(tokenProvider);
    const tokenListener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
    expect(tokenListener).toBeDefined();
    tokenListener?.({ type: "ios", data: "rotated-apns-token" } as never);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(backgroundRuntime.pending).toHaveLength(0);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect(
    "registers each account with the complete device set and falls back to primary on an older relay",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      const requests: Array<{ deviceAccountIds?: string[] }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith("/dpop-token"))
          return Response.json({
            access_token: "relay-dpop-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          });
        if (request.url.endsWith("/devices") && request.method === "POST")
          requests.push(await request.json());
        return Response.json({ ok: true });
      });
      const providers = new Map([
        ["a", async () => "token-a"],
        ["b", async () => "token-b"],
      ]);
      syncAgentAwarenessAccounts(providers, "a", true);
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests.every((request) => request.deviceAccountIds?.join(",") === "a,b")).toBe(
          true,
        );
        expect(
          new Set(
            vi
              .mocked(saveAgentAwarenessRegistrationRecord)
              .mock.calls.map(([record]) => record.identity),
          ),
        ).toEqual(new Set(["a", "b"]));
        requests.length = 0;
        syncAgentAwarenessAccounts(providers, "a", false);
        yield* runBackgroundOperations();
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.deviceAccountIds === undefined)).toBe(true);
      }).pipe(
        Effect.provide(layerRelayTest),
        Effect.provideService(FetchHttpClient.Fetch, fetchMock),
      );
    },
  );

  it.effect("ending account B preserves A's activity and clears only B's registration", () => {
    const a = {
      getId: () => "activity-a",
      getAccountId: () => "a",
      end: vi.fn(async () => {}),
      getPushToken: async () => null,
      addPushTokenListener: vi.fn(),
    };
    const b = {
      getId: () => "activity-b",
      getAccountId: () => "b",
      end: vi.fn(async () => {}),
      getPushToken: async () => null,
      addPushTokenListener: vi.fn(),
    };
    widgetMocks.getInstances.mockReturnValue([a, b] as never);
    syncAgentAwarenessAccounts(
      new Map([
        ["a", async () => "a"],
        ["b", async () => "b"],
      ]),
      "a",
      true,
    );
    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      yield* unregisterAgentAwarenessAccount("b", async () => "b");
      expect(a.end).not.toHaveBeenCalled();
      expect(b.end).toHaveBeenCalledWith("immediate");
      expect(clearAgentAwarenessRegistrationRecord).toHaveBeenCalledWith("b");
    }).pipe(Effect.provide(layerRelayTest));
  });
  it.each([true, false])(
    "retires revoked and unowned native cards on cold sync while preserving signed-in owners (supported=%s)",
    (supported) => {
      const card = (id: string, owner: string | null) => ({
        getId: () => id,
        getAccountId: () => owner,
        end: vi.fn(async () => {}),
      });
      const expired = card("expired", "expired-account");
      const primary = card("primary", "a");
      const secondary = card("secondary", "b");
      const unowned = card("legacy", null);
      widgetMocks.getInstances.mockReturnValue([expired, primary, secondary, unowned] as never);
      syncAgentAwarenessAccounts(
        new Map([
          ["a", async () => "a"],
          ["b", async () => "b"],
        ]),
        "a",
        supported,
      );
      expect(expired.end).toHaveBeenCalledWith("immediate");
      expect(unowned.end).toHaveBeenCalledWith("immediate");
      expect(primary.end).not.toHaveBeenCalled();
      expect(secondary.end).not.toHaveBeenCalled();
      expect(clearAgentAwarenessRegistrationRecord).toHaveBeenCalledWith("expired-account");
      expect(clearAgentAwarenessRegistrationRecord).not.toHaveBeenCalledWith("a");
      expect(clearAgentAwarenessRegistrationRecord).not.toHaveBeenCalledWith("b");
    },
  );
  it("retires only removed sessions' local cards when revocation bypasses explicit sign-out", () => {
    const a = { getId: () => "a", getAccountId: () => "a", end: vi.fn(async () => {}) };
    const b = { getId: () => "b", getAccountId: () => "b", end: vi.fn(async () => {}) };
    widgetMocks.getInstances.mockReturnValue([a, b] as never);
    const aProvider = async () => "a";
    syncAgentAwarenessAccounts(
      new Map([
        ["a", aProvider],
        ["b", async () => "b"],
      ]),
      "a",
      true,
    );
    syncAgentAwarenessAccounts(new Map([["a", aProvider]]), "a", true);
    expect(a.end).not.toHaveBeenCalled();
    expect(b.end).toHaveBeenCalledWith("immediate");
    expect(clearAgentAwarenessRegistrationRecord).toHaveBeenCalledWith("b");
  });
  it.effect(
    "orders a delayed A-only token claim before B joins and rebuilds queued claims with both owners",
    () => {
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      return Effect.gen(function* () {
        const originalClient = yield* ManagedRelay.ManagedRelayClient;
        const oldAStarted = yield* Deferred.make<void>();
        const releaseOldA = yield* Deferred.make<void>();
        const bAuthRead = Promise.withResolvers<void>();
        const requests: Array<{ owner: string; accounts: ReadonlyArray<string> }> = [];
        const tokenOwners = new Set<string>();
        const client: typeof originalClient = {
          ...originalClient,
          registerDevice: ({ clerkToken: owner, payload }) =>
            Effect.gen(function* () {
              requests.push({ owner, accounts: payload.deviceAccountIds ?? [owner] });
              if (requests.length === 1) {
                yield* Deferred.succeed(oldAStarted, undefined);
                yield* Deferred.await(releaseOldA);
              }
              // Same retention rule as relay token claiming: omitted owners are evicted.
              for (const id of tokenOwners)
                if (!payload.deviceAccountIds?.includes(id)) tokenOwners.delete(id);
              tokenOwners.add(owner);
              return { ok: true as const };
            }),
        };
        yield* Effect.gen(function* () {
          const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];
          const startQueued = Effect.gen(function* () {
            for (const pending of backgroundRuntime.pending.splice(0)) {
              fibers.push(
                yield* Effect.forkChild(
                  (
                    pending.operation as Effect.Effect<
                      unknown,
                      unknown,
                      ManagedRelay.ManagedRelayClient
                    >
                  ).pipe(
                    Effect.exit,
                    Effect.tap((exit) => Effect.sync(() => pending.resolve(exit))),
                  ),
                ),
              );
            }
          });
          const a = async () => "a";
          syncAgentAwarenessAccounts(new Map([["a", a]]), "a", true);
          yield* startQueued;
          yield* Deferred.await(oldAStarted);
          expect(requests).toEqual([{ owner: "a", accounts: ["a"] }]);
          syncAgentAwarenessAccounts(
            new Map([
              ["a", a],
              [
                "b",
                async () => {
                  bAuthRead.resolve();
                  return "b";
                },
              ],
            ]),
            "a",
            true,
          );
          yield* startQueued;
          yield* Effect.promise(() => bAuthRead.promise);
          // Drain already-resolved native/storage promise continuations without timers.
          for (let pass = 0; pass < 6; pass++) yield* Effect.promise(() => Promise.resolve());
          expect(requests).toHaveLength(1);
          yield* Deferred.succeed(releaseOldA, undefined);
          yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));
          yield* runBackgroundOperations();
          expect(tokenOwners).toEqual(new Set(["a", "b"]));
          expect(requests.slice(1).every((request) => request.accounts.join(",") === "a,b")).toBe(
            true,
          );
        }).pipe(Effect.provideService(ManagedRelay.ManagedRelayClient, client));
      }).pipe(Effect.provide(layerRelayTest));
    },
  );
  it.effect.each(["ios", "android"] as const)(
    "does not enable %s notifications when a token rotates after permission is revoked",
    (os) => {
      vi.spyOn(Platform, "OS", "get").mockReturnValue(os);
      vi.spyOn(Platform, "Version", "get").mockReturnValue(os === "ios" ? 18 : 36);
      vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
        type: os,
        data: "initial",
      });
      const registrations: unknown[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/v1/client/dpop-token")) {
          return Response.json({
            access_token: "dpop",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          });
        }
        registrations.push(await request.json());
        return Response.json({ ok: true });
      });
      Constants.expoConfig!.extra = { relay: { url: "https://permission-relay.example.test" } };
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk"), "user-a");
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          preferences: { notificationsEnabled: true },
        });
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
          granted: false,
        } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        const listener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
        listener({ type: os, data: "rotated" });
        yield* runBackgroundOperations();
        expect(registrations.at(-1)).toMatchObject({
          preferences: { notificationsEnabled: false },
        });
        expect(registrations.at(-1)).not.toHaveProperty("pushToken");
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.provide(
          ManagedRelayLayer.layer("https://permission-relay.example.test").pipe(
            Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Dpop.layer)),
          ),
        ),
      );
    },
  );
  it.effect("preserves relay rejection errors with React Native response headers", () => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "android",
      data: "fcm-token",
    });
    const rejectedResponse = new Response("Unsupported device platform", { status: 400 });
    Object.defineProperty(rejectedResponse.headers, "getSetCookie", { value: undefined });
    vi.stubGlobal("fetch", (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      const response = url.endsWith("/v1/client/dpop-token")
        ? Response.json({
            access_token: "relay-dpop-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "mobile:registration",
          })
        : rejectedResponse;
      Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
      return Promise.resolve(response);
    });
    Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");

    return Effect.gen(function* () {
      // Hermes' compiled error hashing reads the response's cookie getter.
      const httpResponse = HttpClientResponse.fromWeb(
        HttpClientRequest.post("https://relay.example.test/v1/mobile/devices"),
        rejectedResponse,
      );
      expect(httpResponse.cookies).toEqual(Cookies.empty);
      const result = yield* Effect.exit(
        updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: true }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.hasDies(result.cause)).toBe(false);
        expect(Cause.squash(result.cause)).toBeInstanceOf(
          ManagedRelay.ManagedRelayRequestFailedError,
        );
      }
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerRelayTest));
  });

  it.effect(
    "does not reconfigure or register a detached Android account from an in-flight operation",
    () => {
      vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
      vi.spyOn(Platform, "Version", "get").mockReturnValue(36);
      Constants.expoConfig!.extra = { relay: { url: "https://relay.example.test" } };
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token"), "user-a");
      releaseAgentAwarenessRelayTokenProvider();
      vi.mocked(configureAndroidAgentNotifications).mockClear();
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        expect(configureAndroidAgentNotifications).not.toHaveBeenCalled();
        expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layerRelayTest));
    },
  );
});
