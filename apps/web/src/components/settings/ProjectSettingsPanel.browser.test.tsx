import { RegistryContext } from "@effect/atom-react";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@lecturn/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@lecturn/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@lecturn/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@lecturn/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render, type Screen } from "../../../test/render";
import type { Project } from "../../types";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  projects: [] as Project[],
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  confirm: vi.fn<() => Promise<boolean>>(),
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
}));

// Session grants come from the server; each test drives them through these atoms.
vi.mock(import("@lecturn/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useThreadShells: () => [],
  waitForProjectRemoval: async () => true,
}));
vi.mock(import("~/state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      update: "update",
      delete: "delete",
    } as unknown as typeof actual.projectEnvironment,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: "update" | "delete") => state[command]) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));
vi.mock(import("~/lib/composerDraftUploads"), async (original) => ({
  ...(await original()),
  releaseProjectDraftUploads: state.releaseUploads,
}));
// These sections have separate data sources and their own tests.
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("./ProjectActionsSettings"), async (original) => ({
  ...(await original()),
  ProjectActionsSettings: (() => null) as never,
}));
// Lecturn: fork-only project sections render through their own tests.
vi.mock(import("../contextual/ContextualProjectSettings"), async (original) => ({
  ...(await original()),
  ContextualProjectSettings: (() => null) as never,
}));
vi.mock(import("../stave/StaveLifecycleNotice"), async (original) => ({
  ...(await original()),
  StaveLifecycleNotice: (() => null) as never,
}));
vi.mock(import("../stave/staveSpaceLifecycle"), async (original) => ({
  ...(await original()),
  useStaveArchiveLanding: (() => () => {}) as never,
}));
vi.mock(import("./StaveProjectSection"), async (original) => ({
  ...(await original()),
  StaveProjectSection: (() => null) as never,
}));
// A single signed-out account: account grouping passes the snapshots through.
vi.mock(import("../sidebar/accountProjectGroups"), async (original) => ({
  ...(await original()),
  useProjectAccountScope: () => null,
  useSidebarSegmentation: () => null,
}));
vi.mock(import("~/lib/staveProjectDeletion"), async (original) => ({
  ...(await original()),
  prepareStaveProjectDeletion: async () => ({ lines: [], staveSagaRemoveConfirmed: false }),
}));

vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  getProjectFileQueryAtom: () => missingProjectFile,
}));

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { type SettingsScopeSearch } from "./settingsScope";
import { retainSettingsScope, validateSettingsRouteSearch } from "./settingsScopeNavigation";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { platform: { machine: "server" } },
  },
}));
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "lecturn_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));
const missingProjectFile = Atom.make(AsyncResult.initial<never, never>());

function setup() {
  vi.clearAllMocks();
  state.sessions.clear();
  for (const id of [primaryId, remoteId])
    state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
  useComposerDraftStore.setState({ clearProjectDraftThreadId: state.clearDraft });
}

function projectKey() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
}

async function mountPanel(search: Omit<SettingsScopeSearch, "project"> = {}) {
  const key = projectKey();
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
  });
  const projectsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: "projects",
    component: () => (
      <ProjectSettingsPanel
        projectKey={key}
        environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
        checkoutKey={search.checkout ?? null}
      />
    ),
  });
  const query = new URLSearchParams({ project: key });
  for (const [name, value] of Object.entries(search)) {
    if (value !== undefined) query.set(name, value);
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute.addChildren([projectsRoute])]),
    history: createMemoryHistory({ initialEntries: [`/settings/projects?${query}`] }),
  });
  await router.load();
  // The panel's own route tree validates settings search params, which the default router lacks.
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RouterProvider router={router} />
      </RegistryContext.Provider>,
      { router: false },
    ),
  );
  await vi.waitFor(() => expect(nameInput(screen)).not.toBeNull());
  stack.move();
  return { ...screen, router };
}

const nameInput = (screen: Screen) =>
  screen.container.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
const removeCheckout = (screen: Screen, root: string) =>
  screen.container.querySelector<HTMLButtonElement>(`[aria-label="Remove checkout ${root}"]`)!;
const removeAll = (screen: Screen) =>
  [...screen.container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Remove all entries"),
  )!;

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(async () => appAtomRegistry.set(state.sessions.get(id)!, result));
}

describe("project settings permissions", () => {
  it("removes a writable checkout while removal of the mixed group stays denied", async () => {
    setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await mountPanel();
    const initialHref = screen.router.state.location.href;
    expect(removeAll(screen).disabled).toBe(true);

    await userEvent.click(removeCheckout(screen, "/work/primary"));
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledWith({
      environmentId: primaryId,
      // Lecturn: removal also carries the Stave saga confirmation (none for plain projects).
      input: { projectId: state.projects[0]!.id, force: true, staveSagaRemoveConfirmed: false },
    });
    await vi.waitFor(() => expect(state.releaseUploads).toHaveBeenCalledOnce());
    expect(state.clearDraft).toHaveBeenCalledOnce();
    expect(screen.router.state.location.href).toBe(initialHref);
  });
});
