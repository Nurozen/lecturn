import type { EnvironmentId, LecturnProjectFileScript, ThreadId } from "@lecturn/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useLecturnProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
}));

vi.mock("../../hooks/useLecturnProjectFileScripts", () => ({
  useLecturnProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useLecturnProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useLecturnProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
  });

  it("passes checked-in lecturn.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<LecturnProjectFileScript>;
    testState.useLecturnProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useLecturnProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });
});
