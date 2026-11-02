import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopActivityActionSchema,
  DesktopActivityRowSchema,
  DesktopEnvironmentBootstrapSchema,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("Squire notch actions", () => {
  const decodeAction = Schema.decodeUnknownSync(DesktopActivityActionSchema);
  const identity = { rowId: "row-1", environmentId: "env-1", projectId: "project-1" };

  it("requires a requestId on Squire actions and leaves existing actions unchanged", () => {
    expect(decodeAction({ ...identity, kind: "squire-accept", requestId: "r-1" })).toEqual({
      ...identity,
      kind: "squire-accept",
      requestId: "r-1",
    });
    expect(() => decodeAction({ ...identity, kind: "squire-undo" })).toThrow();
    expect(decodeAction({ ...identity, kind: "steer", text: "go" })).toEqual({
      ...identity,
      kind: "steer",
      text: "go",
    });
  });

  it("decodes rows with and without a Squire card", () => {
    const decodeRow = Schema.decodeUnknownSync(DesktopActivityRowSchema);
    const row = {
      id: "row-1",
      environmentId: "env-1",
      projectId: "project-1",
      title: "Ada",
      subtitle: "Squire",
      status: "Waiting",
      actions: [{ id: "squire-accept", label: "Accept" }],
    };
    expect(decodeRow(row)).not.toHaveProperty("squire");
    const squire = { squireId: "s-1", cardId: "c-1", cardKind: "steer", palette: "sage" };
    expect(decodeRow({ ...row, squire }).squire).toEqual(squire);
    expect(() => decodeRow({ ...row, squire: { ...squire, palette: "teal" } })).toThrow();
  });
});
