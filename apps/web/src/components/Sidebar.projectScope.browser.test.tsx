import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@lecturn/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer, as in test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const THREAD = threadWithHistory("thread-scope", 2);
const lastAnswer = page.getByText(`Answer 1 for ${THREAD.id}.`);
const scopeLabel = page.getByTestId("sidebar-scope-label");

function setup() {
  const stack = new DisposableStack();
  stack.use(installFakeEnvironment([THREAD]));
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  stack.defer(() => useUiStateStore.getState().setSidebarProjectScopeKey(null));
  return stack;
}

const threadRouter = () =>
  getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${THREAD.id}`] }));

// Fetching the lazy app shell and route chunks is import cost, not behavior under test. On a
// cold CI runner it took 11s of the test's 15s budget, so it runs before the test starts.
const warmRouter = threadRouter();
await Promise.all([
  import("~/components/AppShell"),
  ...warmRouter
    .matchRoutes(warmRouter.state.location)
    .map((match) => warmRouter.looseRoutesById[match.routeId])
    .filter((route) => route !== undefined)
    .map((route) => warmRouter.loadRouteChunk(route)),
]);

async function mountThread() {
  const router = threadRouter();
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  // The app owns its router, as main.tsx does.
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  await expect.element(lastAnswer).toBeVisible();
  return screen;
}

it("keeps the thread open when a project scope is chosen and after a reload", async () => {
  using _environment = setup();
  await page.viewport(1400, 900);
  {
    await using _app = await mountThread();
    await expect.element(scopeLabel).toHaveTextContent("All projects");
    await userEvent.click(scopeLabel);
    await userEvent.click(page.getByRole("option", { name: "render" }));
    await expect.element(scopeLabel).toHaveTextContent("render");
    await expect.element(lastAnswer).toBeVisible();
  }
  expect(useUiStateStore.getState().sidebarProjectScopeKey).not.toBeNull();

  // The scope persists, so the next launch mounts with it already chosen.
  await using _reloaded = await mountThread();
  await expect.element(scopeLabel).toHaveTextContent("render");
});
