import { MessageId, ThreadId } from "@lecturn/contracts";
import { appReferenceContextRecords } from "@lecturn/shared/appReferences";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { appReferenceLabelsFromFeed, sameAppReferenceLabels } from "./app-reference-chips";

function message(
  id: string,
  labels: ReadonlyArray<{ ref: string; label: string }> | null,
): ThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: "2026-10-25T12:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role: "user",
      text: labels?.map((entry) => entry.ref).join(" ") ?? "",
      attachments: [],
      createdAt: "2026-10-25T12:00:00.000Z",
      updatedAt: "2026-10-25T12:00:00.000Z",
      runId: null,
      streaming: false,
      visibility: "local",
      sourceThreadId: ThreadId.make("thread-1"),
      ...(labels === null
        ? {}
        : { context: { version: 1, records: appReferenceContextRecords(labels) } }),
    },
  };
}

describe("appReferenceLabelsFromFeed", () => {
  it("collects the names every message's chips stored, the latest winning", () => {
    const labels = appReferenceLabelsFromFeed([
      message("a", [
        { ref: "rw:c/fins", label: "Fins" },
        { ref: "rw:c/nose", label: "Nose cone" },
      ]),
      message("b", null),
      message("c", [{ ref: "rw:c/fins", label: "Fin set" }]),
    ]);
    expect([...labels]).toEqual([
      ["rw:c/fins", "Fin set"],
      ["rw:c/nose", "Nose cone"],
    ]);
  });

  it("is empty for a thread whose messages stored no names", () => {
    expect(appReferenceLabelsFromFeed([message("a", null)]).size).toBe(0);
  });
});

describe("sameAppReferenceLabels", () => {
  it("compares names by reference, ignoring order", () => {
    const fins = new Map([
      ["rw:c/fins", "Fins"],
      ["rw:c/nose", "Nose"],
    ]);
    expect(
      sameAppReferenceLabels(
        fins,
        new Map([
          ["rw:c/nose", "Nose"],
          ["rw:c/fins", "Fins"],
        ]),
      ),
    ).toBe(true);
    expect(sameAppReferenceLabels(fins, new Map([["rw:c/fins", "Fins"]]))).toBe(false);
    expect(
      sameAppReferenceLabels(
        fins,
        new Map([
          ["rw:c/fins", "Fin set"],
          ["rw:c/nose", "Nose"],
        ]),
      ),
    ).toBe(false);
  });
});
