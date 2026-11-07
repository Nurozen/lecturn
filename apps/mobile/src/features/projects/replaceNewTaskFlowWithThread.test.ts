import type { NavigationState, ParamListBase } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@react-navigation/native", () => ({
  CommonActions: { reset: (state: unknown) => ({ type: "RESET", payload: state }) },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "new-route" }));

import { replaceNewTaskFlowWithThread } from "./replaceNewTaskFlowWithThread";

const realThread = { name: "Thread", params: { environmentId: "e", threadId: "x" } };
const draft = { name: "Thread", params: { draft: { projectId: "p" } } };
const finished = { threadId: "finished" };

function finish(routes: ReadonlyArray<{ readonly name: string; readonly params?: object }>) {
  const dispatch = vi.fn();
  const state = {
    index: routes.length - 1,
    routes: routes.map((route, index) => ({ key: `route-${index}`, ...route })),
  } as unknown as NavigationState<ParamListBase>;
  replaceNewTaskFlowWithThread({ dispatch, getState: () => state }, finished);
  const { payload } = dispatch.mock.calls[0]![0] as { readonly payload: typeof state };
  expect(payload.index).toBe(payload.routes.length - 1);
  expect(payload.routes.at(-1)).toEqual({ key: "new-route", name: "Thread", params: finished });
  return payload.routes.slice(0, -1).map((route) => route.key);
}

describe("replaceNewTaskFlowWithThread", () => {
  it("keeps a real thread the flow opened from", () => {
    expect(finish([{ name: "Home" }, realThread, { name: "AddProject" }])).toEqual([
      "route-0",
      "route-1",
    ]);
  });

  it("cuts at the draft and every picker above it", () => {
    expect(
      finish([
        { name: "Home" },
        realThread,
        draft,
        { name: "NewTaskProject" },
        { name: "AddProject" },
      ]),
    ).toEqual(["route-0", "route-1"]);
  });

  it("cuts at the first picker when no draft started the flow", () => {
    expect(
      finish([{ name: "Home" }, { name: "NewTaskProject" }, { name: "AddProject" }, { name: "X" }]),
    ).toEqual(["route-0"]);
  });

  it("replaces only the finishing route when the flow has no draft or picker", () => {
    expect(finish([{ name: "Home" }, realThread, { name: "NewTaskImportSession" }])).toEqual([
      "route-0",
      "route-1",
    ]);
  });
});
