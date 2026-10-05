import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/session", () => ({ readPreparedConnection: () => null }));

import { useBrowserHistoryStore } from "./browserHistoryStore";
import { useDiffPanelStore } from "./diffPanelStore";
import { clearEnvironmentOwnedState } from "./environmentOwnedState";
import { useRightPanelStore } from "./rightPanelStore";
import { useTerminalUiStateStore } from "./terminalUiStateStore";
import { useUiStateStore } from "./uiStateStore";

const REMOVED = EnvironmentId.make("environment-removed");
const KEPT = EnvironmentId.make("environment-kept");
const refIn = (environmentId: EnvironmentId) => ({
  environmentId,
  threadId: ThreadId.make("thread-1"),
});
const threadKey = (environmentId: EnvironmentId) => scopedThreadKey(refIn(environmentId));
const projectKey = (environmentId: EnvironmentId) => `${environmentId}:/work/app`;
// Shared by every environment that has the repository checked out.
const REPOSITORY_KEY = "github.com/lecturn/app";
const PULL_REQUESTS_PANEL_KEY = "pull-requests-panel:pull-requests-panel";

function seed() {
  const environments = [REMOVED, KEPT];
  useUiStateStore.setState({
    projectExpandedById: {
      [projectKey(REMOVED)]: false,
      [projectKey(KEPT)]: false,
      [REPOSITORY_KEY]: false,
    },
    projectOrder: [projectKey(REMOVED), REPOSITORY_KEY, projectKey(KEPT)],
    threadLastVisitedAtById: Object.fromEntries(
      environments.map((id) => [threadKey(id), "2026-09-20T00:00:00.000Z"]),
    ),
    threadChangedFilesExpandedById: Object.fromEntries(
      environments.map((id) => [threadKey(id), { "turn-1": true }]),
    ),
    defaultAdvertisedEndpointKey: "endpoint-1",
  });
  useBrowserHistoryStore.setState({
    byProjectKey: {},
    projectKeyByThreadKey: {},
    pendingVisitsByThreadKey: {},
    pendingTitlesByThreadKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  for (const id of environments) {
    useDiffPanelStore.getState().selectBranchBaseRef(refIn(id), "main");
    useTerminalUiStateStore.getState().setTerminalOpen(refIn(id), true);
    useRightPanelStore.getState().openFile(refIn(id), "README.md");
    useBrowserHistoryStore.getState().registerThreadProject(refIn(id), projectKey(id));
    useBrowserHistoryStore.getState().recordVisit(projectKey(id), "http://localhost:3000/", 1_000);
  }
  useBrowserHistoryStore.getState().recordVisit(REPOSITORY_KEY, "http://localhost:4000/", 1_000);
  useRightPanelStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [PULL_REQUESTS_PANEL_KEY]: state.byThreadKey[threadKey(KEPT)]!,
    },
  }));
}

describe("clearEnvironmentOwnedState", () => {
  it("removes the removed environment's entries and leaves everything else", () => {
    seed();
    const keptTerminal =
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[threadKey(KEPT)];
    const keptPanel = useRightPanelStore.getState().byThreadKey[threadKey(KEPT)];
    expect(keptTerminal?.terminalOpen).toBe(true);
    expect(keptPanel?.surfaces).toHaveLength(1);
    expect(Object.keys(useTerminalUiStateStore.getState().terminalUiStateByThreadKey)).toHaveLength(
      2,
    );

    clearEnvironmentOwnedState(REMOVED);

    const ui = useUiStateStore.getState();
    expect(ui.projectExpandedById).toEqual({ [projectKey(KEPT)]: false, [REPOSITORY_KEY]: false });
    expect(ui.projectOrder).toEqual([REPOSITORY_KEY, projectKey(KEPT)]);
    expect(Object.keys(ui.threadLastVisitedAtById)).toEqual([threadKey(KEPT)]);
    expect(Object.keys(ui.threadChangedFilesExpandedById)).toEqual([threadKey(KEPT)]);
    expect(ui.defaultAdvertisedEndpointKey).toBe("endpoint-1");

    expect(useTerminalUiStateStore.getState().terminalUiStateByThreadKey).toEqual({
      [threadKey(KEPT)]: keptTerminal,
    });
    expect(useRightPanelStore.getState().byThreadKey).toEqual({
      [threadKey(KEPT)]: keptPanel,
      [PULL_REQUESTS_PANEL_KEY]: keptPanel,
    });
    const diff = useDiffPanelStore.getState();
    expect(Object.keys(diff.byThreadKey)).toEqual([threadKey(KEPT)]);
    expect(Object.keys(diff.branchBaseRefByThreadKey)).toEqual([threadKey(KEPT)]);
    const history = useBrowserHistoryStore.getState();
    expect(Object.keys(history.byProjectKey).toSorted()).toEqual(
      [projectKey(KEPT), REPOSITORY_KEY].toSorted(),
    );
    expect(history.projectKeyByThreadKey).toEqual({ [threadKey(KEPT)]: projectKey(KEPT) });
  });

  it("leaves every store as it is for an environment they hold nothing for", () => {
    seed();
    const before = [
      useUiStateStore.getState(),
      useTerminalUiStateStore.getState(),
      useRightPanelStore.getState(),
      useDiffPanelStore.getState(),
      useBrowserHistoryStore.getState(),
    ];
    clearEnvironmentOwnedState(EnvironmentId.make("environment"));
    expect([
      useUiStateStore.getState(),
      useTerminalUiStateStore.getState(),
      useRightPanelStore.getState(),
      useDiffPanelStore.getState(),
      useBrowserHistoryStore.getState(),
    ]).toEqual(before);
    expect(useUiStateStore.getState()).toBe(before[0]);
  });
});
