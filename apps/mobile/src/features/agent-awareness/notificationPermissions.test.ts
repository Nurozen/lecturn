import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Notifications from "expo-notifications";

import { enableAgentNotifications } from "./notificationPermissions";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
}));

describe("enabling device notifications", () => {
  beforeEach(() => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as never);
    vi.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as never);
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
