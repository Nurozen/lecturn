import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const close = vi.hoisted(() => vi.fn());
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  useSidebar: (() => ({ setOpenMobile: close })) as never,
}));
import { SettingsNavigationProvider, useBackToChat } from "./SettingsNavigation";

let reactRoot: Root | null = null;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  container.remove();
  vi.unstubAllGlobals();
});
function Back() {
  return <button onClick={useBackToChat()}>Back to chat</button>;
}
async function fixture(
  initialEntries = ["/earlier", "/local/thread-1"],
  beforeSettings?: () => Promise<void>,
) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const routeTree = root.addChildren([
    chat.addChildren([
      createRoute({ getParentRoute: () => chat, path: "/" }),
      createRoute({ getParentRoute: () => chat, path: "$environmentId/$threadId" }),
      createRoute({ getParentRoute: () => chat, path: "draft/$draftId" }),
    ]),
    createRoute({ getParentRoute: () => root, path: "/earlier" }),
    createRoute({ getParentRoute: () => root, path: "/pull-requests" }),
    createRoute({
      getParentRoute: () => root,
      path: "/settings/$section",
      ...(beforeSettings ? { beforeLoad: beforeSettings } : {}),
    }),
  ]);
  const history = createMemoryHistory({ initialEntries });
  const router = createRouter({ routeTree, history, isServer: false });
  await router.load();
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot!.render(
      <RouterContextProvider router={router}>
        <SettingsNavigationProvider>
          <Back />
        </SettingsNavigationProvider>
      </RouterContextProvider>,
    );
  });
  const visit = async (to: string) => {
    await act(async () => {
      await router.navigate({ to });
    });
  };
  const nativeBack = async () => {
    const event = new Event("lecturn:native-back", { cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      if (!event.defaultPrevented) history.back();
      await router.load();
    });
    return event.defaultPrevented;
  };
  return { history, router, visit, nativeBack };
}
it("unwinds all settings sections to the existing chat entry, then Back reaches earlier history", async () => {
  const { history, visit, nativeBack } = await fixture();
  await visit("/pull-requests");
  close.mockClear();
  await visit("/settings/general");
  await visit("/settings/connections");
  await visit("/settings/providers");
  expect(close.mock.calls).toEqual([[false], [false], [false]]);
  expect(await nativeBack()).toBe(true);
  expect(history.location.pathname).toBe("/local/thread-1");
  expect(history.location.state.__TSR_index).toBe(1);
  expect(await nativeBack()).toBe(false);
  expect(history.location.pathname).toBe("/earlier");
  expect(await nativeBack()).toBe(false);
  expect(history.location.pathname).toBe("/earlier");
});
it("returns to draft chat through the same history entry from the Chat button", async () => {
  const { history, router, visit, nativeBack } = await fixture();
  await visit("/draft/new-draft");
  await visit("/settings/general");
  await visit("/settings/appearance");
  await act(async () => {
    container.querySelector("button")!.click();
    await router.load();
  });
  expect(history.location.pathname).toBe("/draft/new-draft");
  expect(history.location.state.__TSR_index).toBe(2);
  await nativeBack();
  expect(history.location.pathname).toBe("/local/thread-1");
});
it("unwinds sections from a direct settings entry before replacing it with chat landing", async () => {
  const { history, visit, nativeBack } = await fixture(["/earlier", "/settings/connections"]);
  await visit("/settings/providers");
  await visit("/settings/general");
  expect(await nativeBack()).toBe(true);
  expect(history.location.pathname).toBe("/");
  expect(history.location.state.__TSR_index).toBe(1);
  expect(await nativeBack()).toBe(false);
  expect(history.location.pathname).toBe("/earlier");
});
it("replaces a direct settings entry without adding history", async () => {
  const { history, nativeBack } = await fixture(["/settings/general"]);
  await nativeBack();
  expect(history.location.pathname).toBe("/");
  expect(history.location.state.__TSR_index).toBe(0);
  expect(await nativeBack()).toBe(false);
  expect(history.location.pathname).toBe("/");
});

it("keeps the chat destination while the new settings location waits for its route", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { history, router, nativeBack } = await fixture(undefined, () => waiting);
  let navigation: Promise<void>;
  await act(async () => {
    navigation = router.navigate({ to: "/settings/general" });
    await Promise.resolve();
  });
  await act(async () => {
    release();
    await navigation;
  });
  expect(history.location.pathname).toBe("/settings/general");
  expect(await nativeBack()).toBe(true);
  expect(history.location.pathname).toBe("/local/thread-1");
});
