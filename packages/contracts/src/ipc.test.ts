import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopActivityActionSchema, DesktopActivityRowSchema } from "./ipc.ts";

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
