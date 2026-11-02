import { describe, expect, it } from "vite-plus/test";
import {
  SquireCardId,
  SquireId,
  type DesktopActivityAction,
  type DesktopActivitySnapshot,
} from "@lecturn/contracts";
import { isPublishedActivityAction, isTrustedActivitySender } from "./policy.ts";

const snapshot: DesktopActivitySnapshot = {
  summary: "1 PR",
  rows: [
    {
      id: "row-1",
      environmentId: "remote",
      projectId: "p",
      threadId: "t",
      watchId: "w",
      title: "PR",
      subtitle: "Branch",
      status: "working",
      actions: [
        { id: "steer", label: "Steer" },
        { id: "merge", label: "Merge", disabled: true },
      ],
    },
  ],
};
const action: DesktopActivityAction = {
  rowId: "row-1",
  environmentId: "remote",
  projectId: "p",
  threadId: "t",
  watchId: "w",
  kind: "steer",
  text: "Fix CI",
};
describe("activity command boundary", () => {
  it("accepts only a currently offered action with the complete published identity", () => {
    expect(isPublishedActivityAction(snapshot, action)).toBe(true);
    for (const change of [
      { environmentId: "local" },
      { projectId: "other" },
      { watchId: "old" },
      { threadId: "other" },
      { rowId: "missing" },
      { text: " " },
      { kind: "merge" as const },
      { kind: "stop-watch" as const },
    ]) {
      expect(isPublishedActivityAction(snapshot, { ...action, ...change })).toBe(false);
    }
    expect(isPublishedActivityAction({ summary: "reconnecting", rows: [] }, action)).toBe(false);
  });
  it("rejects guest contents, subframes, foreign origins, and lookalike protocols", () => {
    const sender = {
      senderId: 1,
      expectedId: 1,
      isMainFrame: true,
      url: "lecturn://app/thread/123",
      expectedUrl: "lecturn://app/",
    };
    expect(isTrustedActivitySender(sender)).toBe(true);
    for (const change of [
      { senderId: 9 },
      { isMainFrame: false },
      { url: "https://app/" },
      { url: "lecturn://evil/" },
      { url: "bad" },
    ]) {
      expect(isTrustedActivitySender({ ...sender, ...change })).toBe(false);
    }
    expect(
      isTrustedActivitySender({
        ...sender,
        url: "data:text/html,evil",
        expectedUrl: "data:text/html,trusted",
      }),
    ).toBe(false);
  });
});

it("rejects actions captured before a watch revision changed", () => {
  const current = { ...snapshot, rows: snapshot.rows.map((row) => ({ ...row, watchRevision: 2 })) };
  expect(isPublishedActivityAction(current, { ...action, watchRevision: 1 })).toBe(false);
  expect(isPublishedActivityAction(current, { ...action, watchRevision: 2 })).toBe(true);
});

it("accepts a Squire action only on a Squire row that offers it", () => {
  const squireRow = {
    id: "squire-row",
    environmentId: "remote",
    projectId: "p",
    threadId: "t",
    title: "Rebase onto main",
    subtitle: "Release",
    status: "Action · Rebase",
    squire: {
      squireId: SquireId.make("squire-1"),
      cardId: SquireCardId.make("card-1"),
      cardKind: "steer" as const,
      palette: "brass" as const,
    },
    actions: [
      { id: "squire-accept" as const, label: "Send steer" },
      { id: "squire-dismiss" as const, label: "Dismiss" },
    ],
  };
  const accept: DesktopActivityAction = {
    rowId: "squire-row",
    environmentId: "remote",
    projectId: "p",
    threadId: "t",
    kind: "squire-accept",
    requestId: "request-1",
  };
  const current = { summary: "Squire", rows: [squireRow] };
  expect(isPublishedActivityAction(current, accept)).toBe(true);
  expect(isPublishedActivityAction(current, { ...accept, kind: "squire-undo" })).toBe(false);
  const { squire: _squire, ...plain } = squireRow;
  expect(isPublishedActivityAction({ summary: "Squire", rows: [plain] }, accept)).toBe(false);
});
