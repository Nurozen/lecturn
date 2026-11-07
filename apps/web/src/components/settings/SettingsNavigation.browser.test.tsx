import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const close = vi.hoisted(() => vi.fn());
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  useSidebar: (() => ({ setOpenMobile: close })) as never,
}));
import { SettingsNavigationProvider, useBackToChat } from "./SettingsNavigation";

function Back() {
  return <button onClick={useBackToChat()}>Back to chat</button>;
}
// Renders under the test's own router (not the helper's), which disposing unmounts.
async function fixture(
  initialEntries = ["/earlier", "/local/thread-1"],
  beforeSettings?: () => Promise<void>,
) {
  vi.clearAllMocks();
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
  const screen = await render(
    <RouterContextProvider router={router}>
      <SettingsNavigationProvider>
        <Back />
      </SettingsNavigationProvider>
    </RouterContextProvider>,
    { router: false },
  );
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
  return {
    history,
    router,
    visit,
    nativeBack,
    container: screen.container,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}
it("unwinds all settings sections to the existing chat entry, then Back reaches earlier history", async () => {
  await using view = await fixture();
  const { history, visit, nativeBack } = view;
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
  await using view = await fixture();
  const { history, router, visit, nativeBack } = view;
  await visit("/draft/new-draft");
  await visit("/settings/general");
  await visit("/settings/appearance");
  await act(async () => {
    view.container.querySelector("button")!.click();
    await router.load();
  });
  expect(history.location.pathname).toBe("/draft/new-draft");
  expect(history.location.state.__TSR_index).toBe(2);
  await nativeBack();
  expect(history.location.pathname).toBe("/local/thread-1");
});
it("unwinds sections from a direct settings entry before replacing it with chat landing", async () => {
  await using view = await fixture(["/earlier", "/settings/connections"]);
  const { history, visit, nativeBack } = view;
  await visit("/settings/providers");
  await visit("/settings/general");
  expect(await nativeBack()).toBe(true);
  expect(history.location.pathname).toBe("/");
  expect(history.location.state.__TSR_index).toBe(1);
  expect(await nativeBack()).toBe(false);
  expect(history.location.pathname).toBe("/earlier");
});
it("replaces a direct settings entry without adding history", async () => {
  await using view = await fixture(["/settings/general"]);
  const { history, nativeBack } = view;
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
  await using view = await fixture(undefined, () => waiting);
  const { history, router, nativeBack } = view;
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
