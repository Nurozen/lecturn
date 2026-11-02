import { EnvironmentId, SquireId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseSquireViewSearch, squireViewForThread } from "./squireView.logic";

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

describe("parseSquireViewSearch", () => {
  it("keeps known params and drops the all chip, unknown chips, and empty values", () => {
    expect(parseSquireViewSearch({ item: "card-1", filter: "steer", squire: "release" })).toEqual({
      item: "card-1",
      filter: "steer",
      squire: "release",
    });
    expect(parseSquireViewSearch({ item: "", filter: "all", squire: 3 })).toEqual({});
    expect(parseSquireViewSearch({ filter: "nope" })).toEqual({});
  });
});
