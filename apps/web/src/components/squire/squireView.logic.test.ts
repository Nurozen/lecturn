import { EnvironmentId, SquireId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { squireViewForThread } from "./squireView.logic";

const environmentId = EnvironmentId.make("env-a");
const squireId = SquireId.make("release");

describe("squireViewForThread", () => {
  it("opens a marked home thread as its Squire view", () => {
    expect(squireViewForThread(environmentId, { squire: { squireId, role: "home" } })).toEqual({
      environmentId,
      squireId,
    });
  });

  it("leaves probes, ordinary threads, and unloaded shells on the thread route", () => {
    expect(squireViewForThread(environmentId, { squire: { squireId, role: "probe" } })).toBeNull();
    expect(squireViewForThread(environmentId, {})).toBeNull();
    expect(squireViewForThread(environmentId, null)).toBeNull();
  });
});
