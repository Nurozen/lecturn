import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Notifications from "expo-notifications";

import {
  enableAgentNotifications,
  requestAgentNotificationPermission,
} from "./notificationPermissions";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
}));

function resetNotificationMocks() {
  vi.clearAllMocks();
  vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    granted: false,
    canAskAgain: true,
  } as never);
  vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
    granted: true,
    canAskAgain: true,
  } as never);
}

describe("enabling device notifications", () => {
  beforeEach(() => {
    resetNotificationMocks();
    platform.OS = "ios";
  });

  it.effect(
    "updates permission immediately after Allow while delivery registration is still pending",
    () =>
      Effect.gen(function* () {
        const registrationStarted = yield* Deferred.make<void>();
        const registrationFinished = yield* Deferred.make<void>();
        let permissionEnabled = false;
        const registration = Deferred.succeed(registrationStarted, undefined).pipe(
          Effect.andThen(Deferred.await(registrationFinished)),
        );
        const enabling = yield* enableAgentNotifications(registration, () => {
          permissionEnabled = true;
        }).pipe(Effect.forkChild);
        yield* Deferred.await(registrationStarted);
        expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
        expect(permissionEnabled).toBe(true);
        yield* Deferred.succeed(registrationFinished, undefined);
        expect(yield* Fiber.join(enabling)).toEqual({ type: "granted" });
      }),
  );

  it.effect("keeps allowed permission visible if delivery registration times out", () =>
    Effect.gen(function* () {
      const permissionChanged = yield* Deferred.make<void>();
      let permissionEnabled = false;
      const enabling = yield* enableAgentNotifications(
        Deferred.succeed(permissionChanged, undefined).pipe(Effect.andThen(Effect.never)),
        () => {
          permissionEnabled = true;
        },
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(permissionChanged);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(enabling)).toMatchObject({
        message:
          "Notification setup is taking too long. Check your internet connection and try again.",
      });
      expect(permissionEnabled).toBe(true);
    }),
  );

  it.effect("does not enable permission or register when the user denies access", () => {
    vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as never);
    const onGranted = vi.fn();
    const register = vi.fn();
    return Effect.gen(function* () {
      expect(yield* enableAgentNotifications(Effect.sync(register), onGranted)).toEqual({
        type: "denied",
        canAskAgain: false,
      });
      expect(onGranted).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    });
  });
});

describe("agent notification permission", () => {
  beforeEach(() => {
    resetNotificationMocks();
    platform.OS = "android";
  });

  it.effect("creates an Android channel before prompting for notification permission", () =>
    Effect.gen(function* () {
      expect(yield* requestAgentNotificationPermission).toEqual({ type: "granted" });
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith("agent-alerts", {
        name: "Agent alerts",
        importance: 4,
      });
      expect(
        vi.mocked(Notifications.setNotificationChannelAsync).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(Notifications.requestPermissionsAsync).mock.invocationCallOrder[0]!);
    }),
  );

  it.effect("preserves denied permission when Android cannot ask again", () =>
    Effect.gen(function* () {
      vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
        granted: false,
        canAskAgain: false,
      } as Notifications.NotificationPermissionsStatus);
      expect(yield* requestAgentNotificationPermission).toEqual({
        type: "denied",
        canAskAgain: false,
      });
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps iOS permission requests free of Android channel setup", () =>
    Effect.gen(function* () {
      platform.OS = "ios";
      expect(yield* requestAgentNotificationPermission).toEqual({ type: "granted" });
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }),
  );
});
