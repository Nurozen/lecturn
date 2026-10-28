import { describe, expect, it } from "@effect/vitest";

import { embedNavigationTarget } from "./embedNavigation";

describe("embed navigation", () => {
  it("keeps threads, folds the app's home and project pages into the project, and drops the rest", () => {
    expect(
      embedNavigationTarget({
        to: "/$environmentId/$threadId",
        params: { environmentId: "env-1", threadId: "thread-2" },
      }),
    ).toEqual({ kind: "thread", threadId: "thread-2" });
    expect(embedNavigationTarget({ to: "/" })).toEqual({ kind: "project" });
    expect(
      embedNavigationTarget({ to: "/projects/$projectKey", params: { projectKey: "k" } }),
    ).toEqual({ kind: "project" });
    expect(embedNavigationTarget({ to: "/draft/$draftId", params: { draftId: "d" } })).toBeNull();
    expect(embedNavigationTarget({ to: "/settings/providers" })).toBeNull();
    expect(embedNavigationTarget({ to: "/$environmentId/$threadId", params: {} })).toBeNull();
  });
});
