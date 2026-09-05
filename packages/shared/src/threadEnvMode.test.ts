import { describe, expect, it } from "vite-plus/test";

import { isDefaultThreadEnvModeSettled, resolveDefaultThreadEnvMode } from "./threadEnvMode.ts";

describe("resolveDefaultThreadEnvMode", () => {
  it("prefers the project setting over t3.json over the global default", () => {
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: "local",
        projectFile: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: null,
        projectFile: "local",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: undefined,
        projectFile: null,
        globalDefault: "worktree",
      }),
    ).toBe("worktree");
  });

  it("lets a forced mode outrank the project setting, t3.json and the global default", () => {
    expect(
      resolveDefaultThreadEnvMode({
        forcedMode: "local",
        projectSetting: "worktree",
        projectFile: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        forcedMode: "worktree",
        projectSetting: "local",
        projectFile: "local",
        globalDefault: "local",
      }),
    ).toBe("worktree");
  });

  it("falls through to the existing order when the forced mode is absent", () => {
    expect(
      resolveDefaultThreadEnvMode({
        forcedMode: null,
        projectSetting: "local",
        projectFile: "worktree",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        forcedMode: undefined,
        projectSetting: null,
        projectFile: null,
        globalDefault: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("isDefaultThreadEnvModeSettled", () => {
  it("settles on an explicit pick or project setting even while the file loads", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: "local",
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(true);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: "worktree",
        projectFilePending: true,
      }),
    ).toBe(true);
  });

  it("settles on a forced mode even while the file loads", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        forcedMode: "worktree",
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(true);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        forcedMode: null,
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(false);
  });

  it("stays unsettled only while a consulted file read is pending", () => {
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: true,
      }),
    ).toBe(false);
    expect(
      isDefaultThreadEnvModeSettled({
        explicitMode: undefined,
        projectSetting: null,
        projectFilePending: false,
      }),
    ).toBe(true);
  });
});
