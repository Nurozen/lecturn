import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  acknowledgeLiveActivityResponse,
  handleIncomingAppLink,
  liveActivityLinkRevision,
  pendingLiveActivityResponses,
  queueLiveActivityLink,
  subscribeLiveActivityLinks,
} from "./activityLinking";
import { routeAgentNotificationResponseOnce } from "./notificationPayload";

beforeEach(() => {
  for (const [id] of pendingLiveActivityResponses()) acknowledgeLiveActivityResponse(id);
});

describe("Live Activity link hydration", () => {
  it("retains cold and warm links until the exact account environment arrives", () => {
    const navigate = vi.fn();
    const handledResponseIds = new Set<string>();
    const owners = new Map<string, string>();
    const drain = () => {
      for (const [id, response] of pendingLiveActivityResponses()) {
        const result = routeAgentNotificationResponseOnce({
          response,
          handledResponseIds,
          navigate,
          accountContext: {
            signedInAccountIds: ["work"],
            accountByEnvironmentId: owners,
            requestSignIn: vi.fn(),
          },
        });
        if (result === "handled") acknowledgeLiveActivityResponse(id);
      }
    };
    expect(queueLiveActivityLink("lecturn://threads/desktop/first?accountId=work")).toBe(true);
    drain();
    expect(navigate).not.toHaveBeenCalled();
    expect(handledResponseIds.size).toBe(0);
    const unsubscribe = subscribeLiveActivityLinks(drain);
    queueLiveActivityLink("lecturn-preview://threads/desktop/latest?accountId=work");
    expect(pendingLiveActivityResponses()).toHaveLength(1);
    owners.set("desktop", "work");
    drain();
    drain();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/threads/desktop/latest?accountId=work");
    expect(pendingLiveActivityResponses()).toHaveLength(0);
    unsubscribe();
  });

  it.each(["lecturn://settings", "lecturn://pr-watches/desktop/review"])(
    "lets a newer %s route supersede activity and saved notification replay",
    (url) => {
      queueLiveActivityLink("lecturn://threads/desktop/old?accountId=work");
      const savedResponseRevision = liveActivityLinkRevision();
      const listener = vi.fn();
      const unsubscribe = subscribeLiveActivityLinks(listener);
      expect(handleIncomingAppLink(url, ["lecturn://"])).toBe(false);
      expect(pendingLiveActivityResponses()).toEqual([]);
      expect(liveActivityLinkRevision()).toBeGreaterThan(savedResponseRevision);
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
    },
  );

  it.each([
    "lecturn://expo-development-client/?url=x",
    "lecturn://expo-sharing",
    "lecturn://oauth-native-callback?code=example",
    "lecturn-preview://sso-callback?code=example",
    "https://example.org/settings",
  ])("does not discard pending navigation for unrelated lifecycle URL %s", (url) => {
    queueLiveActivityLink("lecturn://threads/desktop/old?accountId=work");
    const revision = liveActivityLinkRevision();
    expect(handleIncomingAppLink(url, ["lecturn://"])).toBe(false);
    expect(pendingLiveActivityResponses()).toHaveLength(1);
    expect(liveActivityLinkRevision()).toBe(revision);
  });

  it("rejects reassigned environments without falling back to the active account", () => {
    queueLiveActivityLink("lecturn://threads/desktop/thread?accountId=work");
    const response = pendingLiveActivityResponses()[0]![1];
    const navigate = vi.fn();
    expect(
      routeAgentNotificationResponseOnce({
        response,
        handledResponseIds: new Set(),
        navigate,
        accountContext: {
          signedInAccountIds: ["work", "home"],
          accountByEnvironmentId: new Map([["desktop", "home"]]),
          requestSignIn: vi.fn(),
        },
      }),
    ).toBe("handled");
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    "lecturn://settings/auth",
    "lecturn://expo-development-client/?url=x",
    "https://example.org/threads/e/t?accountId=a",
    "lecturn://threads/e/t",
    "lecturn://threads/e/t?accountId=a&other=b",
  ])("leaves unrelated URL %s to standard linking", (url) => {
    expect(queueLiveActivityLink(url)).toBe(false);
    expect(pendingLiveActivityResponses()).toEqual([]);
  });
});
