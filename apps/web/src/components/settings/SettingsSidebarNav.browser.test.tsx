import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("./useAvailableSettingsSearchItems"), () => ({
  useAvailableSettingsSearchItems: () => [],
}));
vi.mock(import("../clerk/LecturnConnectSidebarSignIn"), () => ({
  LecturnConnectSidebarSignIn: ({ labelClassName }: { readonly labelClassName?: string } = {}) => (
    <button type="button">
      <span className={labelClassName}>Sign in to Lecturn Connect</span>
    </button>
  ),
  LecturnConnectSidebarAvatar: () => (
    <button type="button" id="connect-accounts" aria-label="Lecturn Connect accounts">
      A
    </button>
  ),
}));

import { SidebarProvider } from "../ui/sidebar";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const nav = (
  <SidebarProvider>
    <SettingsSidebarNav pathname="/settings/general" />
  </SidebarProvider>
);

async function viewport(width: number, height: number): Promise<AsyncDisposable> {
  const { innerWidth, innerHeight } = window;
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(innerWidth, innerHeight) };
}

const shown = (element: Element | null) => {
  if (!(element instanceof HTMLElement)) return false;
  const box = element.getBoundingClientRect();
  return box.width > 1 && box.height > 1;
};

it("keeps the Connect account menu and sign-in in the phone icon rail", async () => {
  await using _viewport = await viewport(390, 844);
  await using screen = await render(nav, {
    router: "/settings/general",
  });
  await expect.poll(() => shown(screen.container.querySelector("#connect-accounts"))).toBe(true);
  const signIn = page.getByRole("button", { name: "Sign in to Lecturn Connect" });
  await expect.element(signIn).toBeInTheDocument();
  // The rail is icon-only: the label stays for screen readers.
  const label = [...screen.container.querySelectorAll("span")].find(
    (span) => span.textContent === "Sign in to Lecturn Connect",
  );
  expect(shown(label ?? null)).toBe(false);
});

it("shows the sign-in label in the full sidebar", async () => {
  await using _viewport = await viewport(1280, 800);
  await using screen = await render(nav, {
    router: "/settings/general",
  });
  await expect.poll(() => shown(screen.container.querySelector("#connect-accounts"))).toBe(true);
  const label = [...screen.container.querySelectorAll("span")].find(
    (span) => span.textContent === "Sign in to Lecturn Connect",
  );
  expect(shown(label ?? null)).toBe(true);
});

function ScopeReader() {
  // Reads the scope the way the Settings modal layout does around the rail.
  return <span data-testid="scope-kind">{useSettingsScope().scope.kind}</span>;
}

it("renders the phone rail inside SettingsScopeProvider without scope errors", async () => {
  await using _viewport = await viewport(390, 844);
  using consoleError = vi.spyOn(console, "error");
  await using screen = await render(
    <SettingsScopeProvider search={{}} onChange={() => undefined}>
      <ScopeReader />
      {nav}
    </SettingsScopeProvider>,
    { router: "/settings/general" },
  );
  await expect.poll(() => shown(screen.container.querySelector("#connect-accounts"))).toBe(true);
  await expect.element(page.getByTestId("scope-kind")).toBeInTheDocument();
  const scopeErrors = consoleError.mock.calls.filter((call) =>
    call.some((value) => String(value).includes("SettingsScopeProvider")),
  );
  expect(scopeErrors).toEqual([]);
});
