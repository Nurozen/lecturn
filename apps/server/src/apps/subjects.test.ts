import { AppId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";

import { formatAppSubject, formatEmbedSubject, parseAppSubject } from "./subjects.ts";

const appId = AppId.make("dev.rocketwright.app");
const projectId = ProjectId.make("project-1");

describe("connected app subjects", () => {
  it("round-trips app and embed subjects", () => {
    expect(formatAppSubject(appId)).toBe("app:dev.rocketwright.app");
    expect(parseAppSubject(formatAppSubject(appId))).toEqual({ kind: "app", appId });
    expect(formatEmbedSubject(appId, projectId)).toBe("embed:dev.rocketwright.app:project-1");
    expect(parseAppSubject(formatEmbedSubject(appId, projectId))).toEqual({
      kind: "embed",
      appId,
      projectId,
    });
  });

  it("keeps everything after the app id as the project id", () => {
    expect(parseAppSubject("embed:dev.rocketwright.app:a:b")).toEqual({
      kind: "embed",
      appId,
      projectId: "a:b",
    });
  });

  it("does not classify ordinary sessions as apps", () => {
    for (const subject of [
      "owner",
      "one-time-token",
      "mcp-client",
      "reusable-dev-token-child",
      "application:dev.rocketwright.app",
      "embedded:dev.rocketwright.app:project-1",
    ]) {
      expect(parseAppSubject(subject)).toBeNull();
    }
  });

  it("refuses malformed app-looking subjects", () => {
    for (const subject of [
      "app:",
      "app:NoDots",
      "app:dev.rocketwright.app:extra",
      "embed:",
      "embed:dev.rocketwright.app",
      "embed:dev.rocketwright.app:",
      "embed:dev.rocketwright.app: project-1",
      "embed:bad id:project-1",
    ]) {
      expect(parseAppSubject(subject)).toBeNull();
    }
  });
});
