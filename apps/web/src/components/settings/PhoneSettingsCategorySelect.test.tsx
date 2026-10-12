import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PhoneSettingsCategorySelect } from "./PhoneSettingsCategorySelect";
import { SettingsNavigationProvider, useBackToChat } from "./SettingsNavigation";

const close = vi.hoisted(() => vi.fn());
vi.mock("../ui/sidebar", () => ({ useSidebar: () => ({ setOpenMobile: close }) }));

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("self", window);
  vi.stubGlobal("history", {});
  vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

function Back() {
  return <button onClick={useBackToChat()}>Chat</button>;
}

async function fixture(initialEntries = ["/earlier", "/local/thread-1"]) {
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
  await act(async () => {
    renderer = create(
      <RouterContextProvider router={router}>
        <SettingsNavigationProvider>
          <PhoneSettingsCategorySelect />
          <Back />
        </SettingsNavigationProvider>
      </RouterContextProvider>,
    );
  });
  const choose = async (label: string) => {
    const option = renderer.root
      .findAllByType("option")
      .find((item) => item.children.join("") === label);
    expect(option).toBeDefined();
    await act(async () => {
      renderer.root
        .findByType("select")
        .props.onChange({ currentTarget: { value: option!.props.value } });
      await router.load();
    });
  };
  const back = async () => {
    await act(async () => {
      renderer.root.findByType("button").props.onClick();
      await router.load();
    });
  };
  return { history, router, choose, back };
}

it("opens Connections and Providers without adding history, then Chat and Back reach their original entries", async () => {
  const { history, router, choose, back } = await fixture();
  await act(async () => {
    await router.navigate({ to: "/settings/general", hash: "about" });
  });
  const index = history.location.state.__TSR_index;
  await choose("Connections");
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
  const { history, router, choose, back } = await fixture(["/earlier", "/settings/general"]);
  await choose("Providers");
  await choose("Connections");
  await back();
  expect(history.location.pathname).toBe("/");
  await act(async () => {
    history.back();
    await router.load();
  });
  expect(history.location.pathname).toBe("/earlier");
});
