import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PhoneSettingsCategorySelect } from "./PhoneSettingsCategorySelect";
import { SettingsNavigationProvider, useBackToChat } from "./SettingsNavigation";

const close = vi.hoisted(() => vi.fn());
vi.mock(import("../ui/sidebar"), async (original) => ({
  ...(await original()),
  useSidebar: (() => ({ setOpenMobile: close })) as never,
}));

function Back() {
  return <button onClick={useBackToChat()}>Chat</button>;
}

// Renders under the test's own router (not the helper's), which disposing unmounts.
async function fixture(initialEntries = ["/earlier", "/local/thread-1"]) {
  vi.clearAllMocks();
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const routeTree = root.addChildren([
    chat.addChildren([
      createRoute({ getParentRoute: () => chat, path: "/" }),
      createRoute({ getParentRoute: () => chat, path: "$environmentId/$threadId" }),
    ]),
    createRoute({ getParentRoute: () => root, path: "/earlier" }),
    createRoute({ getParentRoute: () => root, path: "/settings/$section" }),
  ]);
  const history = createMemoryHistory({ initialEntries });
  const router = createRouter({ routeTree, history, isServer: false });
  await router.load();
  const screen = await render(
    <RouterContextProvider router={router}>
      <SettingsNavigationProvider>
        <PhoneSettingsCategorySelect />
        <Back />
      </SettingsNavigationProvider>
    </RouterContextProvider>,
    { router: false },
  );
  const { container } = screen;
  const choose = async (label: string) => {
    const option = [...container.querySelectorAll("option")].find(
      (item) => item.textContent === label,
    );
    expect(option).toBeDefined();
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = option!.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await router.load();
    });
  };
  const back = async () => {
    await act(async () => {
      container.querySelector("button")!.click();
      await router.load();
    });
  };
  return {
    history,
    router,
    choose,
    back,
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

it("opens Connections and Providers without adding history, then Chat and Back reach their original entries", async () => {
  await using view = await fixture();
  const { history, router, choose, back } = view;
  await act(async () => {
    await router.navigate({ to: "/settings/general", hash: "about" });
  });
  const index = history.location.state.__TSR_index;
  await choose("Environments");
  expect(history.location.pathname).toBe("/settings/connections");
  expect(history.location.hash).toBe("");
  expect(history.location.state.__TSR_index).toBe(index);
  await choose("Providers");
  expect(history.location.pathname).toBe("/settings/providers");
  expect(history.location.state.__TSR_index).toBe(index);
  expect(close).not.toHaveBeenCalledWith(true);
  await back();
  expect(history.location.pathname).toBe("/local/thread-1");
  await act(async () => {
    history.back();
    await router.load();
  });
  expect(history.location.pathname).toBe("/earlier");
});

it("returns a direct Settings visit to chat landing without leaving a settings history loop", async () => {
  await using view = await fixture(["/earlier", "/settings/general"]);
  const { history, router, choose, back } = view;
  await choose("Providers");
  await choose("Environments");
  await back();
  expect(history.location.pathname).toBe("/");
  await act(async () => {
    history.back();
    await router.load();
  });
  expect(history.location.pathname).toBe("/earlier");
});
